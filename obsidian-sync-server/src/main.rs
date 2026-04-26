use crate::auth::{configure as configure_auth, validate_vault_key};
use crate::blob_store::BlobStore;
use crate::git_backup::GitBackup;
use crate::oplog::Oplog;
use crate::relay::RelayState;
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use std::fs;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::signal;
use tower_http::cors::{Any, CorsLayer};
use tower_http::timeout::TimeoutLayer;
use tracing::{error, info, warn, Level};
use tracing_subscriber::FmtSubscriber;

mod auth;
mod blob_store;
mod git_backup;
mod oplog;
mod relay;

#[derive(Deserialize)]
struct Config {
    server_id: String,
    listen_addr: String,
    #[serde(default)]
    vault_key: String,
    database: DatabaseConfig,
    blob_store: BlobStoreConfig,
    #[serde(default)]
    git_backup: GitBackupConfig,
    #[serde(default)]
    logging: LoggingConfig,
}

#[derive(Deserialize)]
struct DatabaseConfig {
    path: String,
}

#[derive(Deserialize)]
struct BlobStoreConfig {
    base_path: String,
}

#[derive(Deserialize)]
struct GitBackupConfig {
    enabled: bool,
    schedule: String,
    remote: String,
    branch: String,
    vault_mirror: String,
    author_name: String,
    author_email: String,
}

impl Default for GitBackupConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            schedule: "0 3 * * *".to_string(),
            remote: String::new(),
            branch: "main".to_string(),
            vault_mirror: String::new(),
            author_name: "obsidian-sync".to_string(),
            author_email: "sync@localhost".to_string(),
        }
    }
}

#[derive(Deserialize, Default)]
struct LoggingConfig {
    level: String,
}

#[derive(Clone)]
struct AppState {
    oplog: Arc<Oplog>,
    blob_store: Arc<BlobStore>,
    relay: Arc<RelayState>,
    git_backup: Option<Arc<GitBackup>>,
}

impl AppState {
    async fn new(config: &Config) -> Result<Self, Box<dyn std::error::Error>> {
        std::fs::create_dir_all(Path::new(&config.database.path).parent().unwrap())?;
        std::fs::create_dir_all(&config.blob_store.base_path)?;
        let oplog = Arc::new(Oplog::open(Path::new(&config.database.path))?);
        let blob_store = Arc::new(BlobStore::new(Path::new(&config.blob_store.base_path))?);
        let relay = Arc::new(RelayState::new(oplog.clone()));
        let git_backup = if config.git_backup.enabled {
            let gb = GitBackup::new(
                true,
                config.git_backup.schedule.clone(),
                config.git_backup.remote.clone(),
                config.git_backup.branch.clone(),
                config.git_backup.vault_mirror.clone(),
                config.git_backup.author_name.clone(),
                config.git_backup.author_email.clone(),
            );
            let arc = Arc::new(gb);
            Arc::clone(&arc).spawn();
            Some(arc)
        } else {
            None
        };
        Ok(Self {
            oplog,
            blob_store,
            relay,
            git_backup,
        })
    }
}

async fn health() -> &'static str {
    "OK"
}

async fn get_snapshot(State(state): State<AppState>) -> axum::response::Response {
    match state.oplog.get_manifest().await {
        Ok(manifest) => Json(serde_json::json!({ "files": manifest })).into_response(),
        Err(e) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn get_blob(
    State(state): State<AppState>,
    axum::extract::Path(hash): axum::extract::Path<String>,
) -> impl IntoResponse {
    match state.blob_store.get_blob(&hash).await {
        Ok(data) => {
            let mut res = axum::response::Response::new(axum::body::Body::from(data));
            res.headers_mut().insert(
                axum::http::header::CONTENT_TYPE,
                axum::http::HeaderValue::from_static("application/octet-stream"),
            );
            res
        }
        Err(crate::blob_store::BlobError::NotFound) => {
            (axum::http::StatusCode::NOT_FOUND, "blob not found").into_response()
        }
        Err(e) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn post_blob(State(state): State<AppState>, body: axum::body::Body) -> impl IntoResponse {
    let vault_key = std::env::var("VAULT_KEY").unwrap_or_default();
    if let Err(e) = validate_vault_key(&vault_key) {
        return (axum::http::StatusCode::UNAUTHORIZED, e.to_string()).into_response();
    }

    let full_body = match axum::body::to_bytes(body, 50 << 20).await {
        Ok(b) => b,
        Err(e) => return (axum::http::StatusCode::BAD_REQUEST, e.to_string()).into_response(),
    };

    match state.blob_store.store_blob(&full_body).await {
        Ok(h) => Json(serde_json::json!({ "hash": h })).into_response(),
        Err(e) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config_path = std::env::args().nth(1).unwrap_or_else(|| "config.toml".into());
    let config_data = fs::read_to_string(&config_path)?;
    let config: Config = toml::from_str(&config_data)?;

    let log_level = match config.logging.level.to_lowercase().as_str() {
        "trace" => Level::TRACE,
        "debug" => Level::DEBUG,
        "warn" => Level::WARN,
        "error" => Level::ERROR,
        _ => Level::INFO,
    };

    let subscriber = FmtSubscriber::builder()
        .with_max_level(log_level)
        .with_target(true)
        .with_thread_ids(false)
        .with_file(false)
        .with_line_number(false)
        .finish();
    tracing::subscriber::set_global_default(subscriber)?;

    let vault_key =
        std::env::var("VAULT_KEY").unwrap_or_else(|_| config.vault_key.clone());
    if vault_key.is_empty() {
        warn!("WARNING: vault_key is empty — accepting all connections!");
    }
    configure_auth(vault_key.clone());

    let state = AppState::new(&config).await?;

    let app = Router::new()
        .route("/health", get(health))
        .route("/snapshot", get(get_snapshot))
        .route("/blob/:hash", get(get_blob))
        .route("/blob", post(post_blob))
        .layer(CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any))
        .layer(TimeoutLayer::new(Duration::from_secs(30)))
        .with_state(state.clone());

    let addr: SocketAddr = config.listen_addr.parse()?;
    // WebSocket on port 8081 to avoid conflict with HTTP on 8080
    let ws_addr: SocketAddr = if addr.port() == 8080 {
        "0.0.0.0:8081".parse().unwrap()
    } else {
        SocketAddr::new(addr.ip(), addr.port() + 1)
    };

    // HTTP server on port 8080
    tokio::spawn({
        let http_app = app;
        let http_addr = addr;
        async move {
            let listener = TcpListener::bind(http_addr).await.unwrap();
            info!(addr = %http_addr, "HTTP server listening");
            axum::serve(listener, http_app).await.ok();
        }
    });

    // WebSocket server on port 8081
    let relay = state.relay.clone();
    let vk = vault_key;
    let ws_listener = TcpListener::bind(ws_addr).await?;
    info!(addr = %ws_addr, "WebSocket server listening");
    info!(addr = %addr, "obsidian-sync-server starting");

    tokio::select! {
        _ = async {
            loop {
                match ws_listener.accept().await {
                    Ok((stream, remote_addr)) => {
                        let relay = relay.clone();
                        let vk = vk.clone();
                        tokio::spawn(async move {
                            match tokio_tungstenite::accept_async(stream).await {
                                Ok(ws_stream) => {
                                    relay.handle_websocket(ws_stream, vk).await;
                                }
                                Err(e) => {
                                    error!(err = %e, addr = %remote_addr, "WS handshake error");
                                }
                            }
                        });
                    }
                    Err(e) => {
                        error!(err = %e, "TCP accept error");
                    }
                }
            }
        } => {}
        _ = signal::ctrl_c() => {
            info!("shutdown signal received");
        }
    }

    if let Some(gb) = &state.git_backup {
        gb.stop();
    }
    info!("server stopped");
    Ok(())
}