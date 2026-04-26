use crate::auth::validate_vault_key;
use crate::oplog::{NewOperation, Oplog};
use futures_util::{SinkExt, StreamExt};
use parking_lot::RwLock;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::broadcast;
use tracing::{error, info};

pub struct RelayState {
    pub docs: (), 
    pub clients: RwLock<HashMap<String, Arc<ClientSession>>>,
    pub oplog: Arc<Oplog>,
    pub tx: broadcast::Sender<Vec<u8>>,
}

pub struct ClientSession {
    pub client_id: String,
    pub device_name: String,
    pub subscribed_vaults: RwLock<HashSet<String>>,
    pub vector_clock: RwLock<HashMap<String, u64>>,
    pub ws_sender: broadcast::Sender<Vec<u8>>,
}

impl RelayState {
    pub fn new(oplog: Arc<Oplog>) -> Self {
        let (tx, _) = broadcast::channel(1024);
        Self {
            docs: (),
            clients: RwLock::new(HashMap::new()),
            oplog,
            tx,
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
        let (tx, _rx) = broadcast::channel::<Vec<u8>>(256);
        let client_id = uuid::Uuid::new_v4().to_string();
        let session = Arc::new(ClientSession {
            client_id: client_id.clone(),
            device_name: String::new(),
            subscribed_vaults: RwLock::new(HashSet::new()),
            vector_clock: RwLock::new(HashMap::new()),
            ws_sender: tx,
        });

        {
            let mut clients = self.clients.write();
            clients.insert(client_id.clone(), session.clone());
        }

        let relay_tx = self.tx.subscribe();

        tokio::spawn(async move {
            let mut rx = relay_tx;
            while let Ok(out) = rx.recv().await {
                if sender.send(tokio_tungstenite::tungstenite::Message::Binary(out)).await.is_err() {
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

        match msg_type {
            "UPDATE" => {
                let payload: UpdateMsg = serde_json::from_value(msg.clone())
                    .unwrap_or(UpdateMsg { vault_id: "".to_string(), path: "".to_string(), update: vec![], content: "".to_string(), isText: false });
                
                // Auto-subscribe client to vault
                if !payload.vault_id.is_empty() {
                    session.subscribed_vaults.write().insert(payload.vault_id.clone());
                }
                
                // Broadcast to other clients
                let _ = self.broadcast_to_vault(&payload.vault_id, &session.client_id, payload.update).await;
            }
            "HANDSHAKE" => {
                let payload: HandshakeMsg = serde_json::from_value(msg.clone())
                    .unwrap_or(HandshakeMsg { vault_id: "".to_string(), last_seq: 0 });
                
                // Auto-subscribe client to vault
                if !payload.vault_id.is_empty() {
                    session.subscribed_vaults.write().insert(payload.vault_id.clone());
                }
                
                self.send_handshake(&payload.vault_id, payload.last_seq, session).await?;
            }
            "DELETE" => {
                let payload: DeleteMsg = serde_json::from_value(msg.clone())
                    .unwrap_or(DeleteMsg { vault_id: "".to_string(), path: "".to_string() });
                
                // Auto-subscribe client to vault
                if !payload.vault_id.is_empty() {
                    session.subscribed_vaults.write().insert(payload.vault_id.clone());
                }
                
                info!(client_id = %session.client_id, vault = %payload.vault_id, path = %payload.path, "delete");
            }
            "RENAME" => {
                let payload: RenameMsg = serde_json::from_value(msg.clone())
                    .unwrap_or(RenameMsg { vault_id: "".to_string(), old_path: "".to_string(), new_path: "".to_string() });
                
                // Auto-subscribe client to vault
                if !payload.vault_id.is_empty() {
                    session.subscribed_vaults.write().insert(payload.vault_id.clone());
                }
                
                info!(client_id = %session.client_id, vault = %payload.vault_id, old = %payload.old_path, new = %payload.new_path, "rename");
            }
            "SUBSCRIBE" => {
                let payload: SubscribeMsg = serde_json::from_value(msg.clone())
                    .unwrap_or(SubscribeMsg { vault_id: "".to_string() });
                session.subscribed_vaults.write().insert(payload.vault_id.clone());
                info!(client_id = %session.client_id, vault = %payload.vault_id, "subscribed");
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
        
        let clients = self.clients.read();
        for (id, session) in clients.iter() {
            if id != exclude_client {
                // Auto-subscribe client to this vault for future broadcasts
                if !vault_id.is_empty() {
                    session.subscribed_vaults.write().insert(vault_id.to_string());
                }
                let _ = session.ws_sender.send(data.clone());
            }
        }
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