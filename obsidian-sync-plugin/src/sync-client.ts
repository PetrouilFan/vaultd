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

  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private connectionTimeout: number | null = null;

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
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
    });
  }

  isConnected(): boolean {
    return this._isConnected;
  }

  async connect(): Promise<void> {
    await this.dbReady;

    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.incrementClock();
    this.startConnectionTimeout();

    try {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = this.handleOpen.bind(this);
      this.ws.onmessage = this.handleMessage.bind(this);
      this.ws.onerror = this.handleError.bind(this);
      this.ws.onclose = this.handleClose.bind(this);
    } catch (error) {
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
    this.replayOfflineOperations();

    this.connectCallbacks.forEach((cb) => cb());
  }

  private handleMessage(event: MessageEvent): void {
    try {
      const message: SyncMessage = JSON.parse(event.data);

      // Ignore own echoed messages
      if (message.client_id === this.clientId) {
        return;
      }

      // Track remote clock
      if (message.vector_clock > this.remoteClock) {
        this.remoteClock = message.vector_clock;
      }

      this.messageCallbacks.forEach((cb) => cb(message));
    } catch (error) {
      console.error('[SyncClient] Message parse error:', error);
    }
  }

  private handleError(event: Event): void {
    console.error('[SyncClient] WebSocket error:', event);
  }

  private handleClose(event: CloseEvent): void {
    console.log('[SyncClient] WebSocket closed:', event.code, event.reason);
    this._isConnected = false;
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
    if (!this.db) return;

    const ops = await this.getStoredOperations();

    for (const op of ops) {
      const message: SyncMessage = JSON.parse(op.data);
      this.incrementClock();
      this.sendEnvelope({ ...message, vector_clock: this.localClock });
    }

    if (ops.length > 0) {
      await this.clearStoredOperations();
    }
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

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('operations', 'readonly');
      const store = tx.objectStore('operations');
      const index = store.index('timestamp');
      const request = index.getAll();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private async clearStoredOperations(): Promise<void> {
    if (!this.db) return;

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('operations', 'readwrite');
      const store = tx.objectStore('operations');
      const request = store.clear();

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();

    const baseDelay = 1000;
    const maxDelay = 60000;
    const delay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempts), maxDelay);

    console.log(`[SyncClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);

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