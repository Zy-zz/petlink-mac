use crate::protocol::*;
use fs2::FileExt;
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

pub struct Store {
    pub profile: PathBuf,
    pub config: Value,
    pub history: Vec<Value>,
    pub latest: Option<Value>,
    pub unread: u64,
    pub muted: bool,
    pub history_version: u64,
    _lock: File,
}
pub fn write_json(path: &Path, value: &Value) -> Result<()> {
    let mut temporary = tempfile::NamedTempFile::new_in(path.parent().ok_or("配置路径无效")?)
        .map_err(|e| e.to_string())?;
    temporary
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut temporary, value).map_err(|e| e.to_string())?;
    temporary.flush().map_err(|e| e.to_string())?;
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    temporary.persist(path).map_err(|e| e.to_string())?;
    File::open(path.parent().unwrap())
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn read_json(path: &Path, fallback: Value, limit: u64) -> Result<Value> {
    if !path.exists() {
        return Ok(fallback);
    }
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > limit {
        return Err(format!("{} 格式无效，已保留原文件。", path.display()));
    }
    serde_json::from_reader(File::open(path).map_err(|e| e.to_string())?).map_err(|_| {
        format!(
            "{} 无法读取，已保留原文件，请先备份再重试。",
            path.display()
        )
    })
}
pub fn default_pet() -> Value {
    json!({"kind":"cat","src":"pet.svg","name":"像素小猫","pixel":true})
}
impl Store {
    pub fn load(profile: PathBuf) -> Result<Self> {
        fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
        fs::set_permissions(&profile, fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .mode(0o600)
            .open(profile.join("instance.lock"))
            .map_err(|e| e.to_string())?;
        lock.try_lock_exclusive()
            .map_err(|_| "这个配置目录已有 PetLink 在运行，请先退出旧版。")?;
        let config = read_json(
            &profile.join("config.json"),
            json!({"identity":Identity::create(),"name":"","invite":null,"peerPubkey":null,"peerName":""}),
            4 * 1024 * 1024,
        )?;
        let identity: Identity = serde_json::from_value(config["identity"].clone())
            .map_err(|_| "本机配置格式无效，已保留原文件。")?;
        identity.validate()?;
        if let Some(invite) = config["invite"].as_str() {
            Invite::parse(invite)?;
        }
        if !config["invite"].is_null() && !config["invite"].is_string() {
            return Err("本机邀请配置无效，已保留原文件。".into());
        }
        if let Some(pk) = config["peerPubkey"].as_str() {
            pubkey(pk)?;
        }
        let mut history = read_json(&profile.join("history.json"), json!([]), 32 * 1024 * 1024)?
            .as_array()
            .cloned()
            .ok_or("本机记录格式无效，已保留原文件。")?;
        if history.len() > 40
            || history
                .iter()
                .map(|m| m["attachment"]["data"].as_str().map_or(0, str::len))
                .sum::<usize>()
                > 24 * 1024 * 1024
        {
            return Err("本机记录超过大小限制，已保留原文件。".into());
        }
        let interrupted = history.iter().any(|m| m["throwState"] == "processing");
        if interrupted {
            // Desktop objects are session-only; an interrupted creation can be safely offered again.
            for message in &mut history {
                if message["throwState"] == "processing" {
                    message["throwState"] = json!("pending");
                }
            }
            write_json(&profile.join("history.json"), &json!(history))?;
        }
        let store = Self {
            profile,
            config,
            history,
            latest: None,
            unread: 0,
            muted: false,
            history_version: 0,
            _lock: lock,
        };
        write_json(&store.profile.join("config.json"), &store.config)?;
        Ok(store)
    }
    pub fn identity(&self) -> Identity {
        serde_json::from_value(self.config["identity"].clone()).unwrap()
    }
    pub fn set_config(&mut self, config: Value) -> Result<()> {
        write_json(&self.profile.join("config.json"), &config)?;
        self.config = config;
        Ok(())
    }
    pub fn pair(&mut self, pk: &str, name: &str) -> Result<()> {
        let mut config = self.config.clone();
        config["peerPubkey"] = json!(pk);
        config["peerName"] = json!(name);
        self.set_config(config)
    }
    pub fn set_history(&mut self, history: Vec<Value>) -> Result<()> {
        write_json(&self.profile.join("history.json"), &json!(history))?;
        self.history = history;
        self.history_version += 1;
        Ok(())
    }
    pub fn remember(&mut self, mut message: Value, direction: &str) -> Result<()> {
        if self.history.iter().any(|m| m["id"] == message["id"]) {
            return Ok(());
        }
        message["direction"] = json!(direction);
        if message.get("placement").is_some() {
            message["throwState"] = json!("pending");
        }
        let mut history = self.history.clone();
        history.push(message.clone());
        let mut bytes = history
            .iter()
            .map(|m| m["attachment"]["data"].as_str().map_or(0, str::len))
            .sum::<usize>();
        while history.len() > 40 || bytes > 24 * 1024 * 1024 {
            bytes -= history.remove(0)["attachment"]["data"]
                .as_str()
                .map_or(0, str::len);
        }
        if let Some(d) = message.get("throwDecision") {
            for request in &mut history {
                if request["id"] == d["requestId"]
                    && request["direction"] == "outgoing"
                    && request.get("placement").is_some()
                    && request["throwState"] == "pending"
                {
                    request["throwState"] = json!(if d["accepted"] == true {
                        "accepted"
                    } else {
                        "rejected"
                    });
                }
            }
        }
        self.set_history(history)?;
        if direction == "incoming" {
            self.latest = Some(message);
            self.unread += 1;
        }
        Ok(())
    }
    pub fn state(
        &self,
        status: Value,
        update: Value,
        with_history: bool,
        with_invite: bool,
    ) -> Value {
        let mut state = json!({"name":self.config["name"],"configured":self.config["invite"].is_string(),"status":status,
            "unread":self.unread,"latest":self.latest,"muted":self.muted,"version":env!("CARGO_PKG_VERSION"),
            "pet":self.config.get("pet").cloned().unwrap_or_else(default_pet),"update":update});
        if with_history {
            state["history"] = json!(self.history);
        }
        if with_invite {
            state["invite"] = if self.config["peerPubkey"].is_null() {
                self.config["invite"].clone()
            } else {
                Value::Null
            };
        }
        state
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn migration_retention_and_fail_closed() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::load(dir.path().to_path_buf()).unwrap();
        let identity = store.identity();
        let invite = Invite::create(&identity);
        let mut cfg = store.config.clone();
        cfg["invite"] = json!(invite);
        cfg["pet"] = json!({"kind":"bunny","src":"bunny.svg"});
        store.set_config(cfg).unwrap();
        for n in 0..41 {
            store
                .remember(json!({"id":n,"text":"hi"}), "incoming")
                .unwrap();
        }
        assert_eq!(store.history.len(), 40);
        assert_eq!(store.history[0]["id"], 1);
        assert!(Store::load(dir.path().to_path_buf()).is_err());
        drop(store);
        let store = Store::load(dir.path().to_path_buf()).unwrap();
        assert_eq!(store.identity().pubkey, identity.pubkey);
        assert_eq!(store.config["invite"], invite);
        assert_eq!(store.history.len(), 40);
        drop(store);
        fs::write(dir.path().join("history.json"), b"broken").unwrap();
        assert!(Store::load(dir.path().to_path_buf()).is_err());
        assert_eq!(
            fs::read(dir.path().join("history.json")).unwrap(),
            b"broken"
        );
        assert_eq!(
            fs::metadata(dir.path().join("config.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
