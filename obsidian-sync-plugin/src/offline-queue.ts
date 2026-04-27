import type { SyncMessage } from './types';

export interface QueuedMessage {
  message: SyncMessage;
  timestamp: number;
  retries: number;
}

export class OfflineQueue {
  private queue: QueuedMessage[] = [];
  private maxRetries = 3;
  private db: IDBDatabase | null = null;
  private dbReady: Promise<void>;

  constructor() {
    this.dbReady = this.initIndexedDB();
  }

  private async initIndexedDB(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('ObsidianSyncOffline', 1);

      request.onerror = () => reject(request.error);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('offline_queue')) {
          const store = db.createObjectStore('offline_queue', {
            keyPath: 'id',
            autoIncrement: true,
          });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
    });
  }

  enqueue(message: SyncMessage): void {
    const queued: QueuedMessage = {
      message,
      timestamp: Date.now(),
      retries: 0,
    };
    this.queue.push(queued);
    this.persistToIndexedDB(queued);
  }

  dequeue(): QueuedMessage | undefined {
    const item = this.queue.shift();
    if (item) {
      this.removeFromIndexedDB(item);
    }
    return item;
  }

  peek(): QueuedMessage | undefined {
    return this.queue[0];
  }

  getAll(): QueuedMessage[] {
    return [...this.queue];
  }

  clear(): void {
    this.queue = [];
    this.clearIndexedDB();
  }

  size(): number {
    return this.queue.length;
  }

  incrementRetries(): QueuedMessage | undefined {
    if (this.queue.length > 0) {
      this.queue[0].retries++;
      console.log('[OfflineQueue] Message retry count:', this.queue[0].retries);
      // NEVER drop messages - keep retrying until connection restored
      // Messages will be retried on next connect
      this.persistToIndexedDB(this.queue[0]);
    }
    return undefined;
  }

  // Get retry delay with exponential backoff (max 30 seconds)
  getRetryDelay(): number {
    if (this.queue.length === 0) return 1000;
    const retries = this.queue[0].retries;
    const delay = Math.min(1000 * Math.pow(2, retries), 30000);
    return delay;
  }

  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  isFull(): boolean {
    return this.queue.length >= 1000;
  }

  private async persistToIndexedDB(item: QueuedMessage): Promise<void> {
    await this.dbReady;
    if (!this.db) return;

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('offline_queue', 'readwrite');
      const store = tx.objectStore('offline_queue');
      const request = store.put({
        id: item.timestamp,
        type: item.message.type,
        path: (item.message.payload as any)?.path,
        data: JSON.stringify(item.message),
        timestamp: item.timestamp,
        retries: item.retries,
      });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  private async removeFromIndexedDB(item: QueuedMessage): Promise<void> {
    await this.dbReady;
    if (!this.db) return;

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('offline_queue', 'readwrite');
      const store = tx.objectStore('offline_queue');
      const request = store.delete(item.timestamp);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  private async clearIndexedDB(): Promise<void> {
    await this.dbReady;
    if (!this.db) return;

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('offline_queue', 'readwrite');
      const store = tx.objectStore('offline_queue');
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // Backup to localStorage as fallback
  backupToLocalStorage(): void {
    try {
      const data = JSON.stringify(this.queue);
      localStorage.setItem('obsidian-sync-offline-backup', data);
      console.log('[OfflineQueue] Backed up to localStorage:', this.queue.length, 'messages');
    } catch (e) {
      console.warn('[OfflineQueue] localStorage backup failed:', e);
    }
  }

  // Restore from localStorage fallback
  restoreFromLocalStorage(): void {
    try {
      const data = localStorage.getItem('obsidian-sync-offline-backup');
      if (data) {
        const restored = JSON.parse(data) as QueuedMessage[];
        for (const item of restored) {
          if (!this.queue.find(q => q.timestamp === item.timestamp)) {
            this.queue.push(item);
          }
        }
        console.log('[OfflineQueue] Restored from localStorage:', restored.length, 'messages');
        localStorage.removeItem('obsidian-sync-offline-backup');
      }
    } catch (e) {
      console.warn('[OfflineQueue] localStorage restore failed:', e);
    }
  }
}

export function createOfflineQueue(): OfflineQueue {
  return new OfflineQueue();
}