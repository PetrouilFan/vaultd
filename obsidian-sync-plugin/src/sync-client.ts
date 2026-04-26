import type { SyncMessage, VectorClock, ClientInfo, SyncSettings } from './types';

export interface SyncClientConfig {
  wsUrl: string;
  clientId: string;
  vaultKey: string;
  settings: SyncSettings;
}

export type MessageCallback = (message: SyncMessage) => void;
export type ConnectCallback = () => void;
export type DisconnectCallback = (reason: string) => void;

export class SyncClient {
  private ws: WebSocket | null = null;
  private wsUrl: string;
  private clientId: string;
  private vaultKey: string;
  private settings: SyncSettings;

  private localClock = 0;
  private remoteClock: number = 0;
  private lastSequence: number = 0;

  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private connectionTimeout: number | null = null;
  private pingInterval: number | null = null;

  private _isConnected = false;
  private messageQueue: SyncMessage[] = [];

  private messageCallbacks: Set<MessageCallback> = new Set();
  private connectCallbacks: Set<ConnectCallback> = new Set();
  private disconnectCallbacks: Set<DisconnectCallback> = new Set();

  private db: IDBDatabase | null = null;
  private dbReady: Promise<void>;

  constructor(config: SyncClientConfig) {
    this.wsUrl = config.wsUrl;
    this.clientId = config.clientId;
    this.vaultKey = config.vaultKey;
    this.settings = config.settings;
    this.dbReady = this.initIndexedDB();
  }

  private async initIndexedDB(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('ObsidianSyncOffline', 1);

      request.onerror = () => reject(request.error);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        this.createObjectStores(db);
      };

      request.onsuccess = () => {
        const db = request.result;
        // Check if stores exist (might have old version without stores)
        if (!db.objectStoreNames.contains('operations') || !db.objectStoreNames.contains('state')) {
          // Need to upgrade - this is a bit of a hack but works
          const upgradeReq = indexedDB.deleteDatabase('ObsidianSyncOffline');
          upgradeReq.onsuccess = () => {
            const newReq = indexedDB.open('ObsidianSyncOffline', 1);
            newReq.onupgradeneeded = (event) => {
              this.createObjectStores((event.target as IDBOpenDBRequest).result);
            };
            newReq.onsuccess = () => {
              this.db = newReq.result;
              resolve();
            };
            newReq.onerror = () => reject(newReq.error);
          };
          upgradeReq.onerror = () => reject(upgradeReq.error);
          return;
        }
        this.db = db;
        resolve();
      };
    });
  }

  private createObjectStores(db: IDBDatabase): void {
    if (!db.objectStoreNames.contains('operations')) {
      const store = db.createObjectStore('operations', {
        keyPath: 'id',
        autoIncrement: true,
      });
      store.createIndex('timestamp', 'timestamp', { unique: false });
      store.createIndex('path', 'path', { unique: false });
    }
    if (!db.objectStoreNames.contains('state')) {
      db.createObjectStore('state', { keyPath: 'key' });
    }
  }

  isConnected(): boolean {
    return this._isConnected;
  }

  async connect(): Promise<void> {
    console.log('[SyncClient] Starting connect (skipping DB)...');
    // Skip DB init to avoid IndexedDB hangs

    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      console.log('[SyncClient] Already connected');
      return;
    }

    this.incrementClock();
    this.startConnectionTimeout();
    
    console.log('[SyncClient] Creating WebSocket:', this.wsUrl);

    try {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = this.handleOpen.bind(this);
      this.ws.onmessage = this.handleMessage.bind(this);
      this.ws.onerror = this.handleError.bind(this);
      this.ws.onclose = this.handleClose.bind(this);
      console.log('[SyncClient] WebSocket created, waiting for open...');
    } catch (error) {
      console.error('[SyncClient] WebSocket creation error:', error);
      this.scheduleReconnect();
      throw error;
    }
  }

  disconnect(): void {
    this.clearReconnectTimer();
    this.clearConnectionTimeout();

    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;

      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, 'Client disconnect');
      }
      this.ws = null;
    }

    this._isConnected = false;
  }

  send(message: SyncMessage): void {
    if (!this._isConnected || this.ws?.readyState !== WebSocket.OPEN) {
      this.queueOfflineOperation(message);
      return;
    }

    this.incrementClock();
    const envelope: SyncMessage = {
      ...message,
      client_id: this.clientId,
      vault_key: this.vaultKey,
      vector_clock: this.localClock,
    };

    this.sendEnvelope(envelope);
  }

  onMessage(callback: MessageCallback): () => void {
    this.messageCallbacks.add(callback);
    return () => this.messageCallbacks.delete(callback);
  }

  onConnect(callback: ConnectCallback): () => void {
    this.connectCallbacks.add(callback);
    return () => this.connectCallbacks.delete(callback);
  }

  onDisconnect(callback: DisconnectCallback): () => void {
    this.disconnectCallbacks.add(callback);
    return () => this.disconnectCallbacks.delete(callback);
  }

  getClientId(): string {
    return this.clientId;
  }

  private incrementClock(): void {
    this.localClock++;
  }

  private sendEnvelope(envelope: SyncMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      const json = JSON.stringify(envelope);
      this.ws.send(json);
    } catch (error) {
      console.error('[SyncClient] Send error:', error);
      this.queueOfflineOperation(envelope);
    }
  }

  private handleOpen(): void {
    console.log('[SyncClient] WebSocket connected');
    this.clearConnectionTimeout();

    this.reconnectAttempts = 0;
    this._isConnected = true;

    this.sendHandshake();
    
    // Handle async rejection properly 
    this.replayOfflineOperations().catch((e) => {
      console.warn('[SyncClient] Offline replay skipped:', e);
    });

    // Keep connection alive with periodic pings every 10 seconds
    this.pingInterval = window.setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        console.log('[SyncClient] Sending ping');
        this.ws.send('{"type":"PING"}');
      }
    }, 10000);

    this.connectCallbacks.forEach((cb) => cb());
  }

  private handleMessage(event: MessageEvent): void {
    try {
      const data = event.data;
      
      // Handle both string and Blob types
      const processData = (text: string) => {
        console.log('[SyncClient] Raw message received, length:', text.length);
        
        const message: SyncMessage = JSON.parse(text);
        console.log('[SyncClient] Parsed message:', message.type, 'from:', message.client_id, 'self:', this.clientId);

        if (message.client_id === this.clientId) {
          console.log('[SyncClient] Ignoring own message');
          return;
        }

        if (message.vector_clock > this.remoteClock) {
          this.remoteClock = message.vector_clock;
        }

        console.log('[SyncClient] Invoking callbacks for:', message.type);
        this.messageCallbacks.forEach((cb) => cb(message));
      };
      
      if (data instanceof Blob) {
        data.text().then(processData).catch((err) => {
          console.error('[SyncClient] Failed to read Blob:', err);
        });
      } else {
        processData(data);
      }
    } catch (err) {
      console.error('[SyncClient] Message parse error:', err);
    }
  }

  private handleError(event: Event): void {
    console.error('[SyncClient] WebSocket error:', event);
  }

  private handleClose(event: CloseEvent): void {
    console.log('[SyncClient] WebSocket closed:', event.code, event.reason);
    this._isConnected = false;
    
    // Clear ping interval
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    
    this.ws = null;

    const reason = event.reason || `Code ${event.code}`;
    this.disconnectCallbacks.forEach((cb) => cb(reason));

    if (event.code !== 1000) {
      this.scheduleReconnect();
    }
  }

  private sendHandshake(): void {
    const handshake: SyncMessage = {
      type: 'HANDSHAKE',
      client_id: this.clientId,
      vault_key: this.vaultKey,
      vector_clock: this.localClock,
      payload: {
        client_info: this.getClientInfo(),
        device_name: this.settings.deviceName,
        last_seq: this.lastSequence,
      },
    };

    this.sendEnvelope(handshake);
  }

  private getClientInfo(): ClientInfo {
    return {
      platform: /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'mobile' : 'desktop',
      version: '1.0.0',
      timestamp: Date.now(),
      deviceName: this.settings.deviceName,
    };
  }

  private async replayOfflineOperations(): Promise<void> {
    if (!this.db) {
      console.log('[SyncClient] No DB, skipping offline replay');
      return;
    }
    
    console.log('[SyncClient] Replaying offline operations...');
    
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('operations', 'readwrite');
      const store = tx.objectStore('operations');
      const request = store.getAll();
      
      request.onsuccess = () => {
        const ops = request.result;
        console.log('[SyncClient] Found offline operations:', ops.length);
        
        if (ops.length === 0) {
          resolve();
          return;
        }
        
        ops.forEach((op: any) => {
          try {
            const msg = JSON.parse(op.data);
            console.log('[SyncClient] Replaying:', msg.type, op.path);
            this.sendEnvelope(msg);
          } catch (e) {
            console.error('[SyncClient] Failed to parse offline op:', e);
          }
        });
        
        const delTx = this.db!.transaction('operations', 'readwrite');
        delTx.objectStore('operations').clear();
        resolve();
      };
      
      request.onerror = () => {
        console.error('[SyncClient] Failed to get offline ops');
        resolve();
      };
    });
  }

  private queueOfflineOperation(message: SyncMessage): void {
    this.storeOperation(message);
  }

  private async storeOperation(message: SyncMessage): Promise<void> {
    if (!this.db) return;

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('operations', 'readwrite');
      const store = tx.objectStore('operations');
      const request = store.add({
        type: message.type,
        path: (message.payload as any)?.path,
        data: JSON.stringify(message),
        timestamp: Date.now(),
      });

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  private async getStoredOperations(): Promise<Array<{ id: number; data: string; timestamp: number }>> {
    if (!this.db) return [];
    
    try {
      return new Promise((resolve, reject) => {
        const tx = this.db!.transaction('operations', 'readonly');
        const store = tx.objectStore('operations');
        const index = store.index('timestamp');
        const request = index.getAll();

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve([]); // Return empty on error
      });
    } catch {
      return [];
    }
  }

  private async clearStoredOperations(): Promise<void> {
    if (!this.db) return;

    try {
      return new Promise((resolve, reject) => {
        const tx = this.db!.transaction('operations', 'readwrite');
        const store = tx.objectStore('operations');
        const request = store.clear();

        request.onsuccess = () => resolve();
        request.onerror = () => resolve(); // Resolve on error
      });
    } catch {
      return;
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();

    const maxReconnectAttempts = 10;
    const baseDelay = 1000;
    const maxDelay = 60000;
    const delay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempts), maxDelay);

    if (this.reconnectAttempts >= maxReconnectAttempts) {
      console.error(`[SyncClient] Max reconnect attempts (${maxReconnectAttempts}) reached. Giving up.`);
      this._isConnected = false;
      this.disconnectCallbacks.forEach((cb) => cb('max attempts reached'));
      return;
    }

    console.log(`[SyncClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1}/${maxReconnectAttempts})`);

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectAttempts++;
      this.connect().catch((err) => {
        console.error('[SyncClient] Reconnect failed:', err);
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startConnectionTimeout(): void {
    this.clearConnectionTimeout();
    const timeout = 30000;

    this.connectionTimeout = window.setTimeout(() => {
      if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
        console.warn('[SyncClient] Connection timeout, closing');
        this.ws.close(4000, 'Connection timeout');
      }
    }, timeout);
  }

  private clearConnectionTimeout(): void {
    if (this.connectionTimeout !== null) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
  }

  destroy(): void {
    this.disconnect();
    this.messageCallbacks.clear();
    this.connectCallbacks.clear();
    this.disconnectCallbacks.clear();

    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

export function createSyncClient(config: SyncClientConfig): SyncClient {
  return new SyncClient(config);
}