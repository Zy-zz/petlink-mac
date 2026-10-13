use crate::{
    protocol::{now, Result},
    store::write_json,
};
use futures_util::StreamExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{symlink, OpenOptionsExt, PermissionsExt},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const REPO: &str = "Zy-zz/petlink-mac";
const API: &str = "https://api.github.com/repos/Zy-zz/petlink-mac/releases/latest";
const MAX_ZIP: u64 = 512 * 1024 * 1024;
#[derive(Clone, Debug)]
pub struct Asset {
    pub version: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
}
pub fn newer(a: &str, b: &str) -> Result<bool> {
    fn parts(s: &str) -> Result<Vec<u64>> {
        let p: Vec<_> = s.split('.').collect();
        if p.len() != 3
            || p.iter()
                .any(|s| s.is_empty() || !s.bytes().all(|c| c.is_ascii_digit()))
        {
            return Err("更新版本号无效。".into());
        }
        p.into_iter()
            .map(|s| s.parse().map_err(|_| "更新版本号无效。".into()))
            .collect()
    }
    Ok(parts(a)? > parts(b)?)
}
pub fn release_asset(release: &Value, current: &str) -> Result<Option<Asset>> {
    if release["draft"] == true || release["prerelease"] == true {
        return Err("只支持正式发布的更新。".into());
    }
    let version = release["tag_name"]
        .as_str()
        .and_then(|s| s.strip_prefix('v'))
        .ok_or("更新版本号无效。")?;
    if !newer(version, current)? {
        return Ok(None);
    }
    let name = format!("PetLink-{version}-mac-arm64.zip");
    let asset = release["assets"]
        .as_array()
        .and_then(|a| a.iter().find(|a| a["name"] == name))
        .ok_or("更新包不存在。")?;
    let url = format!("https://github.com/{REPO}/releases/download/v{version}/{name}");
    let digest = asset["digest"]
        .as_str()
        .and_then(|s| s.strip_prefix("sha256:"))
        .ok_or("更新包缺少 GitHub SHA-256。")?;
    let size = asset["size"].as_u64().ok_or("更新包大小无效。")?;
    if asset["browser_download_url"] != url
        || !crate::protocol::hex32(digest)
        || size == 0
        || size > MAX_ZIP
    {
        return Err("更新包校验或下载信息无效。".into());
    }
    Ok(Some(Asset {
        version: version.into(),
        url,
        sha256: digest.into(),
        size,
    }))
}
async fn request(input: &str, timeout: Duration) -> Result<reqwest::Response> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())?;
    let mut url = url::Url::parse(input).map_err(|e| e.to_string())?;
    for _ in 0..6 {
        if url.scheme() != "https"
            || !matches!(
                url.host_str(),
                Some(
                    "api.github.com"
                        | "github.com"
                        | "release-assets.githubusercontent.com"
                        | "objects.githubusercontent.com"
                )
            )
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some_and(|p| p != 443)
        {
            return Err("更新地址不属于 GitHub。".into());
        }
        let response = client
            .get(url.clone())
            .header("User-Agent", "PetLink")
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
            let next = response
                .headers()
                .get("location")
                .and_then(|h| h.to_str().ok())
                .ok_or("更新重定向无效。")?;
            url = url.join(next).map_err(|e| e.to_string())?;
            continue;
        }
        if !response.status().is_success() {
            return Err(format!("GitHub 更新请求失败（{}）。", response.status()));
        }
        return Ok(response);
    }
    Err("更新地址重定向次数过多。".into())
}
pub async fn download(asset: &Asset, path: &Path, progress: impl Fn(u64)) -> Result<()> {
    let response = request(&asset.url, Duration::from_secs(900)).await?;
    let mut stream = response.bytes_stream();
    let mut hash = Sha256::new();
    let mut count = 0u64;
    let mut last = Instant::now();
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| e.to_string())?;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        count += chunk.len() as u64;
        if count > asset.size || count > MAX_ZIP {
            return Err("更新包大小与 GitHub 发布信息不符。".into());
        }
        hash.update(&chunk);
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        if last.elapsed() > Duration::from_millis(400) {
            progress(count * 100 / asset.size);
            last = Instant::now();
        }
    }
    file.sync_all().map_err(|e| e.to_string())?;
    if count != asset.size || hex::encode(hash.finalize()) != asset.sha256 {
        return Err("更新包 SHA-256 校验失败，已取消安装。".into());
    }
    Ok(())
}
fn contained_link(root: &Path, path: &Path, target: &Path) -> bool {
    if target.is_absolute() {
        return false;
    }
    let mut relative = path
        .parent()
        .unwrap()
        .strip_prefix(root)
        .unwrap()
        .to_path_buf();
    for c in target.components() {
        match c {
            Component::Normal(n) => relative.push(n),
            Component::CurDir => {}
            Component::ParentDir => {
                if !relative.pop() {
                    return false;
                }
            }
            _ => return false,
        }
    }
    true
}
pub fn unpack(archive: &Path, directory: &Path) -> Result<PathBuf> {
    let mut zip = zip::ZipArchive::new(File::open(archive).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if zip.len() > 20000 {
        return Err("更新 ZIP 内容过大。".into());
    }
    let mut total = 0u64;
    let mut links = Vec::new();
    let root = directory.join("PetLink.app");
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    for n in 0..zip.len() {
        let mut entry = zip.by_index(n).map_err(|e| e.to_string())?;
        total = total.checked_add(entry.size()).ok_or("ZIP 大小无效。")?;
        if total > 2 * 1024 * 1024 * 1024 {
            return Err("更新 ZIP 内容过大。".into());
        }
        let relative = entry.enclosed_name().ok_or("更新 ZIP 路径越界。")?;
        if relative
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err("更新 ZIP 路径无效。".into());
        }
        let first = relative.components().next().ok_or("更新 ZIP 路径无效。")?;
        if first.as_os_str() != "PetLink.app" && first.as_os_str() != "__MACOSX" {
            return Err("更新 ZIP 内容无效。".into());
        }
        let path = directory.join(&relative);
        let mode = entry.unix_mode().unwrap_or(0o100644);
        let kind = mode & 0o170000;
        if entry.is_symlink() {
            if !path.starts_with(&root) || path == root || entry.size() > 4096 {
                return Err("更新 ZIP 符号链接无效。".into());
            }
            let mut target = String::new();
            entry
                .read_to_string(&mut target)
                .map_err(|e| e.to_string())?;
            let target = PathBuf::from(target);
            if !contained_link(&root, &path, &target) {
                return Err("更新应用包含越界符号链接。".into());
            }
            links.push((path, target));
        } else if entry.is_dir() {
            fs::create_dir_all(path).map_err(|e| e.to_string())?;
        } else {
            if kind != 0 && kind != 0o100000 {
                return Err("更新 ZIP 包含特殊文件。".into());
            }
            fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(mode & 0o777)
                .open(&path)
                .map_err(|e| e.to_string())?;
            let expected = entry.size();
            let copied = std::io::copy(&mut entry.take(expected.saturating_add(1)), &mut file)
                .map_err(|e| e.to_string())?;
            if copied != expected {
                return Err("更新 ZIP 文件大小无效。".into());
            }
        }
    }
    // Extract ordinary files first. No archive symlink can redirect a file write.
    for (path, target) in &links {
        let mut parent = directory.to_path_buf();
        for part in path
            .parent()
            .unwrap()
            .strip_prefix(directory)
            .map_err(|e| e.to_string())?
            .components()
        {
            parent.push(part.as_os_str());
            if fs::symlink_metadata(&parent).is_ok_and(|m| m.file_type().is_symlink()) {
                return Err("更新 ZIP 链接目录无效。".into());
            }
        }
        fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        symlink(target, path).map_err(|e| e.to_string())?;
    }
    let canonical = root.canonicalize().map_err(|e| e.to_string())?;
    if fs::symlink_metadata(&root)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("更新应用不能是符号链接。".into());
    }
    for (path, _) in links {
        if !path
            .canonicalize()
            .map_err(|e| e.to_string())?
            .starts_with(&canonical)
        {
            return Err("更新应用包含越界符号链接。".into());
        }
    }
    Ok(root)
}
fn run(command: &str, args: &[&str]) -> Result<std::process::Output> {
    // File-backed output avoids pipe deadlocks while enforcing a bounded command timeout.
    let stdout = tempfile::tempfile().map_err(|e| e.to_string())?;
    let stderr = tempfile::tempfile().map_err(|e| e.to_string())?;
    let mut child = Command::new(command)
        .args(args)
        .stdout(stdout.try_clone().map_err(|e| e.to_string())?)
        .stderr(stderr.try_clone().map_err(|e| e.to_string())?)
        .spawn()
        .map_err(|e| e.to_string())?;
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if started.elapsed() > Duration::from_secs(60) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("验证命令超时。".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    use std::io::{Seek, SeekFrom};
    let mut out = stdout;
    let mut err = stderr;
    out.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    err.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut output = std::process::Output {
        status,
        stdout: Vec::new(),
        stderr: Vec::new(),
    };
    out.take(1024 * 1024)
        .read_to_end(&mut output.stdout)
        .map_err(|e| e.to_string())?;
    err.take(1024 * 1024)
        .read_to_end(&mut output.stderr)
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!(
            "{} 验证失败：{}",
            command,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(output)
}
fn signature(bundle: &Path) -> Result<(bool, Option<String>, bool)> {
    let output = run(
        "/usr/bin/codesign",
        &["-dv", "--verbose=4", bundle.to_str().ok_or("路径无效")?],
    )?;
    let s = String::from_utf8_lossy(&output.stderr);
    Ok((
        s.lines()
            .any(|l| l.starts_with("Authority=Developer ID Application:")),
        s.lines()
            .find_map(|l| l.strip_prefix("TeamIdentifier=").map(str::to_string)),
        s.lines().any(|l| l == "Signature=adhoc"),
    ))
}
pub fn verify_bundle(bundle: &Path, version: &str, installed: &Path) -> Result<bool> {
    let b = bundle.to_str().ok_or("路径无效")?;
    let info = run(
        "/usr/bin/plutil",
        &[
            "-convert",
            "json",
            "-o",
            "-",
            bundle
                .join("Contents/Info.plist")
                .to_str()
                .ok_or("路径无效")?,
        ],
    )?;
    let info: Value = serde_json::from_slice(&info.stdout).map_err(|e| e.to_string())?;
    let exe = info["CFBundleExecutable"]
        .as_str()
        .ok_or("应用执行文件无效。")?;
    if info["CFBundleIdentifier"] != "app.petlink.mac"
        || info["CFBundleShortVersionString"] != version
        || info["CFBundleVersion"] != version
        || !matches!(exe, "petlink" | "PetLink" | "Electron")
    {
        return Err("更新包身份或版本与发布信息不符。".into());
    }
    run(
        "/usr/bin/lipo",
        &[
            bundle
                .join("Contents/MacOS")
                .join(exe)
                .to_str()
                .ok_or("路径无效")?,
            "-verify_arch",
            "arm64",
        ],
    )?;
    run("/usr/bin/codesign", &["--verify", "--deep", "--strict", b])?;
    let before = signature(installed)?;
    let after = signature(bundle)?;
    if before.0 && (!after.0 || after.1 != before.1) {
        return Err("更新签名与已安装应用的开发者不一致。".into());
    }
    if after.0 {
        run("/usr/bin/xcrun", &["stapler", "validate", b])?;
        run("/usr/sbin/spctl", &["--assess", "--type", "execute", b])?;
    } else if !after.2 {
        return Err("更新包没有有效签名。".into());
    }
    run(
        "/usr/bin/xattr",
        &[
            "-w",
            "com.apple.quarantine",
            &format!("0001;{:x};PetLink;", now() / 1000),
            b,
        ],
    )?;
    Ok(after.0)
}
struct Inner {
    state: Value,
    asset: Option<Asset>,
    stage: Option<tempfile::TempDir>,
    candidate: Option<PathBuf>,
}
pub struct Updater {
    inner: Mutex<Inner>,
    bundle: Option<PathBuf>,
    profile: PathBuf,
    changed: Box<dyn Fn() + Send + Sync>,
}
impl Updater {
    pub fn new(
        bundle: Option<PathBuf>,
        profile: PathBuf,
        changed: Box<dyn Fn() + Send + Sync>,
    ) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                state: json!({"phase":"idle","current":env!("CARGO_PKG_VERSION")}),
                asset: None,
                stage: None,
                candidate: None,
            }),
            bundle,
            profile,
            changed,
        })
    }
    pub fn state(&self) -> Value {
        self.inner.lock().unwrap().state.clone()
    }
    fn set(&self, fields: Value) -> Value {
        let state = {
            let mut i = self.inner.lock().unwrap();
            for (k, v) in fields.as_object().unwrap() {
                i.state[k] = v.clone();
            }
            i.state.clone()
        };
        (self.changed)();
        state
    }
    fn begin(&self, expected: Option<&str>, phase: &str) -> Result<()> {
        let mut i = self.inner.lock().unwrap();
        let old = i.state["phase"].as_str().unwrap_or("idle");
        if self.bundle.is_none() {
            return Err("请从已安装的 Apple Silicon Mac 应用中更新。".into());
        }
        if matches!(old, "checking" | "downloading" | "installing")
            || expected.is_some_and(|e| e != old)
        {
            return Err("更新正在进行，或请先检查可用更新。".into());
        }
        i.state["phase"] = json!(phase);
        i.state["error"] = json!("");
        drop(i);
        (self.changed)();
        Ok(())
    }
    pub async fn check(&self) -> Result<Value> {
        self.begin(None, "checking")?;
        {
            let mut i = self.inner.lock().unwrap();
            i.stage = None;
            i.asset = None;
            i.candidate = None;
        }
        let result=async {
            let response=request(API,Duration::from_secs(60)).await?;let mut stream=response.bytes_stream();let mut body=Vec::new();
            while let Some(chunk)=stream.next().await {let chunk=chunk.map_err(|e|e.to_string())?;if body.len()+chunk.len()>1024*1024{return Err("GitHub 更新信息过大。".into());}body.extend_from_slice(&chunk);}
            let asset=release_asset(&serde_json::from_slice(&body).map_err(|e|e.to_string())?,env!("CARGO_PKG_VERSION"))?;
            let version=asset.as_ref().map(|a|a.version.clone());self.inner.lock().unwrap().asset=asset;
            Ok(self.set(json!({"phase":if version.is_some(){"available"}else{"current"},"available":version,"progress":0})))
        }.await;
        if let Err(e) = &result {
            self.set(json!({"phase":"error","error":e}));
        }
        result
    }
    pub async fn prepare(self: &Arc<Self>) -> Result<Value> {
        self.begin(Some("available"), "downloading")?;
        let result = async {
            let asset = self
                .inner
                .lock()
                .unwrap()
                .asset
                .clone()
                .ok_or("请先检查更新。")?;
            let bundle = self.bundle.as_ref().unwrap();
            if bundle.file_name().is_none_or(|s| s != "PetLink.app")
                || fs::symlink_metadata(bundle)
                    .map_err(|e| e.to_string())?
                    .file_type()
                    .is_symlink()
            {
                return Err("请先把 PetLink 安装到应用程序目录。".into());
            }
            let stage = tempfile::Builder::new()
                .prefix(".petlink-update-")
                .tempdir_in(bundle.parent().unwrap())
                .map_err(|e| e.to_string())?;
            fs::set_permissions(stage.path(), fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
            let archive = stage.path().join("update.zip");
            download(&asset, &archive, |progress| {
                self.set(json!({"progress":progress}));
            })
            .await?;
            let directory = stage.path().join("unpacked");
            let installed = bundle.clone();
            let version = asset.version.clone();
            let (candidate, signed) = tokio::task::spawn_blocking(move || {
                let c = unpack(&archive, &directory)?;
                let s = verify_bundle(&c, &version, &installed)?;
                Ok::<_, String>((c, s))
            })
            .await
            .map_err(|e| e.to_string())??;
            fs::write(
                stage.path().join("install.sh"),
                include_str!("../install-update.sh"),
            )
            .map_err(|e| e.to_string())?;
            {
                let mut i = self.inner.lock().unwrap();
                i.stage = Some(stage);
                i.candidate = Some(candidate);
            }
            Ok(self.set(json!({"phase":"ready","progress":100,"signed":signed})))
        }
        .await;
        if let Err(e) = &result {
            self.set(json!({"phase":"error","error":e}));
        }
        result
    }
    pub async fn install(&self) -> Result<Value> {
        self.begin(Some("ready"), "installing")?;
        let (candidate, version, stage) = {
            let i = self.inner.lock().unwrap();
            (
                i.candidate.clone().ok_or("更新未准备好。")?,
                i.asset.as_ref().ok_or("更新未准备好。")?.version.clone(),
                i.stage
                    .as_ref()
                    .ok_or("更新未准备好。")?
                    .path()
                    .to_path_buf(),
            )
        };
        let bundle = self.bundle.as_ref().unwrap().clone();
        let b = bundle.clone();
        let result = async {
            tokio::task::spawn_blocking(move || verify_bundle(&candidate, &version, &b))
                .await
                .map_err(|e| e.to_string())??;
            let i = self.inner.lock().unwrap();
            let candidate = i.candidate.as_ref().unwrap();
            let version = &i.asset.as_ref().unwrap().version;
            write_json(
                &self.profile.join("pending-update.json"),
                &json!({"bundle":bundle,"stage":stage,"version":version}),
            )?;
            let log = OpenOptions::new()
                .create(true)
                .append(true)
                .mode(0o600)
                .open(stage.join("install.log"))
                .map_err(|e| e.to_string())?;
            Command::new("/usr/bin/nohup")
                .arg("/bin/sh")
                .arg(stage.join("install.sh"))
                .arg(std::process::id().to_string())
                .arg(&bundle)
                .arg(candidate)
                .arg(&stage)
                .stdin(Stdio::null())
                .stdout(log.try_clone().map_err(|e| e.to_string())?)
                .stderr(log)
                .spawn()
                .map_err(|e| e.to_string())?;
            drop(i);
            // The new process owns this directory and removes it after its configuration loads.
            if let Some(stage) = self.inner.lock().unwrap().stage.take() {
                let _ = stage.keep();
            }
            Ok(self.state())
        }
        .await;
        if let Err(e) = &result {
            self.set(json!({"phase":"ready","error":e}));
        }
        result
    }
}
pub fn installed_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let bundle = exe.parent()?.parent()?.parent()?;
    (bundle.file_name()? == "PetLink.app").then(|| bundle.to_path_buf())
}
pub fn cleanup_installed(bundle: &Path, profile: &Path) {
    let marker = profile.join("pending-update.json");
    let cleanup = (|| -> Result<()> {
        let p: Value = serde_json::from_reader(File::open(&marker).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        let stage = PathBuf::from(p["stage"].as_str().ok_or("路径无效")?);
        if p["bundle"] != json!(bundle)
            || p["version"] != env!("CARGO_PKG_VERSION")
            || stage.parent() != bundle.parent()
            || stage.file_name().and_then(|s| s.to_str()).is_none_or(|s| {
                !s.starts_with(".petlink-update-")
                    || s[16..].chars().any(|c| !c.is_ascii_alphanumeric())
            })
        {
            return Err("更新标记无效".into());
        }
        if stage.exists() {
            if fs::symlink_metadata(&stage)
                .map_err(|e| e.to_string())?
                .file_type()
                .is_symlink()
            {
                return Err("路径无效".into());
            }
            fs::remove_dir_all(stage).map_err(|e| e.to_string())?;
        }
        fs::remove_file(marker).map_err(|e| e.to_string())?;
        Ok(())
    })();
    let _ = cleanup;
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn release_validation_and_unsafe_zips() {
        assert!(newer("0.5.0", "0.4.1").unwrap());
        assert!(!newer("0.4.1", "0.5.0").unwrap());
        assert!(newer("v0.5.0", "0.4.1").is_err());
        let mut release = json!({"tag_name":"v0.6.0","draft":false,"assets":[{"name":"PetLink-0.6.0-mac-arm64.zip","browser_download_url":"https://github.com/Zy-zz/petlink-mac/releases/download/v0.6.0/PetLink-0.6.0-mac-arm64.zip","digest":format!("sha256:{}","a".repeat(64)),"size":123}]});
        assert!(release_asset(&release, "0.5.0").unwrap().is_some());
        release["assets"][0]["browser_download_url"] = json!("https://evil.invalid/update.zip");
        assert!(release_asset(&release, "0.5.0").is_err());
        let dir = tempfile::tempdir().unwrap();
        for name in ["update-traversal.zip", "update-symlink.zip"] {
            let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../test/fixtures")
                .join(name);
            assert!(unpack(&fixture, &dir.path().join(name)).is_err());
        }
    }
    #[test]
    fn installer_swaps_and_rolls_back() {
        for succeed in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let target = dir.path().join("PetLink.app");
            let candidate = dir.path().join("new.app");
            let stage = dir.path().join("stage");
            for path in [&target, &candidate, &stage] {
                fs::create_dir(path).unwrap();
            }
            fs::write(target.join("version"), "old").unwrap();
            fs::write(candidate.join("version"), "new").unwrap();
            let script = include_str!("../install-update.sh").replace(
                "/usr/bin/open",
                if succeed {
                    "/usr/bin/true"
                } else {
                    "/usr/bin/false"
                },
            );
            let installer = dir.path().join("install.sh");
            fs::write(&installer, script).unwrap();
            let status = Command::new("/bin/sh")
                .arg(installer)
                .arg("999999999")
                .arg(&target)
                .arg(&candidate)
                .arg(&stage)
                .status()
                .unwrap();
            assert_eq!(status.success(), succeed);
            assert_eq!(
                fs::read_to_string(target.join("version")).unwrap(),
                if succeed { "new" } else { "old" }
            );
            if succeed {
                assert_eq!(
                    fs::read_to_string(stage.join("previous.app/version")).unwrap(),
                    "old"
                );
            }
        }
    }
}
