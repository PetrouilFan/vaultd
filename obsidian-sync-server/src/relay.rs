use crate::auth::validate_vault_key;
use crate::oplog::{NewOperation, Oplog};
use futures_util::{SinkExt, StreamExt};
use parking_lot::RwLock;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::broadcast;
use tracing::{error, info};

pub struct RelayState {
    pub docs: (), 
    pub clients: RwLock<HashMap<String, Arc<ClientSession>>>,
    pub oplog: Arc<Oplog>,
    pub tx: broadcast::Sender<Vec<u8>>,
    pub recent_messages: RwLock<HashSet<String>>,
    pub message_timestamps: RwLock<HashMap<String, Instant>>,
}

pub struct ClientSession {
    pub client_id: String,
    pub device_name: String,
    pub subscribed_vaults: RwLock<HashSet<String>>,
    pub vector_clock: RwLock<HashMap<String, u64>>,
    pub ws_sender: broadcast::Sender<Vec<u8>>,
    pub last_seq: RwLock<i64>,
}

impl RelayState {
    pub fn new(oplog: Arc<Oplog>) -> Self {
        let (tx, _) = broadcast::channel(1024);
        Self {
            docs: (),
            clients: RwLock::new(HashMap::new()),
            oplog,
            tx,
            recent_messages: RwLock::new(HashSet::new()),
            message_timestamps: RwLock::new(HashMap::new()),
        }
    }

    pub fn get_or_create_doc(&self, _vault_id: &str) {
        // Stateless relay - no in-memory docs
    }
}

impl RelayState {
    pub async fn handle_websocket(
        self: Arc<Self>,
        socket: tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
        vault_key: String,
    ) {
        if let Err(e) = validate_vault_key(&vault_key) {
            error!(err = %e, "auth failed");
            return;
        }

        let (mut sender, mut receiver) = socket.split();
        let (tx, mut rx) = broadcast::channel::<Vec<u8>>(256);
        let client_id = uuid::Uuid::new_v4().to_string();
        let session = Arc::new(ClientSession {
            client_id: client_id.clone(),
            device_name: String::new(),
            subscribed_vaults: RwLock::new(HashSet::new()),
            vector_clock: RwLock::new(HashMap::new()),
            ws_sender: tx,
            last_seq: RwLock::new(0),
        });

        {
            let mut clients = self.clients.write();
            clients.insert(client_id.clone(), session.clone());
        }

        // Listen on per-client channel to forward to WebSocket
tokio::spawn(async move {
            while let Ok(out) = rx.recv().await {
                // Send as text (convert bytes to string)
                let text = String::from_utf8_lossy(&out);
                if sender.send(tokio_tungstenite::tungstenite::Message::Text(text.to_string())).await.is_err() {
                    break;
                }
            }
        });

        while let Some(msg) = receiver.next().await {
            match msg {
                Ok(tokio_tungstenite::tungstenite::Message::Binary(data)) => {
                    if let Err(e) = self.handle_binary_msg(&data, &session).await {
                        error!(client_id = client_id, err = %e, "handle binary msg");
                    }
                }
                Ok(tokio_tungstenite::tungstenite::Message::Text(text)) => {
                    if let Err(e) = self.handle_text_msg(&text, &session).await {
                        error!(client_id = client_id, err = %e, "handle text msg");
                    }
                }
                Ok(tokio_tungstenite::tungstenite::Message::Close(_)) => {
                    info!(client_id = client_id, "client disconnected");
                    break;
                }
                Err(e) => {
                    error!(client_id = client_id, err = %e, "ws recv error");
                    break;
                }
                _ => {}
            }
        }

        let mut clients = self.clients.write();
        clients.remove(&client_id);
        let vaults: Vec<_> = session.subscribed_vaults.read().iter().cloned().collect();
        for vault in vaults {
            info!(client_id = client_id, vault, "unsubscribed");
        }
    }

    async fn handle_binary_msg(&self, _data: &[u8], _session: &Arc<ClientSession>) -> Result<(), RelayError> {
        // Stateless relay: binary messages just logged, actual data in text messages
        Ok(())
    }

    async fn handle_text_msg(&self, text: &str, session: &Arc<ClientSession>) -> Result<(), RelayError> {
        #[derive(serde::Deserialize)]
        struct UpdateMsg {
            #[serde(default)]
            vault_id: String,
            path: String,
            #[serde(default)]
            update: Vec<u8>,
            #[serde(default)]
            content: String,
            #[serde(default)]
            isText: bool,
        }

        #[derive(serde::Deserialize)]
        struct HandshakeMsg {
            #[serde(default)]
            vault_id: String,
            #[serde(default)]
            last_seq: i64,
        }

        #[derive(serde::Deserialize)]
        struct DeleteMsg {
            #[serde(default)]
            vault_id: String,
            path: String,
        }

        #[derive(serde::Deserialize)]
        struct RenameMsg {
            #[serde(default)]
            vault_id: String,
            old_path: String,
            new_path: String,
        }

        #[derive(serde::Deserialize)]
        struct SubscribeMsg {
            #[serde(default)]
            vault_id: String,
        }

        let msg: serde_json::Value = serde_json::from_str(text)
            .map_err(|e| RelayError::ParseError(e.to_string()))?;

        let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
        
        info!(client_id = %session.client_id, msg_type = %msg_type, "received message");

        match msg_type {
            "UPDATE" => {
                // Parse the payload from the message - both binary update AND plain content
                let payload = msg.get("payload").and_then(|p| p.as_object()).cloned();
                
                let vault_id = payload.as_ref()
                    .and_then(|p| p.get("vault_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                
                let path = payload.as_ref()
                    .and_then(|p| p.get("path"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                
                // Get binary update
                let update: Vec<u8> = payload.as_ref()
                    .and_then(|p| p.get("update"))
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|v| v.as_u64().map(|n| n as u8)).collect())
                    .unwrap_or_default();
                
                // ALSO get plain text content - simpler!
                let content = payload.as_ref()
                    .and_then(|p| p.get("content"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                
                // If we have plain content, include it in broadcast
                let mut broadcast_data = update.clone();
                if !content.is_empty() {
                    // Send both binary and text
                    info!(client_id = %session.client_id, vault = %vault_id, path = %path, update_size = %update.len(), content_size = %content.len(), "received UPDATE with content");
                } else {
                    info!(client_id = %session.client_id, vault = %vault_id, path = %path, update_size = %update.len(), "received UPDATE");
                }
                
                // Auto-subscribe client to vault
                if !vault_id.is_empty() {
                    session.subscribed_vaults.write().insert(vault_id.clone());
                }
                
                // Broadcast BOTH as JSON with content field
                let msg = serde_json::json!({
                    "type": "UPDATE",
                    "client_id": session.client_id,
                    "vault_key": "",
                    "vector_clock": 0,
                    "payload": {
                        "vault_id": vault_id,
                        "path": path,
                        "update": if update.is_empty() { serde_json::Value::Null } else { serde_json::json!(update) },
                        "content": if content.is_empty() { serde_json::Value::Null } else { serde_json::json!(content) },
                        "isText": !content.is_empty()
                    }
                });
                
                let json_bytes = serde_json::to_vec(&msg).map_err(|e| RelayError::SerializeError(e.to_string()))?;
                
let _ = self.broadcast_to_vault_json(&vault_id, &session.client_id, json_bytes).await;
            }
            "HANDSHAKE" => {
                #[derive(serde::Deserialize)]
                struct HandshakePayload {
                    #[serde(default)]
                    vault_id: String,
                    #[serde(default)]
                    last_seq: i64,
                }
                let payload: HandshakePayload = serde_json::from_value(msg.get("payload").cloned().unwrap_or(serde_json::Value::Null))
                    .unwrap_or(HandshakePayload { vault_id: "".to_string(), last_seq: 0 });
                
                *session.last_seq.write() = payload.last_seq;
                
                if !payload.vault_id.is_empty() {
                    session.subscribed_vaults.write().insert(payload.vault_id.clone());
                }
                
                info!(client_id = %session.client_id, vault = %payload.vault_id, last_seq = %payload.last_seq, "handshake");
                self.send_handshake(&payload.vault_id, payload.last_seq, session).await?;
            }
            "CREATE" => {
                #[derive(serde::Deserialize)]
                struct CreateMsg {
                    #[serde(default)]
                    vault_id: String,
                    path: String,
                    #[serde(default)]
                    content: String,
                }
                let payload: CreateMsg = serde_json::from_value(msg.clone())
                    .unwrap_or(CreateMsg { vault_id: "".to_string(), path: "".to_string(), content: "".to_string() });
                
                if !payload.vault_id.is_empty() {
                    session.subscribed_vaults.write().insert(payload.vault_id.clone());
                }
                
                info!(client_id = %session.client_id, vault = %payload.vault_id, path = %payload.path, "create");
                
                let msg = serde_json::json!({
                    "type": "CREATE",
                    "client_id": session.client_id,
                    "vault_key": "",
                    "vector_clock": 0,
                    "payload": {
                        "vault_id": payload.vault_id,
                        "path": payload.path,
                        "content": payload.content,
                    }
                });
                
                let json_bytes = serde_json::to_vec(&msg).map_err(|e| RelayError::SerializeError(e.to_string()))?;
                let _ = self.broadcast_to_vault_json(&payload.vault_id, &session.client_id, json_bytes).await;
            }
            "DELETE" => {
                let payload: DeleteMsg = serde_json::from_value(msg.clone())
                    .unwrap_or(DeleteMsg { vault_id: "".to_string(), path: "".to_string() });
                
                // Auto-subscribe client to vault
                if !payload.vault_id.is_empty() {
                    session.subscribed_vaults.write().insert(payload.vault_id.clone());
                }
                
                info!(client_id = %session.client_id, vault = %payload.vault_id, path = %payload.path, "delete");
                
                let msg = serde_json::json!({
                    "type": "DELETE",
                    "client_id": session.client_id,
                    "vault_key": "",
                    "vector_clock": 0,
                    "payload": {
                        "vault_id": payload.vault_id,
                        "path": payload.path,
                    }
                });
                
                let json_bytes = serde_json::to_vec(&msg).map_err(|e| RelayError::SerializeError(e.to_string()))?;
                let _ = self.broadcast_to_vault_json(&payload.vault_id, &session.client_id, json_bytes).await;
            }
            "RENAME" => {
                let payload: RenameMsg = serde_json::from_value(msg.clone())
                    .unwrap_or(RenameMsg { vault_id: "".to_string(), old_path: "".to_string(), new_path: "".to_string() });
                
                // Auto-subscribe client to vault
                if !payload.vault_id.is_empty() {
                    session.subscribed_vaults.write().insert(payload.vault_id.clone());
                }
                
                info!(client_id = %session.client_id, vault = %payload.vault_id, old = %payload.old_path, new = %payload.new_path, "rename");
                
                let msg = serde_json::json!({
                    "type": "RENAME",
                    "client_id": session.client_id,
                    "vault_key": "",
                    "vector_clock": 0,
                    "payload": {
                        "vault_id": payload.vault_id,
                        "old_path": payload.old_path,
                        "new_path": payload.new_path,
                    }
                });
                
                let json_bytes = serde_json::to_vec(&msg).map_err(|e| RelayError::SerializeError(e.to_string()))?;
                let _ = self.broadcast_to_vault_json(&payload.vault_id, &session.client_id, json_bytes).await;
            }
            "SUBSCRIBE" => {
                let payload: SubscribeMsg = serde_json::from_value(msg.clone())
                    .unwrap_or(SubscribeMsg { vault_id: "".to_string() });
                session.subscribed_vaults.write().insert(payload.vault_id.clone());
                info!(client_id = %session.client_id, vault = %payload.vault_id, "subscribed");
            }
            "PING" => {
                // Respond to ping to keep connection alive
                let _ = session.ws_sender.send(b"{\"type\":\"PONG\"}".to_vec());
            }
            _ => {
                info!(client_id = %session.client_id, msg_type = %msg_type, "unhandled message type");
            }
        }

        Ok(())
    }

    async fn apply_update_to_doc(&self, path: &str, client_id: String) -> Result<(), RelayError> {
        // Stateless relay: just persist to WAL
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let new_op = NewOperation {
            timestamp_unix_ms: now_ms,
            client_id,
            device_name: "relay".to_string(),
            op_type: "UPDATE".to_string(),
            path: path.to_string(),
            old_path: None,
            vector_clock: "{}".to_string(),
            content_hash: None,
        };
        let _ = self.oplog.append_op(new_op).await;
        Ok(())
    }

async fn broadcast_to_vault(
        &self,
        vault_id: &str,
        exclude_client: &str,
        data: Vec<u8>,
    ) -> Result<(), RelayError> {
        if data.is_empty() {
            return Ok(());
        }
        
        // Wrap in JSON message format
        let msg = serde_json::json!({
            "type": "UPDATE",
            "payload": {
                "vault_id": vault_id,
                "update": data,
                "isText": false
            }
        });
        
        let json_bytes = serde_json::to_vec(&msg).map_err(|e| RelayError::SerializeError(e.to_string()))?;
        
        let clients = self.clients.read();
        let client_count = clients.len();
        info!( vault = %vault_id, exclude = %exclude_client, data_size = %data.len(), client_count = %client_count, "broadcasting");
        
        for (id, session) in clients.iter() {
            if id != exclude_client {
                // Auto-subscribe client to this vault for future broadcasts
                if !vault_id.is_empty() {
                    session.subscribed_vaults.write().insert(vault_id.to_string());
}
                let _ = session.ws_sender.send(json_bytes.clone());
                info!(client_id = %id, "sent update to client");
            }
        }
        Ok(())
    }
    
    async fn broadcast_to_vault_json(
        &self,
        vault_id: &str,
        exclude_client: &str,
        data: Vec<u8>,
    ) -> Result<(), RelayError> {
        if data.is_empty() {
            return Ok(());
        }
        
        // Message deduplication: compute hash of message content
        let msg_hash = format!("{}:{}", vault_id, sha256_hash(&data));
        
        // Clean old entries (older than 5 seconds)
        let now = Instant::now();
        {
            let mut timestamps = self.message_timestamps.write();
            timestamps.retain(|_, instant| now.duration_since(*instant) < Duration::from_secs(5));
        }
        
        // Check for duplicate
        {
            let mut recent = self.recent_messages.write();
            let mut timestamps = self.message_timestamps.write();
            if recent.contains(&msg_hash) {
                info!(vault = %vault_id, "skipping duplicate message");
                return Ok(());
            }
            recent.insert(msg_hash.clone());
            timestamps.insert(msg_hash, now);
        }
        
        let clients = self.clients.read();
        let mut sent_count = 0;
        
        // Always broadcast to all connected clients (no subscription check)
        for (id, session) in clients.iter() {
            if id == exclude_client {
                continue;
            }
            // Always send to everyone
            let _ = session.ws_sender.send(data.clone());
            sent_count += 1;
            info!(client_id = %id, "sent update to client");
        }
        
        info!(vault = %vault_id, exclude = %exclude_client, data_size = %data.len(), client_count = %sent_count, "broadcasting JSON to all");
        Ok(())
    }
    
    async fn send_handshake(
        &self,
        vault_id: &str,
        last_seq: i64,
        session: &Arc<ClientSession>,
    ) -> Result<(), RelayError> {
        let ops = self.oplog.get_since(last_seq).await
            .map_err(|e| RelayError::OplogError(e.to_string()))?;
        let handshake = RelayMessage::Handshake {
            vault_id: vault_id.to_string(),
            ops,
        };
        let json = serde_json::to_string(&handshake)
            .map_err(|e| RelayError::SerializeError(e.to_string()))?;
        let _ = session.ws_sender.send(json.into_bytes());
        Ok(())
    }

    pub async fn check_conflicts(&self, _vault_id: &str, path: &str) -> Result<Option<ConflictInfo>, RelayError> {
        let ops = self.oplog.get_since(0).await
            .map_err(|e| RelayError::OplogError(e.to_string()))?;
        let path_ops: Vec<_> = ops.iter()
            .filter(|op| op.path == path && op.op_type == "UPDATE")
            .collect();
        if path_ops.len() >= 2 {
            let mut clients_set = HashSet::new();
            for op in &path_ops {
                clients_set.insert(op.client_id.clone());
            }
            if clients_set.len() >= 2 {
                return Ok(Some(ConflictInfo {
                    path: path.to_string(),
                    clients: clients_set.into_iter().collect(),
                }));
            }
        }
        Ok(None)
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type")]
pub enum RelayMessage {
    #[serde(rename = "HANDSHAKE")]
    Handshake {
        vault_id: String,
        ops: Vec<crate::oplog::Operation>,
    },
    #[serde(rename = "UPDATE")]
    Update {
        vault_id: String,
        data: Vec<u8>,
    },
    #[serde(rename = "CONFLICT")]
    Conflict {
        path: String,
        clients: Vec<String>,
    },
    #[serde(rename = "AWARENESS")]
    Awareness {
        client_id: String,
        data: Vec<u8>,
    },
}

#[derive(Debug)]
pub struct ConflictInfo {
    pub path: String,
    pub clients: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum RelayError {
    #[error("invalid update")]
    InvalidUpdate,
    #[error("parse error: {0}")]
    ParseError(String),
    #[error("oplog error: {0}")]
    OplogError(String),
    #[error("serialize error: {0}")]
    SerializeError(String),
}

fn base64_decode(input: &str) -> Result<Vec<u8>, RelayError> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(input)
        .map_err(|e| RelayError::ParseError(e.to_string()))
}

fn sha256_hash(data: &[u8]) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    data.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}