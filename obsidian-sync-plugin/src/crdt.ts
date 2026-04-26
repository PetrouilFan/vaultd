import * as Y from 'yjs';
import { Vault, TFile } from 'obsidian';

export interface CRDTManagerConfig {
  vault: Vault;
  onSendUpdate: (path: string, update: Uint8Array) => void;
  onRemoteUpdate: (path: string, content: string) => void;
  gcInterval?: number;
}

interface FileBinding {
  doc: Y.Doc;
  path: string;
  isOpen: boolean;
  lastFlushTime: number;
  updateHandler: (update: Uint8Array, origin: any) => void;
}

export class CRDTManager {
  private vault: Vault;
  private onSendUpdate: (path: string, update: Uint8Array) => void;
  private onRemoteUpdate: (path: string, update: Uint8Array) => void;
  private docs: Map<string, FileBinding> = new Map();
  private gcTimer: ReturnType<typeof setInterval> | null = null;
  private gcInterval: number;

  constructor(config: CRDTManagerConfig) {
    this.vault = config.vault;
    this.onSendUpdate = config.onSendUpdate;
    this.onRemoteUpdate = config.onRemoteUpdate;
    this.gcInterval = config.gcInterval ?? 24 * 60 * 60 * 1000;
    this.startPeriodicGC();
  }

  onFileOpen(path: string): Y.Doc {
    let binding = this.docs.get(path);
    if (binding) {
      binding.isOpen = true;
      return binding.doc;
    }

    const doc = new Y.Doc();
    doc.gc = true;

    const updateHandler = (update: Uint8Array, origin: any) => {
      if (origin === 'remote') return;
      this.onSendUpdate(path, update);
    };

    doc.on('update', updateHandler);

    binding = {
      doc,
      path,
      isOpen: true,
      lastFlushTime: Date.now(),
      updateHandler,
    };

    this.docs.set(path, binding);
    this.loadInitialContent(path, doc);
    return doc;
  }

  private async loadInitialContent(path: string, doc: Y.Doc): Promise<void> {
    try {
      const file = this.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        const content = await this.vault.read(file);
        doc.transact(() => {
          const ytext = doc.getText('content');
          ytext.delete(0, ytext.length);
          ytext.insert(0, content);
        }, 'local');
      }
    } catch (err) {
      if (!(err as Error).message?.includes('File not found')) {
        console.error('[CRDT] Error loading initial content for', path, err);
      }
    }
  }

  async onFileClose(path: string): Promise<void> {
    const binding = this.docs.get(path);
    if (!binding) return;

    binding.isOpen = false;
    await this.flushToDisk(path);
  }

  async flushToDisk(path: string): Promise<void> {
    const binding = this.docs.get(path);
    if (!binding) return;

    try {
      const content = this.getDocumentContent(binding.doc);
      const file = this.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        await this.vault.modify(file, content);
      }
      binding.lastFlushTime = Date.now();
    } catch (err) {
      console.error('[CRDT] Error flushing to disk', path, err);
    }
  }

  getDocumentContent(doc: Y.Doc): string {
    return doc.getText('content').toString();
  }

  getDocumentString(path: string): string | null {
    const binding = this.docs.get(path);
    if (!binding) return null;
    return this.getDocumentContent(binding.doc);
  }

  updateDocument(path: string, content: string): void {
    let binding = this.docs.get(path);
    if (!binding) {
      const doc = new Y.Doc();
      doc.gc = true;
      const updateHandler = (update: Uint8Array, origin: any) => {
        if (origin === 'remote') return;
        this.onSendUpdate(path, update);
      };
      doc.on('update', updateHandler);
      binding = {
        doc,
        path,
        isOpen: false,
        lastFlushTime: Date.now(),
        updateHandler,
      };
      this.docs.set(path, binding);
    }

    binding.doc.transact(() => {
      const ytext = binding!.doc.getText('content');
      ytext.delete(0, ytext.length);
      ytext.insert(0, content);
    }, 'local');
  }

  applyRemoteContent(path: string, content: string): void {
    let binding = this.docs.get(path);
    if (!binding) {
      // No local doc, just create one with remote content
      this.updateDocument(path, content);
      return;
    }

    // Simple last-write-wins for now
    binding.doc.transact(() => {
      const ytext = binding!.doc.getText('content');
      ytext.delete(0, ytext.length);
      ytext.insert(0, content);
    }, 'remote');
  }

  applyRemoteUpdate(path: string, update: Uint8Array): void {
    const binding = this.docs.get(path);
    if (!binding) return;

    Y.applyUpdate(binding.doc, update, 'remote');
    
    if (!binding.isOpen) {
      this.flushToDisk(path).catch((err) =>
        console.error('[CRDT] Failed to flush after remote update', path, err)
      );
    }
  }

  hasDocument(path: string): boolean {
    return this.docs.has(path);
  }

  getDocument(path: string): Y.Doc | null {
    return this.docs.get(path)?.doc ?? null;
  }

  renameDocument(oldPath: string, newPath: string): void {
    const binding = this.docs.get(oldPath);
    if (!binding) return;

    const doc = binding.doc;
    doc.off('update', binding.updateHandler);
    this.docs.delete(oldPath);

    const newBinding: FileBinding = {
      ...binding,
      path: newPath,
      updateHandler: (update, origin) => {
        if (origin === 'remote') return;
        this.onSendUpdate(newPath, update);
      },
    };
    newBinding.doc.on('update', newBinding.updateHandler);
    this.docs.set(newPath, newBinding);
  }

  destroyDocumentBinding(path: string): void {
    const binding = this.docs.get(path);
    if (!binding) return;
    binding.doc.off('update', binding.updateHandler);
    binding.doc.destroy();
    this.docs.delete(path);
  }

  private startPeriodicGC(): void {
    if (this.gcInterval <= 0) return;
    this.gcTimer = setInterval(() => {
      this.performGC();
    }, this.gcInterval);
  }

  private performGC(): void {
    for (const [path, binding] of this.docs.entries()) {
      if (binding.isOpen) continue;

      try {
        const snapshot = Y.encodeStateAsUpdate(binding.doc);
        const newDoc = new Y.Doc();
        newDoc.gc = true;
        Y.applyUpdate(newDoc, snapshot);
        binding.doc.destroy();
        binding.doc = newDoc;
        binding.doc.on('update', binding.updateHandler);
      } catch (err) {
        console.error('[CRDT] GC error for', path, err);
      }
    }
  }

  async destroy(): Promise<void> {
    if (this.gcTimer) clearInterval(this.gcTimer);
    const closePromises: Promise<void>[] = [];
    for (const path of this.docs.keys()) {
      closePromises.push(this.evictFromMemory(path));
    }
    await Promise.all(closePromises);
    this.docs.clear();
  }

  private async evictFromMemory(path: string): Promise<void> {
    const binding = this.docs.get(path);
    if (!binding) return;
    if (!binding.isOpen) {
      await this.flushToDisk(path);
    }
    binding.doc.off('update', binding.updateHandler);
    binding.doc.destroy();
    this.docs.delete(path);
  }
}

export function createCRDTManager(
  vault: Vault,
  onSendUpdate: (path: string, update: Uint8Array) => void,
  onRemoteUpdate: (path: string, content: string) => void,
  gcInterval?: number
): CRDTManager {
  return new CRDTManager({ vault, onSendUpdate, onRemoteUpdate, gcInterval });
}