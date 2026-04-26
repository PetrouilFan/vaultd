import type { SyncSettings, SyncMessage } from './types';
import { getFileMimeType, matchesPattern } from './types';
import type { Vault, TFile } from 'obsidian';

const CHUNK_SIZE = 64 * 1024;

export interface BinarySyncConfig {
  vault: Vault;
  sendMessage: (message: SyncMessage) => void;
  settings: SyncSettings;
  baseUrl: string;
}

export interface BinaryTransfer {
  hash: string;
  path: string;
  direction: 'upload' | 'download';
  totalChunks: number;
  receivedChunks: number;
  chunks: Map<number, Uint8Array>;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  error?: string;
}

export interface FileHash {
  hash: string;
  size: number;
  mtime: number;
}

export class BinarySyncManager {
  private vault: Vault;
  private sendMessage: (message: SyncMessage) => void;
  private settings: SyncSettings;
  private httpBaseUrl: string;

  private activeTransfers: Map<string, BinaryTransfer> = new Map();
  private fileHashCache: Map<string, FileHash> = new Map();

  constructor(config: BinarySyncConfig) {
    this.vault = config.vault;
    this.sendMessage = config.sendMessage;
    this.settings = config.settings;
    this.httpBaseUrl = this.buildHttpBaseUrl();
  }

  private buildHttpBaseUrl(): string {
    const url = this.settings.serverUrl;
    const match = url.match(/^wss?:\/\/([^\/:]+)(?::(\d+))?/);
    if (match) {
      const host = match[1];
      return `http://${host}:8080`;
    }
    return this.settings.serverUrl || 'http://localhost:8080';
  }

  private isMobilePlatform(): boolean {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  }

  private async computeSHA256(data: ArrayBuffer): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private computeProxyHash(file: TFile): string {
    return `${file.stat.size}-${file.stat.mtime}`;
  }

  async onVaultFileCreated(file: TFile): Promise<void> {
    if (matchesPattern(file.path, this.settings.excludePatterns)) return;

    if (this.isMobilePlatform() && file.stat.size > this.settings.maxBinarySize) {
      console.log('[BinarySync] Skipping large file on mobile:', file.path);
      return;
    }

    const { hash } = await this.computeFileHash(file);
    await this.sendBinaryChunks(file, hash);
  }

  async onVaultFileModified(file: TFile): Promise<void> {
    if (matchesPattern(file.path, this.settings.excludePatterns)) return;

    if (this.isMobilePlatform() && file.stat.size > this.settings.maxBinarySize) return;

    this.fileHashCache.delete(file.path);
    const { hash } = await this.computeFileHash(file);
    await this.sendBinaryChunks(file, hash);
  }

  async onVaultFileDeleted(path: string): Promise<void> {
    const cached = this.fileHashCache.get(path);
    if (cached) {
      this.sendMessage({
        type: 'DELETE',
        client_id: '',
        vault_key: '',
        vector_clock: 0,
        payload: { path, hash: cached.hash, isBinary: true },
      });
      this.fileHashCache.delete(path);
    }
  }

  private async computeFileHash(file: TFile): Promise<FileHash> {
    const cached = this.fileHashCache.get(file.path);
    if (cached && cached.mtime >= file.stat.mtime) return cached;

    const isMobile = this.isMobilePlatform();
    let hash: string;
    if (isMobile) {
      hash = this.computeProxyHash(file);
    } else {
      const content = await this.vault.readBinary(file.path);
      hash = await this.computeSHA256(content);
    }

    const fileHash: FileHash = { hash, size: file.stat.size, mtime: file.stat.mtime };
    this.fileHashCache.set(file.path, fileHash);
    return fileHash;
  }

  private async sendBinaryChunks(file: TFile, hash: string): Promise<void> {
    try {
      const content = await this.vault.readBinary(file.path);
      const totalChunks = Math.ceil(content.byteLength / CHUNK_SIZE);

      const transfer: BinaryTransfer = {
        hash,
        path: file.path,
        direction: 'upload',
        totalChunks,
        receivedChunks: 0,
        chunks: new Map(),
        status: 'in_progress',
      };

      this.activeTransfers.set(hash, transfer);

      for (let i = 0; i < totalChunks; i++) {
        const offset = i * CHUNK_SIZE;
        const length = Math.min(CHUNK_SIZE, content.byteLength - offset);
        const chunkData = content.slice(offset, offset + length);
        this.sendChunk(hash, file.path, i, totalChunks, chunkData);
      }

      transfer.status = 'completed';
    } catch (error) {
      console.error('[BinarySync] Error sending binary chunks for', file.path, error);
      throw error;
    }
  }

  private sendChunk(
    hash: string,
    path: string,
    chunkIndex: number,
    totalChunks: number,
    data: ArrayBuffer
  ): void {
    const message: SyncMessage = {
      type: 'BINARY_CHUNK',
      client_id: '',
      vault_key: '',
      vector_clock: 0,
      payload: {
        hash,
        path,
        chunk_index: chunkIndex,
        total_chunks: totalChunks,
        data: this.arrayBufferToBase64(data),
      },
    };
    this.sendMessage(message);
  }

  handleBinaryChunkMessage(message: SyncMessage): void {
    const payload = message.payload as any;
    const { hash, path, chunk_index, total_chunks, data } = payload;

    let transfer = this.activeTransfers.get(hash);
    if (!transfer) {
      transfer = {
        hash,
        path,
        direction: 'download',
        totalChunks: total_chunks,
        receivedChunks: 0,
        chunks: new Map(),
        status: 'in_progress',
      };
      this.activeTransfers.set(hash, transfer);
    }

    transfer.chunks.set(chunk_index, new Uint8Array(this.base64ToArrayBuffer(data)));
    transfer.receivedChunks++;

    if (transfer.receivedChunks === transfer.totalChunks) {
      this.assembleAndWriteBinary(transfer).catch((err) => {
        transfer!.status = 'failed';
        transfer!.error = (err as Error).message;
        console.error('[BinarySync] Failed to assemble', hash, err);
      });
    }
  }

  private async assembleAndWriteBinary(transfer: BinaryTransfer): Promise<void> {
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < transfer.totalChunks; i++) {
      const chunk = transfer.chunks.get(i);
      if (!chunk) throw new Error(`Missing chunk ${i} for ${transfer.hash}`);
      chunks.push(chunk);
    }

    const totalSize = chunks.reduce((s, c) => s + c.byteLength, 0);
    const assembled = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      assembled.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const file = this.vault.getAbstractFileByPath(transfer.path);
    if (file instanceof TFile) {
      await this.vault.modifyBinary(file, assembled);
    } else {
      await this.vault.createBinary(transfer.path, assembled);
    }

    this.fileHashCache.set(transfer.path, {
      hash: transfer.hash,
      size: totalSize,
      mtime: Date.now(),
    });

    transfer.status = 'completed';
    this.activeTransfers.delete(transfer.hash);
    console.log('[BinarySync] Downloaded and written:', transfer.path);
  }

  async downloadBinary(hash: string, path: string): Promise<void> {
    if (this.activeTransfers.has(hash)) return;

    const transfer: BinaryTransfer = {
      hash,
      path,
      direction: 'download',
      totalChunks: 0,
      receivedChunks: 0,
      chunks: new Map(),
      status: 'in_progress',
    };
    this.activeTransfers.set(hash, transfer);

    try {
      const response = await fetch(`${this.httpBaseUrl}/blob/${hash}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const buffer = await response.arrayBuffer();
      const totalChunks = Math.ceil(buffer.byteLength / CHUNK_SIZE);
      transfer.totalChunks = totalChunks;

      for (let i = 0; i < totalChunks; i++) {
        transfer.chunks.set(i, new Uint8Array(buffer.slice(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, buffer.byteLength))));
        transfer.receivedChunks++;
      }

      if (transfer.receivedChunks === transfer.totalChunks) {
        await this.assembleAndWriteBinary(transfer);
      }
    } catch (err) {
      transfer.status = 'failed';
      transfer.error = (err as Error).message;
      console.error('[BinarySync] Download failed', hash, err);
      throw err;
    }
  }

  async fetchSnapshot(): Promise<Map<string, { hash: string; size: number }>> {
    const response = await fetch(`${this.httpBaseUrl}/snapshot`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return new Map(Object.entries(data.files || {}));
  }

  getActiveTransferCount(): number {
    return this.activeTransfers.size;
  }

  cleanup(): void {
    this.activeTransfers.clear();
    this.fileHashCache.clear();
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
}

export function createBinarySyncManager(config: BinarySyncConfig): BinarySyncManager {
  return new BinarySyncManager(config);
}