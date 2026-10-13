use crate::protocol::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
pub fn clamp(mut b: Bounds, a: Bounds) -> Bounds {
    b.x = b.x.clamp(a.x, a.x + (a.width - b.width).max(0.0)).round();
    b.y = b.y.clamp(a.y, a.y + (a.height - b.height).max(0.0)).round();
    b
}
pub fn placed(p: &Value, areas: &[Bounds], width: f64, height: f64) -> Bounds {
    let index = p["display"].as_u64().unwrap_or(1).saturating_sub(1) as usize;
    let a = areas.get(index).unwrap_or(&areas[0]);
    clamp(
        Bounds {
            x: a.x + p["x"].as_f64().unwrap_or(0.5) * a.width - width / 2.0,
            y: a.y + p["y"].as_f64().unwrap_or(0.5) * a.height - height / 2.0,
            width,
            height,
        },
        *a,
    )
}
pub async fn areas(app: &AppHandle) -> Result<Vec<Bounds>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let result = (|| {
            let mtm = objc2::MainThreadMarker::new().ok_or("窗口必须在主线程创建")?;
            let screens = objc2_app_kit::NSScreen::screens(mtm);
            let first = screens.firstObject().ok_or("没有可用屏幕")?;
            let primary = first.frame();
            let top = primary.origin.y + primary.size.height;
            let mut bounds = Vec::new();
            for screen in &screens {
                let frame = screen.visibleFrame();
                bounds.push(Bounds {
                    x: frame.origin.x,
                    y: top - frame.origin.y - frame.size.height,
                    width: frame.size.width,
                    height: frame.size.height,
                });
            }
            if bounds.len() > 1 {
                bounds[1..].sort_by(|a, b| a.x.total_cmp(&b.x).then(a.y.total_cmp(&b.y)));
            }
            Ok(bounds)
        })();
        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())?
}
pub fn matching(bounds: Bounds, areas: &[Bounds]) -> Bounds {
    *areas
        .iter()
        .max_by(|a, b| {
            let overlap = |a: &&Bounds| {
                (bounds.x + bounds.width)
                    .min(a.x + a.width)
                    .sub(bounds.x.max(a.x))
                    .max(0.0)
                    * (bounds.y + bounds.height)
                        .min(a.y + a.height)
                        .sub(bounds.y.max(a.y))
                        .max(0.0)
            };
            overlap(a).total_cmp(&overlap(b))
        })
        .unwrap_or(&areas[0])
}
use std::ops::Sub;
pub fn bounds(win: &tauri::WebviewWindow) -> Result<Bounds> {
    let scale = win.scale_factor().map_err(|e| e.to_string())?;
    let p = win
        .outer_position()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    let s = win
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    Ok(Bounds {
        x: p.x,
        y: p.y,
        width: s.width,
        height: s.height,
    })
}
pub fn set_bounds(win: &tauri::WebviewWindow, b: Bounds) -> Result<()> {
    win.set_size(tauri::LogicalSize::new(b.width, b.height))
        .map_err(|e| e.to_string())?;
    win.set_position(tauri::LogicalPosition::new(b.x, b.y))
        .map_err(|e| e.to_string())
}
pub fn show_inactive(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.show();
    }
}
pub fn overlay_native(win: &tauri::WebviewWindow) -> Result<()> {
    let w = win.clone();
    win.run_on_main_thread(move || {
        if let Ok(pointer) = w.ns_window() {
            unsafe {
                let w = &*(pointer as *const objc2_app_kit::NSWindow);
                w.setLevel(1000);
                use objc2_app_kit::NSWindowCollectionBehavior as B;
                w.setCollectionBehavior(
                    B::CanJoinAllSpaces | B::FullScreenAuxiliary | B::Stationary | B::IgnoresCycle,
                );
            }
        }
    })
    .map_err(|e| e.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn coordinates() {
        let areas = [
            Bounds {
                x: 0.0,
                y: 25.0,
                width: 1440.0,
                height: 850.0,
            },
            Bounds {
                x: -1280.0,
                y: 0.0,
                width: 1280.0,
                height: 800.0,
            },
        ];
        let p = placed(&json!({"display":2,"x":0,"y":1}), &areas, 300.0, 340.0);
        assert_eq!((p.x, p.y), (-1280.0, 460.0));
        let fallback = placed(&json!({"display":16,"x":1,"y":0}), &areas, 300.0, 340.0);
        assert_eq!((fallback.x, fallback.y), (1140.0, 25.0));
    }
}
