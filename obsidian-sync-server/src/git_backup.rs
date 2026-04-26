use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tracing::{error, info, warn};

pub struct GitBackup {
    schedule: String,
    remote: String,
    branch: String,
    vault_mirror: String,
    author_name: String,
    author_email: String,
    stop_flag: Arc<AtomicBool>,
}

impl GitBackup {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        _enabled: bool,
        schedule: String,
        remote: String,
        branch: String,
        vault_mirror: String,
        author_name: String,
        author_email: String,
    ) -> Self {
        Self {
            schedule,
            remote,
            branch,
            vault_mirror,
            author_name,
            author_email,
            stop_flag: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn spawn(self: Arc<Self>) {
        if self.vault_mirror.is_empty() {
            warn!("vault_mirror not configured, git backup disabled");
            return;
        }
        let me = self.clone();
        std::thread::Builder::new()
            .name("git-backup".into())
            .spawn(move || {
                me.run_loop();
            })
            .expect("failed to spawn git backup thread");
        info!(schedule = %self.schedule, "git backup worker spawned");
    }

    fn run_loop(&self) {
        let parser: cron::Schedule = match std::str::FromStr::from_str(&self.schedule) {
            Ok(p) => p,
            Err(e) => {
                error!("invalid cron schedule: {}: {}", self.schedule, e);
                return;
            }
        };
        loop {
            if self.stop_flag.load(Ordering::SeqCst) {
                info!("git backup worker stopping");
                break;
            }
            let next = match parser.upcoming(chrono::Utc).next() {
                Some(n) => n,
                None => {
                    std::thread::sleep(Duration::from_secs(3600));
                    continue;
                }
            };
            let now = chrono::Utc::now();
            let delay = if next > now {
                (next - now).to_std().unwrap_or(Duration::from_secs(86400))
            } else {
                Duration::from_secs(86400)
            };
            std::thread::sleep(delay);
            if self.stop_flag.load(Ordering::SeqCst) {
                break;
            }
            if let Err(e) = self.run_backup() {
                error!(err = %e, "git backup failed");
            }
        }
    }

    fn run_backup(&self) -> Result<(), GitBackupError> {
        info!("starting git backup");
        let mirror_path = Path::new(&self.vault_mirror);
        if !mirror_path.exists() {
            std::fs::create_dir_all(mirror_path)
                .map_err(|e| GitBackupError::GitError(e.to_string()))?;
            Self::git_init(mirror_path)?;
        }
        if !mirror_path.join(".git").exists() {
            Self::git_init(mirror_path)?;
        }
        Self::git_add(mirror_path)?;
        if Self::git_has_changes(mirror_path)? {
            let timestamp = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S UTC").to_string();
            Self::git_commit(mirror_path, &timestamp, &self.author_name, &self.author_email)?;
            if !self.remote.is_empty() {
                if let Err(e) = Self::git_push(mirror_path, &self.remote, &self.branch) {
                    error!(err = %e, "git push failed");
                }
            }
        } else {
            info!("no changes to commit");
        }
        Ok(())
    }

    fn git_init(path: &Path) -> Result<(), GitBackupError> {
        let output = Command::new("git")
            .args(["init"])
            .current_dir(path)
            .output()
            .map_err(|e| GitBackupError::GitError(e.to_string()))?;
        if !output.status.success() {
            return Err(GitBackupError::GitError(String::from_utf8_lossy(&output.stderr).to_string()));
        }
        Ok(())
    }

    fn git_add(path: &Path) -> Result<(), GitBackupError> {
        let output = Command::new("git")
            .args(["add", "-A"])
            .current_dir(path)
            .output()
            .map_err(|e| GitBackupError::GitError(e.to_string()))?;
        if !output.status.success() {
            return Err(GitBackupError::GitError(String::from_utf8_lossy(&output.stderr).to_string()));
        }
        Ok(())
    }

    fn git_has_changes(path: &Path) -> Result<bool, GitBackupError> {
        let output = Command::new("git")
            .args(["diff", "--cached", "--quiet"])
            .current_dir(path)
            .output()
            .map_err(|e| GitBackupError::GitError(e.to_string()))?;
        Ok(!output.status.success())
    }

    fn git_commit(path: &Path, msg: &str, name: &str, email: &str) -> Result<(), GitBackupError> {
        let output = Command::new("git")
            .envs([
                ("GIT_AUTHOR_NAME", name),
                ("GIT_AUTHOR_EMAIL", email),
                ("GIT_COMMITTER_NAME", name),
                ("GIT_COMMITTER_EMAIL", email),
            ])
            .args(["commit", "-m", msg])
            .current_dir(path)
            .output()
            .map_err(|e| GitBackupError::GitError(e.to_string()))?;
        if !output.status.success() {
            return Err(GitBackupError::GitError(String::from_utf8_lossy(&output.stderr).to_string()));
        }
        info!("git commit created");
        Ok(())
    }

    fn git_push(path: &Path, remote: &str, branch: &str) -> Result<(), GitBackupError> {
        let output = Command::new("git")
            .args(["push", remote, branch])
            .current_dir(path)
            .output()
            .map_err(|e| GitBackupError::GitError(e.to_string()))?;
        if !output.status.success() {
            return Err(GitBackupError::GitError(String::from_utf8_lossy(&output.stderr).to_string()));
        }
        info!("git push succeeded");
        Ok(())
    }

    pub fn stop(&self) {
        self.stop_flag.store(true, Ordering::SeqCst);
    }
}

#[derive(Debug, thiserror::Error)]
pub enum GitBackupError {
    #[error("git error: {0}")]
    GitError(String),
}