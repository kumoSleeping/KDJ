//! Transparent lyric padding must not intercept controls in windows below it.
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use tauri::Manager;

#[derive(Clone, Copy, Deserialize)]
pub struct DragRegion {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl DragRegion {
    fn contains(self, x: f64, y: f64) -> bool {
        self.width > 0.0
            && self.height > 0.0
            && x >= self.x
            && x < self.x + self.width
            && y >= self.y
            && y < self.y + self.height
    }
}

struct HitTest {
    locked: bool,
    regions: Vec<DragRegion>,
    revision: u64,
}

static HIT_TEST: Mutex<HitTest> = Mutex::new(HitTest {
    locked: true,
    regions: Vec::new(),
    revision: 0,
});

pub fn set_locked(locked: bool) {
    let mut state = HIT_TEST.lock().unwrap();
    state.locked = locked;
    state.revision = state.revision.wrapping_add(1);
}

#[tauri::command]
pub fn set_desktop_lyrics_drag_regions(
    window: tauri::WebviewWindow,
    regions: Vec<DragRegion>,
) -> Result<(), String> {
    if window.label() != "lyrics-overlay" {
        return Err("Only the lyrics window can set its drag regions".into());
    }
    let mut state = HIT_TEST.lock().unwrap();
    state.regions = regions.into_iter().take(2).collect();
    state.revision = state.revision.wrapping_add(1);
    Ok(())
}

pub fn install(app: tauri::AppHandle) {
    HIT_TEST.lock().unwrap().regions.clear();
    tauri::async_runtime::spawn(async move {
        let mut applied = None;
        loop {
            let Some(window) = app.get_webview_window("lyrics-overlay") else {
                break;
            };
            let (locked, regions, revision) = {
                let state = HIT_TEST.lock().unwrap();
                (state.locked, state.regions.clone(), state.revision)
            };
            if window.is_visible().unwrap_or(false) {
                // Native coordinates still update while the WebView ignores mouse events.
                // DOM mouseleave/mousemove alone cannot re-enable dragging after passthrough.
                let ignore = locked
                    || (|| {
                        let cursor = window.cursor_position().ok()?;
                        let origin = window.inner_position().ok()?;
                        let scale = window.scale_factor().ok()?;
                        let x = (cursor.x - f64::from(origin.x)) / scale;
                        let y = (cursor.y - f64::from(origin.y)) / scale;
                        Some(!regions.iter().any(|region| region.contains(x, y)))
                    })()
                    .unwrap_or(true);
                if applied != Some((ignore, revision))
                    && window.set_ignore_cursor_events(ignore).is_ok()
                {
                    applied = Some((ignore, revision));
                }
            } else {
                applied = None;
            }
            tokio::time::sleep(Duration::from_millis(if locked { 200 } else { 32 })).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_visible_drag_region_intercepts_clicks() {
        let text = DragRegion {
            x: 150.0,
            y: 12.0,
            width: 400.0,
            height: 50.0,
        };
        assert!(text.contains(200.0, 30.0));
        assert!(!text.contains(20.0, 30.0));
        assert!(!text.contains(200.0, 80.0));
        assert!(!text.contains(550.0, 30.0));
        assert!(!DragRegion { width: 0.0, ..text }.contains(150.0, 30.0));
    }
}
