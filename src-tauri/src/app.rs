use crate::{
    desktop::{self, Bounds},
    peer::{Callbacks, Peer},
    protocol::*,
    store::{default_pet, Store},
    updater::{self, Updater},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

struct Choice {
    tx: tokio::sync::oneshot::Sender<Option<Value>>,
    labels: Vec<String>,
}
struct Drag {
    bounds: Bounds,
    cursor: tauri::PhysicalPosition<f64>,
}
pub struct AppState {
    store: Arc<Mutex<Store>>,
    peer: Mutex<Option<Arc<Peer>>>,
    updater: Arc<Updater>,
    generation: AtomicU64,
    broadcast_pending: AtomicBool,
    history_sent: Mutex<HashMap<String, u64>>,
    objects: Mutex<HashMap<String, Value>>,
    choice: Mutex<Option<Choice>>,
    drag: Mutex<Option<Drag>>,
    walk_epoch: AtomicU64,
    walk_origin: Mutex<Option<Bounds>>,
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn win(app: &AppHandle, label: &str) -> Result<WebviewWindow> {
    app.get_webview_window(label)
        .ok_or_else(|| "窗口已关闭。".into())
}
fn peer(app: &AppHandle) -> Result<Arc<Peer>> {
    app.state::<AppState>()
        .peer
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "请先配对。".into())
}
fn notice(app: &AppHandle, message: String) {
    let _ = app.emit_to("composer", "notice", message);
}
fn request_broadcast(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    if state.broadcast_pending.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(80)).await;
        app.state::<AppState>()
            .broadcast_pending
            .store(false, Ordering::SeqCst);
        broadcast(&app);
    });
}
fn state(app: &AppHandle, label: &str, with_history: bool) -> Value {
    let s = app.state::<AppState>();
    let p = s.peer.lock().unwrap().clone();
    let status=p.map_or_else(||json!({"relayConnected":0,"peerOnline":false,"paired":false,"peerName":"","peerPubkey":null,"canThrow":false,"canQuickActions":false}),|p|p.status());
    let update = s.updater.state();
    let store = s.store.lock().unwrap();
    let mut result = store.state(status, update, with_history, label == "composer");
    if let Some(latest) = &store.latest {
        if let Some(current) = store.history.iter().find(|m| m["id"] == latest["id"]) {
            result["latest"] = current.clone();
        }
    }
    result
}
fn broadcast(app: &AppHandle) {
    let s = app.state::<AppState>();
    let version = s.store.lock().unwrap().history_version;
    for label in ["composer", "pet", "bubble"] {
        let include = label == "composer"
            && s.history_sent.lock().unwrap().get(label).copied() != Some(version);
        if app
            .emit_to(label, "state", state(app, label, include))
            .is_ok()
            && include
        {
            s.history_sent.lock().unwrap().insert(label.into(), version);
        }
    }
}
fn make_window(
    app: &AppHandle,
    label: &str,
    page: &str,
    b: Bounds,
    overlay: bool,
) -> Result<WebviewWindow> {
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App(page.into()))
        .title(if label == "composer" {
            "PetLink · 把话交给小伙伴"
        } else {
            "PetLink"
        })
        .inner_size(b.width, b.height)
        .position(b.x, b.y)
        .visible(false)
        .focused(false)
        .decorations(!overlay)
        .transparent(overlay)
        .shadow(!overlay)
        .resizable(!overlay)
        .always_on_top(overlay)
        .skip_taskbar(overlay)
        .visible_on_all_workspaces(overlay)
        .disable_drag_drop_handler()
        .on_navigation(|url| url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_page_load(|window, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                #[cfg(debug_assertions)]
                if std::env::var_os("PETLINK_UI_TEST").is_some() {
                    let profile = window
                        .state::<AppState>()
                        .store
                        .lock()
                        .unwrap()
                        .profile
                        .clone();
                    let _ = std::fs::write(
                        profile.join(format!("test-ready-{}", window.label())),
                        b"ready",
                    );
                }
                if window.label() == "composer" {
                    window
                        .state::<AppState>()
                        .history_sent
                        .lock()
                        .unwrap()
                        .remove("composer");
                }
                request_broadcast(window.app_handle());
            }
        })
        .build()
        .map_err(err)?;
    if overlay {
        desktop::overlay_native(&window)?;
    }
    if label == "composer" {
        let w = window.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = w.hide();
            }
        });
    } else if label == "pet" {
        let app = app.clone();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Moved(_)) {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = position_bubble(&app).await;
                });
            }
        });
    } else if label.starts_with("object-") {
        let app = app.clone();
        let label = label.to_string();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                app.state::<AppState>()
                    .objects
                    .lock()
                    .unwrap()
                    .remove(&label);
            }
        });
    } else if label.starts_with("target-") {
        let app = app.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                finish_choice(&app, None);
            }
        });
    }
    Ok(window)
}
async fn position_bubble(app: &AppHandle) -> Result<()> {
    let p = desktop::bounds(&win(app, "pet")?)?;
    let bubble = win(app, "bubble")?;
    let height = desktop::bounds(&bubble)?.height;
    let areas = desktop::areas(app).await?;
    let area = desktop::matching(p, &areas);
    let x = (p.x + p.width - 360.0).clamp(
        area.x + 8.0,
        (area.x + area.width - 368.0).max(area.x + 8.0),
    );
    let y = (p.y - height + 16.0).clamp(
        area.y + 8.0,
        (area.y + area.height - height - 8.0).max(area.y + 8.0),
    );
    bubble
        .set_position(tauri::LogicalPosition::new(x.round(), y.round()))
        .map_err(err)
}
fn mark_read(app: &AppHandle) {
    {
        let s = app.state::<AppState>();
        let mut store = s.store.lock().unwrap();
        store.unread = 0;
    }
    if let Ok(w) = win(app, "bubble") {
        let _ = w.hide();
    }
    request_broadcast(app);
}
fn show_composer(app: &AppHandle) {
    if let Ok(w) = win(app, "composer") {
        let _ = w.show();
        let _ = w.set_focus();
    }
    mark_read(app);
}
fn finish_choice(app: &AppHandle, placement: Option<Value>) {
    let choice = app.state::<AppState>().choice.lock().unwrap().take();
    if let Some(choice) = choice {
        for label in choice.labels {
            if let Ok(w) = win(app, &label) {
                let _ = w.destroy();
            }
        }
        let _ = choice.tx.send(placement);
        show_composer(app);
    }
}
async fn pick_target(app: &AppHandle) -> Result<Option<Value>> {
    let areas = desktop::areas(app).await?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let s = app.state::<AppState>();
        let mut choice = s.choice.lock().unwrap();
        if choice.is_some() {
            return Err("正在选择落点。".into());
        }
        *choice = Some(Choice {
            tx,
            labels: (0..areas.len().min(16))
                .map(|n| format!("target-{}", n + 1))
                .collect(),
        });
    }
    win(app, "composer")?.hide().map_err(err)?;
    win(app, "bubble")?.hide().map_err(err)?;
    for (n, b) in areas.into_iter().take(16).enumerate() {
        match make_window(app, &format!("target-{}", n + 1), "target.html", b, true) {
            Ok(w) => {
                w.show().map_err(err)?;
                w.set_focus().map_err(err)?;
            }
            Err(e) => {
                finish_choice(app, None);
                return Err(e);
            }
        }
    }
    rx.await.map_err(err)
}
async fn place_object(app: &AppHandle, message: Value) -> Result<String> {
    let label = format!("object-{}", uuid::Uuid::new_v4());
    {
        let state = app.state::<AppState>();
        let mut objects = state.objects.lock().unwrap();
        if objects.len() >= 8 {
            return Err("桌面上已有 8 个物件，请先关闭一个。".into());
        }
        // Reserve capacity before awaiting the screen query; concurrent confirmations share this limit.
        objects.insert(label.clone(), message.clone());
    }
    let result = async {
        let areas = desktop::areas(app).await?;
        let b = desktop::placed(&message["placement"], &areas, 300.0, 340.0);
        make_window(app, &label, "object.html", b, true)?;
        desktop::show_inactive(app, &label);
        Ok(label.clone())
    }
    .await;
    if result.is_err() {
        app.state::<AppState>()
            .objects
            .lock()
            .unwrap()
            .remove(&label);
    }
    result
}
fn stop_walk(app: &AppHandle, restore: bool) {
    let s = app.state::<AppState>();
    s.walk_epoch.fetch_add(1, Ordering::SeqCst);
    let original = s.walk_origin.lock().unwrap().take();
    if let Some(original) = original {
        if restore {
            if let Ok(w) = win(app, "pet") {
                let _ = desktop::set_bounds(&w, original);
            }
        }
        let _ = app.emit_to("pet", "walk-state", false);
    }
}
async fn play_action(app: &AppHandle, action: &str) -> Result<()> {
    desktop::show_inactive(app, "pet");
    if action != "walk" {
        return app.emit_to("pet", "quick-action", action).map_err(err);
    }
    stop_walk(app, true);
    let original = desktop::bounds(&win(app, "pet")?)?;
    let areas = desktop::areas(app).await?;
    let area = desktop::matching(original, &areas);
    let epoch = {
        let s = app.state::<AppState>();
        *s.walk_origin.lock().unwrap() = Some(original);
        s.walk_epoch.load(Ordering::SeqCst)
    };
    app.emit_to("pet", "walk-state", true).map_err(err)?;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let started = std::time::Instant::now();
        loop {
            if app.state::<AppState>().walk_epoch.load(Ordering::SeqCst) != epoch {
                return;
            }
            let t = (started.elapsed().as_secs_f64() / 6.0).min(1.0);
            let eased = if t < 0.12 {
                0.06 * (t / 0.12).powi(2)
            } else if t > 0.88 {
                0.94 + 0.06 * (1.0 - ((1.0 - t) / 0.12).powi(2))
            } else {
                0.06 + 0.88 * ((t - 0.12) / 0.76)
            };
            if let Ok(w) = win(&app, "pet") {
                let _ = w.set_position(tauri::LogicalPosition::new(
                    (area.x + area.width - eased * (area.width + 96.0)).round(),
                    original
                        .y
                        .clamp(area.y, (area.y + area.height - 108.0).max(area.y)),
                ));
            }
            if t >= 1.0 {
                stop_walk(&app, true);
                break;
            }
            tokio::time::sleep(Duration::from_millis(16)).await;
        }
    });
    Ok(())
}
async fn send_action(app: &AppHandle, action: &str) -> Result<()> {
    if !matches!(action, "heart" | "poop" | "walk") {
        return Err("快捷互动无效。".into());
    }
    let p = peer(app)?;
    if p.status()["canQuickActions"] != true {
        return Err("请让双方更新到支持快捷互动的版本。".into());
    }
    p.send(json!({"quickAction":action})).await?;
    if app
        .state::<AppState>()
        .peer
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|v| Arc::ptr_eq(v, &p))
    {
        app.emit_to("pet", "quick-action", action).map_err(err)?;
    }
    Ok(())
}
fn start_peer(app: &AppHandle) -> Result<()> {
    let s = app.state::<AppState>();
    let generation = s.generation.fetch_add(1, Ordering::SeqCst) + 1;
    if let Some(old) = s.peer.lock().unwrap().take() {
        old.stop();
    }
    let config = s.store.lock().unwrap().config.clone();
    let Some(invite) = config["invite"].as_str() else {
        request_broadcast(app);
        return Ok(());
    };
    let relays = std::env::var("PETLINK_RELAYS")
        .map(|s| s.split(',').map(str::to_string).collect())
        .unwrap_or_else(|_| DEFAULT_RELAYS.iter().map(|s| s.to_string()).collect());
    let pair_app = app.clone();
    let message_app = app.clone();
    let update_app = app.clone();
    let error_app = app.clone();
    let p = Peer::new(
        serde_json::from_value(config["identity"].clone()).map_err(err)?,
        invite,
        config["peerPubkey"].as_str().map(str::to_string),
        config["name"].as_str().unwrap_or("").into(),
        relays,
        Callbacks {
            pair: Box::new(move |pk, name| {
                let s = pair_app.state::<AppState>();
                let mut store = s.store.lock().unwrap();
                if s.generation.load(Ordering::SeqCst) != generation {
                    return Err("配对已变化。".into());
                }
                store.pair(pk, name)
            }),
            message: Box::new(move |message| {
                let s = message_app.state::<AppState>();
                {
                    let mut store = s.store.lock().unwrap();
                    if s.generation.load(Ordering::SeqCst) != generation {
                        return Err("配对已变化。".into());
                    }
                    if message.get("quickAction").is_none() {
                        store.remember(message.clone(), "incoming")?;
                    }
                }
                let app = message_app.clone();
                tauri::async_runtime::spawn(async move {
                    if app.state::<AppState>().generation.load(Ordering::SeqCst) != generation {
                        return;
                    }
                    if let Some(action) = message["quickAction"].as_str() {
                        let _ = play_action(&app, action).await;
                    } else {
                        request_broadcast(&app);
                        let muted = app.state::<AppState>().store.lock().unwrap().muted;
                        if !muted {
                            let _ = position_bubble(&app).await;
                            desktop::show_inactive(&app, "bubble");
                            desktop::show_inactive(&app, "pet");
                        }
                    }
                });
                Ok(())
            }),
            update: Box::new(move || request_broadcast(&update_app)),
            error: Box::new(move |e| notice(&error_app, e)),
        },
    )?;
    *s.peer.lock().unwrap() = Some(p.clone());
    p.start();
    request_broadcast(app);
    Ok(())
}
fn authorized(channel: &str, label: &str) -> bool {
    match channel {
        "get-object" | "close-object" | "object-height" => label.starts_with("object-"),
        "choose-target" | "cancel-target" => label.starts_with("target-"),
        "drag-start" | "drag-move" | "drag-end" | "quick-action" | "pet-menu" => label == "pet",
        "get-state" | "open" => matches!(label, "composer" | "pet" | "bubble"),
        "dismiss" | "link" | "save-attachment" | "respond-throw" => {
            matches!(label, "composer" | "bubble")
        }
        "send" => matches!(label, "composer" | "bubble"),
        "bubble-height" => label == "bubble",
        "set-pet" | "configure" | "copy-invite" | "mute" | "reset" | "pick-target"
        | "check-update" | "download-update" | "install-update" => label == "composer",
        _ => false,
    }
}
async fn confirm(title: &str, description: &str, yes: &str, no: &str) -> bool {
    rfd::AsyncMessageDialog::new()
        .set_title(title)
        .set_description(description)
        .set_buttons(rfd::MessageButtons::OkCancelCustom(yes.into(), no.into()))
        .show()
        .await
        == rfd::MessageDialogResult::Custom(yes.into())
}
async fn respond_throw(app: &AppHandle, value: &Value) -> Result<Value> {
    let id = value["requestId"].as_str().ok_or("请求无效。")?;
    let accepted = value["accepted"].as_bool().ok_or("请选择确认或拒绝。")?;
    let s = app.state::<AppState>();
    let generation = s.generation.load(Ordering::SeqCst);
    let request = {
        let mut store = s.store.lock().unwrap();
        let mut history = store.history.clone();
        let request = history
            .iter_mut()
            .find(|m| m["id"] == id && m["direction"] == "incoming" && m.get("placement").is_some())
            .ok_or("这个请求不存在。")?;
        if request["throwState"] != "pending" {
            return Err("这个请求已处理。".into());
        }
        if now().saturating_sub(request["sentAt"].as_u64().unwrap_or(0)) > 300000 {
            return Err("请求已过期，请让 TA 重新发送。".into());
        }
        let result = request.clone();
        request["throwState"] = json!("processing");
        store.set_history(history)?;
        result
    };
    let object = if accepted {
        match place_object(app, request).await {
            Ok(label) => Some(label),
            Err(e) => {
                let mut store = s.store.lock().unwrap();
                let mut h = store.history.clone();
                if let Some(m) = h.iter_mut().find(|m| m["id"] == id) {
                    m["throwState"] = json!("pending");
                    store.set_history(h)?;
                }
                return Err(e);
            }
        }
    } else {
        None
    };
    let commit = (|| -> Result<()> {
        let mut store = s.store.lock().unwrap();
        if s.generation.load(Ordering::SeqCst) != generation {
            return Err("配对已变化，这个请求已取消。".into());
        }
        let mut h = store.history.clone();
        let m = h.iter_mut().find(|m| m["id"] == id).ok_or("请求已取消。")?;
        m["throwState"] = json!(if accepted { "accepted" } else { "rejected" });
        store.set_history(h)
    })();
    if let Err(e) = commit {
        if let Some(label) = object {
            if let Ok(w) = win(app, &label) {
                let _ = w.destroy();
            }
        }
        let mut store = s.store.lock().unwrap();
        if s.generation.load(Ordering::SeqCst) == generation {
            if let Some(m) = store.history.iter_mut().find(|m| m["id"] == id) {
                m["throwState"] = json!("pending");
            }
        }
        return Err(e);
    }
    request_broadcast(app);
    let name = s.store.lock().unwrap().config["name"]
        .as_str()
        .unwrap_or("小伙伴")
        .to_string();
    let p = peer(app);
    let sent=async {p?.send(json!({"text":format!("{name}{}",if accepted{"接住了你甩来的东西 ♡"}else{"拒绝了甩东西请求"}),"throwDecision":{"requestId":id,"accepted":accepted}})).await}.await;
    match sent {
        Ok(m) => {
            let mut store = s.store.lock().unwrap();
            if s.generation.load(Ordering::SeqCst) == generation {
                store.remember(m, "outgoing")?;
            }
            request_broadcast(app);
            Ok(json!({"accepted":accepted}))
        }
        Err(_) => Ok(json!({"accepted":accepted,"notice":"本机已处理请求，但暂未通知到对方。"})),
    }
}
#[tauri::command]
pub async fn call(
    app: AppHandle,
    window: WebviewWindow,
    channel: String,
    value: Option<Value>,
) -> Result<Value> {
    #[cfg(debug_assertions)]
    if std::env::var_os("PETLINK_UI_TEST").is_some() {
        if channel == "test-report" {
            let v = value.unwrap_or(Value::Null);
            let id = v["id"].as_u64().ok_or("Test ID missing")?;
            let profile = app
                .state::<AppState>()
                .store
                .lock()
                .unwrap()
                .profile
                .clone();
            crate::store::write_json(&profile.join(format!("test-result-{id}.json")), &v)?;
            return Ok(Value::Null);
        }
        if channel == "test-windows" {
            return Ok(json!(app
                .webview_windows()
                .keys()
                .cloned()
                .collect::<Vec<_>>()));
        }
    }
    let label = window.label();
    if !authorized(&channel, label) {
        return Err("未知操作或客户端。".into());
    }
    let v = value.unwrap_or(Value::Null);
    let s = app.state::<AppState>();
    match channel.as_str() {
        "get-state" => Ok(state(&app, label, label == "composer")),
        "configure" => {
            {
                let mut store = s.store.lock().unwrap();
                if !store.config["peerPubkey"].is_null() {
                    return Err("请先断开当前配对。".into());
                }
                let name = v["name"].as_str().ok_or("请输入昵称。")?.trim();
                if name.is_empty() || name.encode_utf16().count() > 30 {
                    return Err("请输入 1–30 字的昵称。".into());
                }
                let invite = if v["create"] == true {
                    Invite::create(&store.identity())
                } else {
                    v["invite"].as_str().ok_or("邀请无效")?.trim().to_string()
                };
                Invite::parse(&invite)?;
                let mut config = store.config.clone();
                config["name"] = json!(name);
                config["invite"] = json!(invite);
                store.set_config(config)?;
            }
            start_peer(&app)?;
            Ok(state(&app, label, true))
        }
        "copy-invite" => {
            let invite = {
                let store = s.store.lock().unwrap();
                if !store.config["peerPubkey"].is_null() {
                    return Err("当前没有可用的邀请码。".into());
                }
                store.config["invite"]
                    .as_str()
                    .ok_or("没有邀请码。")?
                    .to_string()
            };
            app.run_on_main_thread(move || {
                let p = objc2_app_kit::NSPasteboard::generalPasteboard();
                p.clearContents();
                p.setString_forType(&objc2_foundation::NSString::from_str(&invite), unsafe {
                    objc2_app_kit::NSPasteboardTypeString
                });
            })
            .map_err(err)?;
            Ok(json!(true))
        }
        "send" => {
            if v.get("quickAction").is_some() || v.get("throwDecision").is_some() {
                return Err("请通过互动菜单或收到的请求按钮操作。".into());
            }
            let p = peer(&app)?;
            if v.get("placement").is_some() && p.status()["canThrow"] != true {
                return Err("对方版本还不支持甩东西。".into());
            }
            let generation = s.generation.load(Ordering::SeqCst);
            let sent = p.send(v).await?;
            {
                let mut store = s.store.lock().unwrap();
                if s.generation.load(Ordering::SeqCst) == generation {
                    store.remember(sent.clone(), "outgoing")?;
                }
            }
            request_broadcast(&app);
            Ok(sent)
        }
        "open" => {
            show_composer(&app);
            Ok(Value::Null)
        }
        "dismiss" => {
            mark_read(&app);
            Ok(Value::Null)
        }
        "mute" => {
            let muted = {
                let mut store = s.store.lock().unwrap();
                store.muted = !store.muted;
                store.muted
            };
            if muted {
                win(&app, "bubble")?.hide().map_err(err)?;
            }
            request_broadcast(&app);
            Ok(json!(muted))
        }
        "link" => {
            let text = v.as_str().filter(|s| s.len() <= 4096).ok_or("链接无效。")?;
            let url = url::Url::parse(text).map_err(err)?;
            if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
                return Err("只支持 http / https 链接。".into());
            }
            let status = std::process::Command::new("/usr/bin/open")
                .arg(url.as_str())
                .status()
                .map_err(err)?;
            if !status.success() {
                return Err("无法打开链接。".into());
            }
            Ok(Value::Null)
        }
        "save-attachment" => {
            let attachment = {
                let store = s.store.lock().unwrap();
                store
                    .history
                    .iter()
                    .find(|m| m["id"] == v)
                    .and_then(|m| m.get("attachment"))
                    .cloned()
                    .ok_or("附件已不在本机历史中。")?
            };
            let name = attachment["name"].as_str().ok_or("附件无效")?;
            let Some(file) = rfd::AsyncFileDialog::new()
                .set_file_name(name)
                .save_file()
                .await
            else {
                return Ok(json!(false));
            };
            let data = STANDARD
                .decode(attachment["data"].as_str().ok_or("附件无效")?)
                .map_err(err)?;
            std::fs::write(file.path(), data).map_err(err)?;
            Ok(json!(true))
        }
        "set-pet" => {
            let pet = match v.as_str() {
                Some("cat") => default_pet(),
                Some("bunny") => {
                    json!({"kind":"bunny","src":"bunny.svg","name":"像素小兔","pixel":true})
                }
                Some("custom") => {
                    let Some(file) = rfd::AsyncFileDialog::new()
                        .set_title("选择桌宠图片")
                        .add_filter("桌宠图片", &["png", "jpg", "jpeg"])
                        .pick_file()
                        .await
                    else {
                        return Ok(state(&app, label, true));
                    };
                    if std::fs::metadata(file.path()).map_err(err)?.len() > 2 * 1024 * 1024 {
                        return Err("桌宠图片最大 2 MiB。".into());
                    }
                    let data = std::fs::read(file.path()).map_err(err)?;
                    if data.len() > 2 * 1024 * 1024 {
                        return Err("桌宠图片最大 2 MiB。".into());
                    }
                    let format = image::guess_format(&data).map_err(err)?;
                    let mime = match format {
                        image::ImageFormat::Png => "image/png",
                        image::ImageFormat::Jpeg => "image/jpeg",
                        _ => return Err("桌宠支持 PNG/JPEG。".into()),
                    };
                    let (w, h) =
                        image::ImageReader::with_format(std::io::Cursor::new(&data), format)
                            .into_dimensions()
                            .map_err(err)?;
                    if u64::from(w) * u64::from(h) > 64_000_000 {
                        return Err("图片尺寸过大。".into());
                    }
                    json!({"kind":"custom","src":format!("data:{mime};base64,{}",STANDARD.encode(data)),"name":"自定义桌宠","pixel":false})
                }
                _ => return Err("请选择有效的桌宠。".into()),
            };
            {
                let mut store = s.store.lock().unwrap();
                let mut config = store.config.clone();
                config["pet"] = pet;
                store.set_config(config)?;
            }
            request_broadcast(&app);
            Ok(state(&app, label, true))
        }
        "bubble-height" => {
            let h = v
                .as_f64()
                .filter(|v| v.is_finite())
                .ok_or("窗口高度无效")?
                .ceil()
                .clamp(160.0, 430.0);
            window
                .set_size(tauri::LogicalSize::new(360.0, h))
                .map_err(err)?;
            position_bubble(&app).await?;
            Ok(Value::Null)
        }
        "drag-start" => {
            stop_walk(&app, false);
            *s.drag.lock().unwrap() = Some(Drag {
                bounds: desktop::bounds(&window)?,
                cursor: window.cursor_position().map_err(err)?,
            });
            Ok(Value::Null)
        }
        "drag-move" => {
            let cursor = window.cursor_position().map_err(err)?;
            let scale = window.scale_factor().map_err(err)?;
            if let Some(d) = &*s.drag.lock().unwrap() {
                window
                    .set_position(tauri::LogicalPosition::new(
                        (d.bounds.x + (cursor.x - d.cursor.x) / scale).round(),
                        (d.bounds.y + (cursor.y - d.cursor.y) / scale).round(),
                    ))
                    .map_err(err)?;
            }
            Ok(Value::Null)
        }
        "drag-end" => {
            if s.drag.lock().unwrap().take().is_some() {
                let b = desktop::bounds(&window)?;
                let areas = desktop::areas(&app).await?;
                let b = desktop::clamp(b, desktop::matching(b, &areas));
                desktop::set_bounds(&window, b)?;
                let mut store = s.store.lock().unwrap();
                let mut config = store.config.clone();
                config["position"] = json!(b);
                store.set_config(config)?;
            }
            Ok(Value::Null)
        }
        "quick-action" => {
            send_action(&app, v.as_str().ok_or("互动无效")?).await?;
            Ok(Value::Null)
        }
        "pet-menu" => {
            let enabled = peer(&app).is_ok_and(|p| {
                p.status()["peerOnline"] == true && p.status()["canQuickActions"] == true
            });
            let heart =
                MenuItem::with_id(&app, "heart", "给 TA 一个爱心 💗", enabled, None::<&str>)
                    .map_err(err)?;
            let poop = MenuItem::with_id(&app, "poop", "给 TA 一个便便 💩", enabled, None::<&str>)
                .map_err(err)?;
            let walk = MenuItem::with_id(&app, "walk", "让小伙伴散个步 🐾", enabled, None::<&str>)
                .map_err(err)?;
            let open =
                MenuItem::with_id(&app, "open", "打开 PetLink", true, None::<&str>).map_err(err)?;
            let menu = Menu::with_items(&app, &[&heart, &poop, &walk, &open]).map_err(err)?;
            window.popup_menu(&menu).map_err(err)?;
            Ok(json!(true))
        }
        "pick-target" => Ok(json!(pick_target(&app).await?)),
        "choose-target" => {
            if !s
                .choice
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|c| c.labels.iter().any(|l| l == label))
            {
                return Err("落点选择已结束。".into());
            }
            let display = label
                .strip_prefix("target-")
                .and_then(|s| s.parse::<u64>().ok())
                .ok_or("屏幕无效")?;
            let p = validate_placement(&json!({"display":display,"x":v["x"],"y":v["y"]}))?;
            finish_choice(&app, Some(p));
            Ok(Value::Null)
        }
        "cancel-target" => {
            finish_choice(&app, None);
            Ok(Value::Null)
        }
        "get-object" => s
            .objects
            .lock()
            .unwrap()
            .get(label)
            .cloned()
            .ok_or("物件已关闭。".into()),
        "close-object" => {
            window.destroy().map_err(err)?;
            s.objects.lock().unwrap().remove(label);
            Ok(Value::Null)
        }
        "object-height" => {
            let h = v
                .as_f64()
                .filter(|n| n.is_finite())
                .ok_or("窗口高度无效")?
                .ceil()
                .clamp(30.0, 420.0);
            let message = s
                .objects
                .lock()
                .unwrap()
                .get(label)
                .cloned()
                .ok_or("物件已关闭。")?;
            let areas = desktop::areas(&app).await?;
            desktop::set_bounds(
                &window,
                desktop::placed(&message["placement"], &areas, 300.0, h),
            )?;
            Ok(Value::Null)
        }
        "respond-throw" => respond_throw(&app, &v).await,
        "reset" => {
            if !confirm(
                "PetLink",
                "断开与小伙伴的配对？本机聊天记录会被清空。",
                "断开配对",
                "保留配对",
            )
            .await
            {
                return Ok(json!(false));
            }
            s.generation.fetch_add(1, Ordering::SeqCst);
            if let Some(p) = s.peer.lock().unwrap().take() {
                p.stop();
            }
            {
                let mut store = s.store.lock().unwrap();
                let mut config = store.config.clone();
                config["invite"] = Value::Null;
                config["peerPubkey"] = Value::Null;
                config["peerName"] = json!("");
                store.set_config(config)?;
                store.set_history(vec![])?;
                store.latest = None;
                store.unread = 0;
            }
            finish_choice(&app, None);
            stop_walk(&app, true);
            let labels: Vec<_> = s.objects.lock().unwrap().keys().cloned().collect();
            for label in labels {
                if let Ok(w) = win(&app, &label) {
                    let _ = w.destroy();
                }
            }
            win(&app, "bubble")?.hide().map_err(err)?;
            request_broadcast(&app);
            Ok(json!(true))
        }
        "check-update" => s.updater.check().await,
        "download-update" => s.updater.prepare().await,
        "install-update" => {
            let update = s.updater.state();
            if update["phase"] != "ready" {
                return Err("请先下载更新。".into());
            }
            let text = format!(
                "重启并安装 PetLink {}？配对信息、桌宠设置和聊天记录会保留。{}",
                update["available"].as_str().unwrap_or(""),
                if update["signed"] == true {
                    ""
                } else {
                    "\n此更新是临时签名包，尚未经过 Apple 公证。macOS 可能再次要求「仍要打开」。"
                }
            );
            if !confirm("PetLink", &text, "重启并更新", "稍后").await {
                return Ok(update);
            }
            let result = s.updater.install().await?;
            app.exit(0);
            Ok(result)
        }
        _ => Err("未知操作。".into()),
    }
}
async fn init_windows(app: AppHandle) -> Result<()> {
    let areas = desktop::areas(&app).await?;
    let a = areas[0];
    let composer = make_window(
        &app,
        "composer",
        "index.html",
        Bounds {
            x: a.x + (a.width - 520.0) / 2.0,
            y: a.y + (a.height - 760.0) / 2.0,
            width: 520.0,
            height: 760.0,
        },
        false,
    )?;
    composer
        .set_min_size(Some(tauri::LogicalSize::new(460.0, 600.0)))
        .map_err(err)?;
    let saved = app.state::<AppState>().store.lock().unwrap().config["position"].clone();
    let b = Bounds {
        x: saved["x"]
            .as_f64()
            .filter(|x| x.is_finite())
            .unwrap_or(a.x + a.width - 120.0),
        y: saved["y"]
            .as_f64()
            .filter(|y| y.is_finite())
            .unwrap_or(a.y + a.height - 128.0),
        width: 96.0,
        height: 108.0,
    };
    make_window(
        &app,
        "pet",
        "pet.html",
        desktop::clamp(b, desktop::matching(b, &areas)),
        true,
    )?;
    make_window(
        &app,
        "bubble",
        "bubble.html",
        Bounds {
            x: a.x,
            y: a.y,
            width: 360.0,
            height: 420.0,
        },
        true,
    )?;
    desktop::show_inactive(&app, "pet");
    if std::env::var_os("PETLINK_HIDDEN").is_none() {
        composer.show().map_err(err)?;
    }
    position_bubble(&app).await?;
    start_peer(&app)?;
    #[cfg(debug_assertions)]
    if std::env::var_os("PETLINK_UI_TEST").is_some() {
        start_ui_test(app.clone());
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut previous = areas;
        let mut previous_time = now();
        loop {
            tokio::time::sleep(Duration::from_secs(3)).await;
            let current_time = now();
            if current_time.saturating_sub(previous_time) > 25000 {
                let _ = start_peer(&app);
            }
            previous_time = current_time;
            if let Ok(current) = desktop::areas(&app).await {
                if serde_json::to_string(&current).ok() != serde_json::to_string(&previous).ok() {
                    finish_choice(&app, None);
                    stop_walk(&app, false);
                    if let Ok(p) = win(&app, "pet") {
                        if let Ok(b) = desktop::bounds(&p) {
                            let _ = desktop::set_bounds(
                                &p,
                                desktop::clamp(b, desktop::matching(b, &current)),
                            );
                        }
                    }
                    let objects = app.state::<AppState>().objects.lock().unwrap().clone();
                    for (label, m) in objects {
                        if let Ok(w) = win(&app, &label) {
                            if let Ok(b) = desktop::bounds(&w) {
                                let _ = desktop::set_bounds(
                                    &w,
                                    desktop::placed(&m["placement"], &current, b.width, b.height),
                                );
                            }
                        }
                    }
                    previous = current;
                }
            }
        }
    });
    Ok(())
}
pub fn run() {
    let built = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![call])
        .setup(|app| {
            let profile = std::env::var_os("PETLINK_PROFILE")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    PathBuf::from(std::env::var_os("HOME").unwrap())
                        .join("Library/Application Support/PetLink")
                });
            let store = Store::load(profile.clone()).map_err(std::io::Error::other)?;
            let bundle = updater::installed_bundle();
            if let Some(bundle) = &bundle {
                updater::cleanup_installed(bundle, &profile);
            }
            let handle = app.handle().clone();
            let changed = handle.clone();
            let updater = Updater::new(
                bundle,
                profile,
                Box::new(move || request_broadcast(&changed)),
            );
            app.manage(AppState {
                store: Arc::new(Mutex::new(store)),
                peer: Mutex::new(None),
                updater,
                generation: AtomicU64::new(0),
                broadcast_pending: AtomicBool::new(false),
                history_sent: Mutex::new(HashMap::new()),
                objects: Mutex::new(HashMap::new()),
                choice: Mutex::new(None),
                drag: Mutex::new(None),
                walk_epoch: AtomicU64::new(0),
                walk_origin: Mutex::new(None),
            });
            let open = MenuItem::with_id(app, "open", "打开 PetLink", true, None::<&str>)?;
            let update = MenuItem::with_id(app, "update", "检查更新…", true, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "显示小伙伴", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "暂时隐藏小伙伴", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&open, &update, &show, &hide, &separator, &quit])?;
            TrayIconBuilder::new()
                .title("🐾")
                .tooltip("PetLink · 桌面小伙伴")
                .menu(&menu)
                .build(app)?;
            let app_menu = Menu::with_items(
                app,
                &[
                    &tauri::menu::Submenu::with_items(app, "PetLink", true, &[&update, &quit])?,
                    &tauri::menu::Submenu::with_items(
                        app,
                        "编辑",
                        true,
                        &[
                            &PredefinedMenuItem::undo(app, None)?,
                            &PredefinedMenuItem::redo(app, None)?,
                            &PredefinedMenuItem::cut(app, None)?,
                            &PredefinedMenuItem::copy(app, None)?,
                            &PredefinedMenuItem::paste(app, None)?,
                            &PredefinedMenuItem::select_all(app, None)?,
                        ],
                    )?,
                ],
            )?;
            app.set_menu(app_menu)?;
            tauri::async_runtime::spawn(async move {
                if let Err(e) = init_windows(handle.clone()).await {
                    rfd::AsyncMessageDialog::new()
                        .set_title("PetLink")
                        .set_description(&e)
                        .show()
                        .await;
                    handle.exit(1);
                }
            });
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_composer(app),
            "show" => desktop::show_inactive(app, "pet"),
            "hide" => {
                for l in ["pet", "bubble"] {
                    if let Ok(w) = win(app, l) {
                        let _ = w.hide();
                    }
                }
            }
            "quit" => app.exit(0),
            "update" => {
                show_composer(app);
                let a = app.clone();
                tauri::async_runtime::spawn(async move {
                    let updater = a.state::<AppState>().updater.clone();
                    if let Err(e) = updater.check().await {
                        notice(&a, e);
                    }
                });
            }
            action @ ("heart" | "poop" | "walk") => {
                let app = app.clone();
                let action = action.to_string();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = send_action(&app, &action).await {
                        let _ = app.emit_to("pet", "notice", e);
                    }
                });
            }
            _ => {}
        })
        .build(tauri::generate_context!());
    let app = match built {
        Ok(app) => app,
        Err(error) => {
            rfd::MessageDialog::new()
                .set_title("PetLink")
                .set_description(error.to_string())
                .show();
            std::process::exit(1);
        }
    };
    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested {
            code: None, api, ..
        } => api.prevent_exit(),
        tauri::RunEvent::Exit => {
            if let Some(s) = app.try_state::<AppState>() {
                if let Some(p) = s.peer.lock().unwrap().take() {
                    p.stop();
                }
            }
        }
        tauri::RunEvent::Reopen { .. } => show_composer(app),
        _ => {}
    });
}
// Only debug builds can evaluate local integration-test scripts. This code is absent from release binaries.
#[cfg(debug_assertions)]
fn start_ui_test(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let profile = app
            .state::<AppState>()
            .store
            .lock()
            .unwrap()
            .profile
            .clone();
        loop {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let path = profile.join("test-command.json");
            if !path.exists() {
                continue;
            }
            let result = (|| -> Result<()> {
                let v: Value =
                    serde_json::from_slice(&std::fs::read(&path).map_err(err)?).map_err(err)?;
                std::fs::remove_file(&path).map_err(err)?;
                let id = v["id"].as_u64().ok_or("Test ID missing")?;
                let w = win(&app, v["label"].as_str().ok_or("Test window missing")?)?;
                let script = v["script"].as_str().ok_or("Test script missing")?;
                let js=format!("(async()=>{{try{{const result=await(async()=>{{{script}}})();await window.__TAURI__.core.invoke('call',{{channel:'test-report',value:{{id:{id},result:result??null}}}});}}catch(error){{await window.__TAURI__.core.invoke('call',{{channel:'test-report',value:{{id:{id},error:String(error)}}}});}}}})()");
                w.eval(js).map_err(err)
            })();
            if let Err(e) = result {
                notice(&app, e);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn window_permissions() {
        assert!(authorized("send", "bubble"));
        assert!(!authorized("configure", "pet"));
        assert!(!authorized("reset", "bubble"));
        assert!(!authorized("install-update", "object-123"));
        assert!(authorized("choose-target", "target-2"));
    }
}
