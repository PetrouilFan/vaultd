export interface SyncSettings {
  serverUrl: string;
  vaultKey: string;
  deviceName: string;
  excludePatterns: string[];
  maxBinarySize: number;
  crdtGcInterval: number;
}

export const DEFAULT_SETTINGS: SyncSettings = {
  serverUrl: 'ws://100.106.178.69:8081',
  vaultKey: '',
  deviceName: '',
  excludePatterns: ['.obsidian/workspace.json', '.trash/**'],
  maxBinarySize: 20 * 1024 * 1024, // 20MB
  crdtGcInterval: 24 * 60 * 60 * 1000, // 24 hours
};

export type MessageType =
  | 'UPDATE'
  | 'RENAME'
  | 'DELETE'
  | 'CREATE'
  | 'BINARY_CHUNK'
  | 'CONFLICT'
  | 'RESOLVE'
  | 'CURSOR'
  | 'HANDSHAKE'
  | 'ACK';

export interface SyncMessage {
  type: MessageType;
  client_id: string;
  vault_key: string;
  vector_clock: number;
  payload: Record<string, unknown>;
}

export interface FileMetadata {
  path: string;
  isDirectory: boolean;
  extension: string;
  size: number;
  modified: number;
  created: number;
}

export interface ConflictInfo {
  path: string;
  localVersion: string;
  remoteVersion: string;
  localContent?: string;
  remoteContent?: string;
  timestamp: number;
}

export interface BinaryChunk {
  path: string;
  chunkIndex: number;
  totalChunks: number;
  data: ArrayBuffer;
  mimeType: string;
}

export interface CursorPosition {
  path: string;
  line: number;
  ch: number;
  selection?: {
    from: { line: number; ch: number };
    to: { line: number; ch: number };
  };
}

export interface VectorClock {
  [clientId: string]: number;
}

export interface ClientInfo {
  platform: string;
  version: string;
  timestamp: number;
  deviceName?: string;
}

export const TEXT_EXTENSIONS = new Set([
  'md', 'txt', 'json', 'yaml', 'yml', 'toml', 'xml', 'html', 'css', 'js', 'ts',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'swift', 'kt',
  'sql', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'r', 'lua', 'pl',
  'php', 'scala', 'groovy', 'gradle', 'properties', 'env', 'gitignore', 'editorconfig',
  'markdown', 'mdown', 'mkdn', 'mkd', 'mdwn', 'mdtxt', 'mdtext', 'rmd', 'canvas',
]);

export const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'ico', 'tiff', 'tif',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
  'zip', 'tar', 'gz', 'rar', '7z', 'bz2',
  'mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac',
  'mp4', 'avi', 'mkv', 'mov', 'wmv', 'webm',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  'db', 'sqlite', 'sqlitedb', 'excalidraw',
]);

export function fileClass(path: string): 'text' | 'binary' {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  // Canvas files are JSON text — treat them as text
  if (ext === 'canvas') return 'text';
  if (BINARY_EXTENSIONS.has(ext)) return 'binary';
  return 'text';
}

export function getFileExtension(path: string): string {
  return path.split('.').pop()?.toLowerCase() || '';
}

export function isTextFile(path: string): boolean {
  return fileClass(path) === 'text';
}

export function isBinaryFile(path: string): boolean {
  return fileClass(path) === 'binary';
}

export function matchesPattern(path: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.startsWith('*')) {
      if (path.endsWith(pattern.slice(1))) return true;
    } else if (pattern.endsWith('*')) {
      if (path.startsWith(pattern.slice(0, -1))) return true;
    } else if (path.includes(pattern)) {
      return true;
    }
  }
  return false;
}

// Platform detection — safe for both desktop and mobile
export const PLATFORM = {
  isDesktop: typeof window !== 'undefined' && typeof window.require !== 'undefined',
  isWindows: typeof process !== 'undefined' && process.platform === 'win32',
  isMac: typeof process !== 'undefined' && process.platform === 'darwin',
  isLinux: typeof process !== 'undefined' && process.platform === 'linux',
  isMobile: typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent),
};

export function normalizePath(path: string): string {
  if (PLATFORM.isWindows) {
    return path.replace(/\//g, '\\');
  }
  return path;
}

export function getFileMimeType(extension: string): string {
  const mimeTypes: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    pdf: 'application/pdf',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    zip: 'application/zip',
  };
  return mimeTypes[extension.toLowerCase()] || 'application/octet-stream';
}