# Vaultd

Real-time bidirectional sync for Obsidian vaults using Yjs CRDT, with a Rust relay server.

## Overview

Vaultd consists of two parts:

1. **Obsidian Plugin** (`obsidian-sync-plugin/`) - A plugin that syncs your vault in real-time using Yjs CRDT
2. **Relay Server** (`obsidian-sync-server/`) - A Rust server that relays updates between clients

## Features

- Real-time bidirectional sync using Yjs CRDT
- Conflict-free merging
- Binary/attachment support (optional)
- Rust relay server for multi-device sync
- End-to-end encryption via vault key

## Quick Start

### 1. Start the Relay Server

```bash
cd obsidian-sync-server
cargo build --release
cp config.toml.example config.toml
# Edit config.toml with your vault_key
./target/release/obsidian-sync-server
```

Or with Docker:
```bash
cd obsidian-sync-server
docker build -t vaultd-server .
docker run -p 8080:8080 -p 8081:8081 -v ./data:/app/data vaultd-server
```

### 2. Install the Obsidian Plugin

1. Copy the plugin files to your Obsidian plugins folder:
   - Linux: `~/.obsidian/plugins/vaultd/`
   - macOS: `~/Library/Application Support/obsidian/plugins/vaultd/`
   - Windows: `%APPDATA%/obsidian/plugins/vaultd/`

2. Copy `main.js`, `manifest.json` to the plugin folder

3. Enable the plugin in Obsidian Settings > Community Plugins

### 3. Configure the Plugin

Edit `manifest.json` with your server URLs:

```json
{
  "server": {
    "wsUrl": "ws://YOUR_SERVER_IP:8081",
    "httpUrl": "http://YOUR_SERVER_IP:8080"
  }
}
```

## Configuration

### Server (config.toml)

```toml
[data_dir]
path = "./data"

[server]
http_port = 8080
ws_port = 8081

[auth]
# Generate with: openssl rand -hex 32
vault_key = "your-secret-key"

[logging]
level = "info"
```

### Plugin (manifest.json)

```json
{
  "server": {
    "wsUrl": "ws://localhost:8081",
    "httpUrl": "http://localhost:8080"
  },
  "sync": {
    "enabled": true,
    "crdtGcInterval": 30000
  },
  "binary": {
    "enabled": false
  }
}
```

## Architecture

```
┌─────────────┐     WebSocket      ┌─────────────┐
│  Obsidian   │─────────────────────│   Relay    │
│  Client A  │   Real-time sync    │   Server   │
└─────────────┘                   └─────────────┘
       │                                │
       │                            ┌──┴──┐
       │                            │ WAL  │
       │                            │Blob  │
       ▼                            └──┬──┘
┌─────────────┐     WebSocket           │
│  Obsidian  │────────────────────────┘
│  Client B  │
└─────────────┘
```

### Protocol

Clients connect via WebSocket and send JSON messages:

```json
{"type": "SUBSCRIBE", "vault_id": "vault-1"}
{"type": "UPDATE", "path": "notes/foo.md", "update": [...]}
{"type": "HANDSHAKE", "vault_id": "vault-1", "last_seq": 0}
```

## Security

- Vault key (shared secret) authenticates clients
- All traffic isplain WebSocket (use behind VPN/Tailscale)
- For public deployment, add TLS termination

## Development

### Build Plugin

```bash
cd obsidian-sync-plugin
npm install
npm run build
```

### Build Server

```bash
cd obsidian-sync-server
cargo build --release
```

## License

MIT