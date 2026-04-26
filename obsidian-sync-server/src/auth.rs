use once_cell::sync::Lazy;
use parking_lot::RwLock;
use tracing::warn;

static VAULT_KEY: Lazy<RwLock<Option<String>>> = Lazy::new(|| RwLock::new(None));

pub fn configure(key: String) {
    let mut guard = VAULT_KEY.write();
    *guard = Some(key);
}

pub fn validate_vault_key(key: &str) -> Result<(), AuthError> {
    let guard = VAULT_KEY.read();
    let expected = guard.as_ref().ok_or(AuthError::NotConfigured)?;
    if expected == key {
        Ok(())
    } else {
        Err(AuthError::InvalidKey)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("server vault key not configured")]
    NotConfigured,
    #[error("invalid vault key")]
    InvalidKey,
}

impl axum::response::IntoResponse for AuthError {
    fn into_response(self) -> axum::response::Response {
        (axum::http::StatusCode::UNAUTHORIZED, self.to_string()).into_response()
    }
}