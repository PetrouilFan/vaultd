use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{debug, error};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Operation {
    pub seq: i64,
    pub timestamp_unix_ms: i64,
    pub client_id: String,
    pub device_name: String,
    pub op_type: String,
    pub path: String,
    pub old_path: Option<String>,
    pub vector_clock: String,
    pub content_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tombstone {
    pub path: String,
    pub deleted_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestEntry {
    pub path: String,
    pub hash: String,
    pub updated_at_ms: i64,
}

pub struct Oplog {
    conn: Arc<Mutex<Connection>>,
}

impl Oplog {
    pub fn open(path: &Path) -> Result<Self, rusqlite::Error> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;
             CREATE TABLE IF NOT EXISTS oplog (
                 seq INTEGER PRIMARY KEY AUTOINCREMENT,
                 timestamp_unix_ms INTEGER NOT NULL,
                 client_id TEXT NOT NULL,
                 device_name TEXT NOT NULL,
                 op_type TEXT NOT NULL,
                 path TEXT NOT NULL,
                 old_path TEXT,
                 vector_clock TEXT NOT NULL,
                 content_hash TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_oplog_path ON oplog(path);
             CREATE INDEX IF NOT EXISTS idx_oplog_timestamp ON oplog(timestamp_unix_ms);",
        )?;
        debug!("oplog initialized");
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub async fn append_op(&self, op: NewOperation) -> Result<i64, rusqlite::Error> {
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO oplog (timestamp_unix_ms, client_id, device_name, op_type, path, old_path, vector_clock, content_hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                op.timestamp_unix_ms,
                op.client_id,
                op.device_name,
                op.op_type,
                op.path,
                op.old_path,
                op.vector_clock,
                op.content_hash,
            ],
        )?;
        let seq = conn.last_insert_rowid();
        debug!(seq, path = op.path, "oplog appended");
        Ok(seq)
    }

    pub async fn get_tombstones(&self) -> Result<Vec<Tombstone>, rusqlite::Error> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT path, MAX(timestamp_unix_ms) as deleted_at_ms
             FROM oplog WHERE op_type = 'DELETE'
             GROUP BY path",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Tombstone {
                path: row.get(0)?,
                deleted_at_ms: row.get(1)?,
            })
        })?;
        let mut tombstones = Vec::new();
        for row in rows {
            tombstones.push(row?);
        }
        Ok(tombstones)
    }

    pub async fn get_since(&self, seq: i64) -> Result<Vec<Operation>, rusqlite::Error> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT seq, timestamp_unix_ms, client_id, device_name, op_type, path, old_path, vector_clock, content_hash
             FROM oplog WHERE seq > ?1 ORDER BY seq",
        )?;
        let rows = stmt.query_map([seq], |row| {
            Ok(Operation {
                seq: row.get(0)?,
                timestamp_unix_ms: row.get(1)?,
                client_id: row.get(2)?,
                device_name: row.get(3)?,
                op_type: row.get(4)?,
                path: row.get(5)?,
                old_path: row.get(6)?,
                vector_clock: row.get(7)?,
                content_hash: row.get(8)?,
            })
        })?;
        let mut ops = Vec::new();
        for row in rows {
            ops.push(row?);
        }
        Ok(ops)
    }

    pub async fn get_manifest(&self) -> Result<Vec<ManifestEntry>, rusqlite::Error> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT path, content_hash, MAX(timestamp_unix_ms) as updated_at_ms
             FROM oplog WHERE op_type = 'UPDATE' AND content_hash IS NOT NULL
             GROUP BY path",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(ManifestEntry {
                path: row.get(0)?,
                hash: row.get(1)?,
                updated_at_ms: row.get(2)?,
            })
        })?;
        let mut manifest = Vec::new();
        for row in rows {
            manifest.push(row?);
        }
        Ok(manifest)
    }

    pub async fn get_last_seq(&self) -> Result<i64, rusqlite::Error> {
        let conn = self.conn.lock().await;
        conn.query_row("SELECT MAX(seq) FROM oplog", [], |row| row.get(0))
    }
}

#[derive(Debug, Clone)]
pub struct NewOperation {
    pub timestamp_unix_ms: i64,
    pub client_id: String,
    pub device_name: String,
    pub op_type: String,
    pub path: String,
    pub old_path: Option<String>,
    pub vector_clock: String,
    pub content_hash: Option<String>,
}