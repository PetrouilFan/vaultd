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

  async onload(): Promise<void> {
    await this.loadSettings();
    this.clientId = await this.getClientId();

    // Set up the mutex functions before any component uses them
    this.isSyncingRef = () => this.isSyncing;
    this.setSyncing = (v: boolean) => { this.isSyncing = v; };

    this.addSettingTab(new SyncSettingTab(this.app, this));

    // CRITICAL: must be after onLayoutReady on mobile
    this.app.workspace.onLayoutReady(() => this.initSync());
  }

  onunload(): void {
    this.ws?.disconnect();
    this.crdtManager?.destroy();
    this.binarySync?.cleanup();
    this.offlineQueue?.clear();
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
    });

    try {
      await this.ws.connect();
      new Notice('Tailnet Sync connected');
      this.processOfflineQueue();
    } catch (e) {
      console.error('Failed to connect to sync server:', e);
      new Notice('Failed to connect to sync server');
    }
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
      this.app.workspace.on('active-leaf-change', (leaf) => this.onActiveLeafChange(leaf))
    );
  }

  private onLocalChange(file: TFile | TFolder): void {
    if (file instanceof TFolder) return;
    if (matchesPattern(file.path, this.settings.excludePatterns)) return;
    if (this.isSyncing) return;

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
      // Update the local CRDT doc with the new content
      this.crdtManager.updateDocument(file.path, content);
      // Send the CRDT update to other clients
      this.onCrdtUpdate(file.path, new Uint8Array()); // triggers send in crdt manager
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

  private onLocalDelete(file: TFile | TFolder): void {
    if (file instanceof TFolder) return;
    if (matchesPattern(file.path, this.settings.excludePatterns)) return;
    if (this.isSyncing) return;

    this.sendMessage('DELETE', { path: file.path });
  }

  private onLocalRename(oldPath: string, newPath: string): void {
    if (matchesPattern(newPath, this.settings.excludePatterns)) return;
    if (this.isSyncing) return;

    this.sendMessage('RENAME', { old_path: oldPath, new_path: newPath });
    this.crdtManager.renameDocument(oldPath, newPath);
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
    
    // Encode the entire doc state as update and send
    const updateBytes = Y.encodeStateAsUpdate(binding);
    if (updateBytes.length > 0) {
      this.sendMessage('UPDATE', { 
        path, 
        update: Array.from(updateBytes),
        isText: true
      });
    }
  }

  private onRemoteCrdtUpdate(path: string, content: string): void {
    // CRDT manager already applied the content, now request sync back
    this.syncRemoteContent(path);
  }

  private handleIncomingMessage(message: SyncMessage): void {
    // Ignore own messages
    if (message.client_id === this.clientId) return;

    switch (message.type) {
      case 'UPDATE':
        this.handleRemoteUpdate(message);
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

  private handleRemoteUpdate(message: SyncMessage): void {
    const payload = message.payload as any;
    const path = payload.path as string;

    if (this.isSyncing) return;
    this.isSyncing = true;

    try {
      if (payload.isBinary) {
        this.binarySync.downloadBinary(payload.hash as string, path);
      } else if (payload.update && Array.isArray(payload.update)) {
        // Yjs binary update
        const updateBytes = new Uint8Array(payload.update);
        if (this.crdtManager.hasDocument(path)) {
          this.crdtManager.applyRemoteUpdate(path, updateBytes);
        } else {
          // Create new doc from update
          const doc = new Y.Doc();
          Y.applyUpdate(doc, updateBytes, 'remote');
          const content = doc.getText('content').toString();
          this.crdtManager.updateDocument(path, content);
        }
      } else if (payload.content !== undefined) {
        // Plain text content
        const remoteContent = payload.content as string;
        if (this.crdtManager.hasDocument(path)) {
          this.crdtManager.applyRemoteContent(path, remoteContent);
        }
        this.writeRemoteContent(path, remoteContent);
      }
    } finally {
      this.isSyncing = false;
    }
  }

  private async writeRemoteContent(path: string, content: string): Promise<void> {
    try {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        await this.app.vault.modify(file, content);
      }
    } catch (e) {
      console.error('Failed to write remote content:', e);
    }
  }

  private async syncRemoteContent(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;

    try {
      const content = await this.app.vault.read(file);
      this.sendMessage('UPDATE', { path, content });
    } catch (e) {
      console.error('Failed to get local content for sync:', e);
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
        this.app.vault.rename(file, newPath); // Obsidian updates wikilinks automatically
      }
      this.crdtManager.renameDocument(oldPath, newPath);
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