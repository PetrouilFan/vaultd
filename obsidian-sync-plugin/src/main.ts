import * as Y from 'yjs';
import { Plugin, Notice, TFile, TFolder } from 'obsidian';
import type { SyncSettings, SyncMessage, MessageType } from './types';
import { DEFAULT_SETTINGS, matchesPattern, fileClass, getFileMimeType } from './types';
import { SyncSettingTab } from './settings';
import type { SyncClient } from './sync-client';
import { createSyncClient } from './sync-client';
import type { CRDTManager } from './crdt';
import { createCRDTManager } from './crdt';
import type { BinarySyncManager } from './binary-sync';
import { createBinarySyncManager } from './binary-sync';
import type { OfflineQueue } from './offline-queue';
import { createOfflineQueue } from './offline-queue';
import { ConflictModal } from './conflict-modal';

export default class SyncPlugin extends Plugin {
  private ws!: SyncClient;
  private crdtManager!: CRDTManager;
  private binarySync!: BinarySyncManager;
  private clientId!: string;
  private vectorClock = 0;
  private settings!: SyncSettings;
  private isSyncing = false;
  private offlineQueue!: OfflineQueue;
  private activeFilePath: string | null = null;
  private isSyncingRef!: () => boolean;
  private setSyncing!: (v: boolean) => void;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private pendingChanges: Set<string> = new Set();
  private readonly DEBOUNCE_MS = 300;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.clientId = await this.getClientId();

    // Set up the mutex functions before any component uses them
    this.isSyncingRef = () => this.isSyncing;
    this.setSyncing = (v: boolean) => { this.isSyncing = v; };

    // Initialize offline queue FIRST
    this.offlineQueue = createOfflineQueue();

    // Then restore from localStorage backup (in case IndexedDB was cleared)
    this.offlineQueue.restoreFromLocalStorage();

    this.addSettingTab(new SyncSettingTab(this.app, this));

    // CRITICAL: must be after onLayoutReady on mobile
    this.app.workspace.onLayoutReady(() => this.initSync());
  }

  onunload(): void {
    // Backup queue before unload
    this.offlineQueue?.backupToLocalStorage();
    this.offlineQueue?.clear();
    this.ws?.disconnect();
    this.crdtManager?.destroy();
    this.binarySync?.cleanup();
  }

  // Manual reconnect method
  async reconnect(): Promise<void> {
    new Notice('Attempting to reconnect...');
    this.ws?.forceReconnect();
  }

  private async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = { ...DEFAULT_SETTINGS, ...data };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private async getClientId(): Promise<string> {
    const data = await this.loadData();
    if (data?.clientId) {
      return data.clientId;
    }
    const newId = crypto.randomUUID();
    await this.saveData({ ...data, clientId: newId });
    return newId;
  }

  private async initSync(): Promise<void> {
    this.offlineQueue = createOfflineQueue();

    this.ws = createSyncClient({
      wsUrl: this.settings.serverUrl,
      clientId: this.clientId,
      vaultKey: this.settings.vaultKey,
      settings: this.settings,
    });

    this.crdtManager = createCRDTManager(
      this.app.vault,
      (path, update) => this.onCrdtUpdate(path, update),
      (path, content) => this.onRemoteCrdtUpdate(path, content),
      this.settings.crdtGcInterval
    );

    this.binarySync = createBinarySyncManager({
      vault: this.app.vault,
      sendMessage: (msg) => this.ws.send(msg),
      settings: this.settings,
      baseUrl: this.settings.serverUrl.replace(/^wss?:\/\//, '').replace(/\/$/, ''),
    });

    this.setupEventListeners();
    this.ws.onMessage((message) => this.handleIncomingMessage(message));
    this.ws.onDisconnect(() => {
      new Notice('Disconnected from sync server — offline mode');
      this.updateStatusIndicator();
    });
    this.ws.onConnect(() => {
      new Notice('Tailnet Sync connected');
      this.updateStatusIndicator();
    });

    // Start periodic status update
    setInterval(() => this.updateStatusIndicator(), 5000);

    try {
      console.log('[Vaultd] Attempting to connect to:', this.settings.serverUrl);
      await this.ws.connect();
      console.log('[Vaultd] Connected successfully!');
      new Notice('Tailnet Sync connected');
      this.processOfflineQueue();
    } catch (e) {
      console.error('[Vaultd] Failed to connect to sync server:', e);
      new Notice('Failed to connect to sync server');
    }
  }

  private updateStatusIndicator(): void {
    if (!this.ws) return;
    
    const pending = this.ws.getPendingCount();
    const isConnected = this.ws.isConnected();
    
    console.log(`[Vaultd] Status: ${isConnected ? 'Connected' : 'Offline'}, Pending: ${pending}`);
    
    // Update the offline queue backup
    this.offlineQueue?.backupToLocalStorage();
  }

  private setupEventListeners(): void {
    this.registerEvent(
      this.app.vault.on('modify', (file) => this.onLocalChange(file))
    );
    this.registerEvent(
      this.app.vault.on('create', (file) => this.onLocalChange(file))
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => this.onLocalDelete(file))
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => this.onLocalRename(oldPath, file.path))
    );
    this.registerEvent(
      this.app.vault.on('folder-rename', (folder, oldPath) => this.onLocalFolderRename(oldPath, folder.path))
    );
    this.registerEvent(
      this.app.vault.on('folder-delete', (folder) => this.onLocalFolderDelete(folder.path))
    );
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => this.onActiveLeafChange(leaf))
    );
  }

  private onLocalChange(file: TFile | TFolder): void {
    if (file instanceof TFolder) return;
    if (matchesPattern(file.path, this.settings.excludePatterns)) return;
    if (this.isSyncing) return;
    
    this.pendingChanges.add(file.path);
    
    const existingTimer = this.debounceTimers.get(file.path);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    
    const timer = setTimeout(() => {
      this.debounceTimers.delete(file.path);
      if (this.pendingChanges.has(file.path)) {
        this.pendingChanges.delete(file.path);
        this.processLocalChange(file);
      }
    }, this.DEBOUNCE_MS);
    
    this.debounceTimers.set(file.path, timer);
  }
  
  private processLocalChange(file: TFile | TFolder): void {
    if (file instanceof TFolder) return;
    
    const classification = fileClass(file.path);
    if (classification === 'text') {
      this.handleTextFileChange(file);
    } else {
      this.handleBinaryFileChange(file);
    }
  }

  private async handleTextFileChange(file: TFile): Promise<void> {
    try {
      const content = await this.app.vault.read(file);
      const isNewFile = !this.crdtManager.hasDocument(file.path);
      
      this.crdtManager.updateDocument(file.path, content);
      
      if (isNewFile) {
        this.sendMessage('CREATE', { vault_id: this.getVaultId(), path: file.path, content });
      } else {
        this.onCrdtUpdate(file.path, new Uint8Array());
      }
    } catch (e) {
      console.error('Failed to handle text file change:', e);
    }
  }

  private async handleBinaryFileChange(file: TFile): Promise<void> {
    if (this.settings.maxBinarySize && file.stat.size > this.settings.maxBinarySize) {
      console.log('[SyncPlugin] Skipping binary above max size:', file.path);
      return;
    }
    try {
      await this.binarySync.onVaultFileCreated(file);
    } catch (e) {
      console.error('Failed to handle binary file change:', e);
    }
  }

  private getVaultId(): string {
    return (this.settings.vaultKey || 'default').substring(0, 8);
  }

  private onLocalDelete(file: TFile | TFolder): void {
    if (file instanceof TFolder) return;
    if (matchesPattern(file.path, this.settings.excludePatterns)) return;
    if (this.isSyncing) return;

    this.sendMessage('DELETE', { vault_id: this.getVaultId(), path: file.path });
  }

  private onLocalRename(oldPath: string, newPath: string): void {
    if (matchesPattern(newPath, this.settings.excludePatterns)) return;
    if (this.isSyncing) return;

    this.sendMessage('RENAME', { vault_id: this.getVaultId(), old_path: oldPath, new_path: newPath });
    this.crdtManager.renameDocument(oldPath, newPath);
  }

  private onLocalFolderRename(oldPath: string, newPath: string): void {
    if (matchesPattern(newPath, this.settings.excludePatterns)) return;
    if (this.isSyncing) return;

    console.log('[SyncPlugin] Folder renamed:', oldPath, '->', newPath);
    this.sendMessage('RENAME', { vault_id: this.getVaultId(), old_path: oldPath, new_path: newPath });
  }

  private onLocalFolderDelete(path: string): void {
    if (matchesPattern(path, this.settings.excludePatterns)) return;
    if (this.isSyncing) return;

    console.log('[SyncPlugin] Folder deleted:', path);
    this.sendMessage('DELETE', { vault_id: this.getVaultId(), path });
  }

  private onActiveLeafChange(leaf: any): void {
    const newPath = leaf?.view?.file?.path;
    if (!newPath) return;

    if (this.activeFilePath && this.activeFilePath !== newPath) {
      this.crdtManager.onFileClose(this.activeFilePath);
    }

    this.activeFilePath = newPath;
    this.crdtManager.onFileOpen(newPath);
  }

  private onCrdtUpdate(path: string, _update: Uint8Array): void {
    const binding = this.crdtManager.getDocument(path);
    if (!binding) return;
    
    const stateVector = Y.encodeStateVector(binding);
    const updateBytes = Y.encodeStateAsUpdate(binding, stateVector);
    if (updateBytes.length > 0) {
      this.sendMessage('UPDATE', { 
        vault_id: this.getVaultId(),
        path, 
        update: Array.from(updateBytes),
        state_vector: Array.from(stateVector),
        isText: true
      });
    }
  }

  private onRemoteCrdtUpdate(path: string, content: string): void {
    if (this.isSyncing) return;
    this.isSyncing = true;
    try {
      this.syncRemoteContent(path);
    } finally {
      this.isSyncing = false;
    }
  }

  private handleIncomingMessage(message: SyncMessage): void {
    console.log('[Vaultd] handleIncomingMessage:', message.type, 'from:', message.client_id);
    
    // Ignore own messages
    if (message.client_id === this.clientId) return;

    switch (message.type) {
      case 'UPDATE':
        this.handleRemoteUpdate(message);
        break;
      case 'CREATE':
        this.handleRemoteCreate(message);
        break;
      case 'RENAME':
        this.handleRemoteRename(message);
        break;
      case 'DELETE':
        this.handleRemoteDelete(message);
        break;
      case 'BINARY_CHUNK':
        this.binarySync.handleBinaryChunkMessage(message);
        break;
      case 'CONFLICT':
        this.showConflictModal(message);
        break;
      case 'ACK':
        this.handleAck(message);
        break;
    }
  }

private async handleRemoteUpdate(message: SyncMessage): Promise<void> {
    console.log('[Vaultd] handleRemoteUpdate called!');
    const payload = message.payload as any;
    const path = payload.path as string;
    console.log('[Vaultd] Remote update for:', path);

    if (this.isSyncing) return;
    
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFolder) {
      console.log('[Vaultd] Ignoring folder update:', path);
      return;
    }
    
    if (!file && !payload.isCreate) {
      console.log('[Vaultd] File does not exist and not a create - skipping:', path);
      return;
    }
    
    this.isSyncing = true;

    try {
      // Check if this is a CRDT update (has update array)
      if (payload.update && Array.isArray(payload.update)) {
        console.log('[Vaultd] CRDT update, size:', payload.update.length);
        const updateBytes = new Uint8Array(payload.update);
        
        // Initialize CRDT doc if doesn't exist
        if (!this.crdtManager.hasDocument(path)) {
          // Read current local content to initialize CRDT
          let localContent = '';
          if (file instanceof TFile) {
            try {
              localContent = await this.app.vault.read(file);
            } catch (e) {}
          }
          this.crdtManager.updateDocument(path, localContent);
        }
        
        // Apply the CRDT update
        this.crdtManager.applyRemoteUpdate(path, updateBytes);
        
        // Get merged content and write
        const content = this.crdtManager.getDocumentString(path);
        if (content !== null) {
          await this.writeRemoteContent(path, content);
        }
      } 
      // If there's plain content without CRDT update, use CRDT to merge
      else if (payload.content !== undefined) {
        console.log('[Vaultd] Plain text update, using CRDT merge:', payload.content.substring(0, 50));
        const remoteContent = payload.content as string;
        
        // Initialize CRDT doc if doesn't exist
        if (!this.crdtManager.hasDocument(path)) {
          let localContent = '';
          if (file instanceof TFile) {
            try {
              localContent = await this.app.vault.read(file);
            } catch (e) {}
          }
          this.crdtManager.updateDocument(path, localContent);
        }
        
        // Use CRDT to apply remote content (creates a full doc update)
        const remoteDoc = new Y.Doc();
        const ytext = remoteDoc.getText('content');
        ytext.insert(0, remoteContent);
        const updateBytes = Y.encodeStateAsUpdate(remoteDoc);
        
        // Apply to local CRDT doc
        if (this.crdtManager.hasDocument(path)) {
          this.crdtManager.applyRemoteUpdate(path, updateBytes);
        } else {
          this.crdtManager.updateDocument(path, remoteContent);
        }
        
        // Get merged content and write
        const content = this.crdtManager.getDocumentString(path);
        if (content !== null) {
          await this.writeRemoteContent(path, content);
        }
      } else {
        console.log('[Vaultd] No update data found!');
      }
    } finally {
      this.isSyncing = false;
    }
  }

  private async writeRemoteContent(path: string, content: string): Promise<void> {
    this.isSyncing = true;
    try {
      let file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        await this.app.vault.modify(file, content);
      } else {
        // File doesn't exist - create it
        console.log('[Vaultd] Creating new file:', path);
        await this.app.vault.create(path, content);
        console.log('[Vaultd] Created file:', path);
      }
    } catch (e) {
      console.error('[Vaultd] Failed to write remote content:', e);
      new Notice('Failed to sync: ' + path);
    } finally {
      this.isSyncing = false;
    }
  }

  private async syncRemoteContent(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;

    try {
      const content = await this.app.vault.read(file);
      this.sendMessage('UPDATE', { vault_id: this.getVaultId(), path, content });
    } catch (e) {
      console.error('Failed to get local content for sync:', e);
    }
  }

  private async handleRemoteCreate(message: SyncMessage): Promise<void> {
    const payload = message.payload as any;
    const path = payload.path as string;
    const content = payload.content as string || '';

    if (this.isSyncing) return;
    this.isSyncing = true;

    try {
      const existingFile = this.app.vault.getAbstractFileByPath(path);
      if (existingFile instanceof TFile) {
        console.log('[Vaultd] File already exists, merging with CRDT:', path);
        // File exists - use CRDT to merge remote content with local
        if (!this.crdtManager.hasDocument(path)) {
          const localContent = await this.app.vault.read(existingFile);
          this.crdtManager.updateDocument(path, localContent);
        }
        // Create CRDT update from remote content
        const remoteDoc = new Y.Doc();
        const ytext = remoteDoc.getText('content');
        ytext.insert(0, content);
        const updateBytes = Y.encodeStateAsUpdate(remoteDoc);
        this.crdtManager.applyRemoteUpdate(path, updateBytes);
        const mergedContent = this.crdtManager.getDocumentString(path);
        if (mergedContent !== null) {
          await this.writeRemoteContent(path, mergedContent);
        }
      } else {
        console.log('[Vaultd] Creating new file:', path);
        await this.app.vault.create(path, content);
        this.crdtManager.updateDocument(path, content);
      }
    } catch (e) {
      console.error('[Vaultd] Failed to handle remote create:', e);
    } finally {
      this.isSyncing = false;
    }
  }

  private handleRemoteRename(message: SyncMessage): void {
    const payload = message.payload as any;
    const oldPath = payload.old_path as string;
    const newPath = payload.new_path as string;

    if (this.isSyncing) return;
    this.isSyncing = true;

    try {
      const file = this.app.vault.getAbstractFileByPath(oldPath);
      if (file instanceof TFile) {
        this.app.vault.rename(file, newPath);
      } else {
        console.log('[Vaultd] File not found for rename, may have been deleted:', oldPath);
      }
      if (this.crdtManager.hasDocument(oldPath)) {
        this.crdtManager.renameDocument(oldPath, newPath);
      }
    } catch (e) {
      console.error('Failed to handle remote rename:', e);
    } finally {
      this.isSyncing = false;
    }
  }

  private handleRemoteDelete(message: SyncMessage): void {
    const payload = message.payload as any;
    const path = payload.path as string;

    if (this.isSyncing) return;
    this.isSyncing = true;

    try {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file) {
        this.app.vault.delete(file);
      } else {
        console.log('[Vaultd] File already deleted, skipping:', path);
      }
      this.crdtManager.destroyDocumentBinding(path);
    } catch (e) {
      console.error('Failed to handle remote delete:', e);
    } finally {
      this.isSyncing = false;
    }
  }

  private handleAck(message: SyncMessage): void {
    this.vectorClock = Math.max(this.vectorClock, message.vector_clock);
  }

  private sendMessage(type: MessageType, payload: Record<string, unknown>): void {
    this.vectorClock++;
    const message: SyncMessage = {
      type,
      client_id: this.clientId,
      vault_key: this.settings.vaultKey,
      vector_clock: this.vectorClock,
      payload,
    };

    if (this.ws.isConnected()) {
      this.ws.send(message);
    } else {
      this.offlineQueue.enqueue(message);
    }
  }

  private async processOfflineQueue(): Promise<void> {
    while (!this.offlineQueue.isEmpty()) {
      const queued = this.offlineQueue.peek();
      if (!queued) break;

      try {
        this.ws.send(queued.message);
        this.offlineQueue.dequeue();
      } catch {
        const dropped = this.offlineQueue.incrementRetries();
        if (dropped) {
          new Notice('Failed to sync some changes after multiple retries');
        }
        break;
      }
    }
  }

  private showConflictModal(message: SyncMessage): void {
    const payload = message.payload as any;

    new ConflictModal(this.app, {
      path: payload.path,
      localContent: payload.localContent || '',
      remoteContent: payload.remoteContent || '',
      onResolve: async (resolution) => {
        await this.resolveConflict(payload.path, resolution);
      },
    }).open();
  }

  private async resolveConflict(
    path: string,
    resolution: 'local' | 'remote' | 'both'
  ): Promise<void> {
    if (resolution === 'local') {
      await this.syncRemoteContent(path);
    } else if (resolution === 'both') {
      const ext = path.split('.').pop() || '';
      const baseName = path.replace(/\.[^.]+$/, '');
      const date = new Date().toISOString().split('T')[0];
      const newPath = `${baseName}.conflicted-${date}.${ext}`;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        const remoteContent = ''; // The conflict modal will have already saved this
        await this.app.vault.create(newPath, remoteContent);
      }
    }

    this.sendMessage('RESOLVE', { path, resolution });
    new Notice(`Conflict resolved: ${resolution}`);
  }
}