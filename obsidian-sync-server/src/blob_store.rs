use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::fs;
use tokio::sync::RwLock;
use tracing::{debug, info};

pub struct BlobStore {
    base_path: PathBuf,
    path_index: Arc<RwLock<PathIndex>>,
}

#[derive(Default)]
struct PathIndex {
    index: HashMap<String, String>,
}

impl BlobStore {
    pub fn new(base_path: &Path) -> Result<Self, std::io::Error> {
        let base_path = base_path.to_path_buf();
        std::fs::create_dir_all(&base_path)?;
        let store = Self {
            base_path,
            path_index: Arc::new(RwLock::new(PathIndex::default())),
        };
        Ok(store)
    }

    pub async fn ensure_index_loaded(&self) -> Result<(), std::io::Error> {
        {
            let index = self.path_index.read().await;
            if !index.index.is_empty() {
                return Ok(());
            }
        }
        let mut index = self.path_index.write().await;
        if self.base_path.join(".path-index").exists() {
            if let Ok(data) = tokio::fs::read_to_string(self.base_path.join(".path-index")).await {
                if let Ok(entries) = serde_json::from_str::<Vec<(String, String)>>(&data) {
                    for (path, hash) in entries {
                        index.index.insert(path, hash);
                    }
                }
            }
        }
        Ok(())
    }

    async fn persist_index(&self) -> Result<(), std::io::Error> {
        let index = self.path_index.read().await;
        let entries: Vec<_> = index.index.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        let data = serde_json::to_string(&entries).unwrap();
        fs::write(self.base_path.join(".path-index"), data).await?;
        Ok(())
    }

    pub async fn store_blob(&self, data: &[u8]) -> Result<String, BlobError> {
        let hash = Self::compute_hash(data);
        if self.has_blob(&hash).await? {
            debug!(hash, "blob already exists (dedup)");
            return Ok(hash);
        }
        let subdir1 = &hash[0..2];
        let subdir2 = &hash[2..4];
        let dir = self.base_path.join(subdir1).join(subdir2);
        fs::create_dir_all(&dir).await.map_err(|e| BlobError::IoError(e.to_string()))?;
        let path = dir.join(&hash);
        fs::write(&path, data).await.map_err(|e| BlobError::IoError(e.to_string()))?;
        self.persist_index().await.map_err(|e| BlobError::IoError(e.to_string()))?;
        info!(hash, "blob stored");
        Ok(hash)
    }

    pub async fn get_blob(&self, hash: &str) -> Result<Vec<u8>, BlobError> {
        if hash.len() < 4 {
            return Err(BlobError::InvalidHash);
        }
        let subdir1 = &hash[0..2];
        let subdir2 = &hash[2..4];
        let path = self.base_path.join(subdir1).join(subdir2).join(hash);
        fs::read(&path).await.map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => BlobError::NotFound,
            _ => BlobError::IoError(e.to_string()),
        })
    }

    pub async fn has_blob(&self, hash: &str) -> Result<bool, BlobError> {
        if hash.len() < 4 {
            return Err(BlobError::InvalidHash);
        }
        let subdir1 = &hash[0..2];
        let subdir2 = &hash[2..4];
        let path = self.base_path.join(subdir1).join(subdir2).join(hash);
        Ok(path.exists())
    }

    pub async fn get_hash_for_path(&self, path: &str) -> Option<String> {
        let index = self.path_index.read().await;
        index.index.get(path).cloned()
    }

    pub async fn map_path_to_hash(&self, path: String, hash: String) {
        {
            let mut index = self.path_index.write().await;
            index.index.insert(path, hash);
        }
        let _ = self.persist_index().await;
    }
}

impl BlobStore {
    pub fn compute_hash(data: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(data);
        let result = hasher.finalize();
        hex::encode(result)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum BlobError {
    #[error("blob not found")]
    NotFound,
    #[error("invalid hash format")]
    InvalidHash,
    #[error("IO error: {0}")]
    IoError(String),
    #[error("hash mismatch")]
    HashMismatch,
}

impl From<std::io::Error> for BlobError {
    fn from(e: std::io::Error) -> Self {
        BlobError::IoError(e.to_string())
    }
}