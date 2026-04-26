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
      if (this.queue[0].retries >= this.maxRetries) {
        return this.queue.shift();
      }
      this.persistToIndexedDB(this.queue[0]);
    }
    return undefined;
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
}

export function createOfflineQueue(): OfflineQueue {
  return new OfflineQueue();
}