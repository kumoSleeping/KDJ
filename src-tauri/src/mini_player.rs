//! The main window as a mini player: the window itself is taken down to the playing song's
//! bubble and brought back, so playback, the page and its state never leave their WebView.
//!
//! The page owns what is drawn and the order of the steps (src/lib/miniPlayer.ts); this owns the
//! window's frame. The page is on show for every change: while the size changes it draws
//! itself to fit the window as it is at that moment, from the window's top-left corner, which
//! is where a WebView shows its last picture until the page has drawn for the new size.
//!
//! Collapse: `mini_player_collapse` takes the frame from the whole window to the bubble where
//! it stands, `mini_player_settle` moves it to where the listener last left it. Expand:
//! `mini_player_recall` remembers that place and moves back to the bubble's corner of the
//! whole window, `mini_player_expand` grows to it. Every platform runs the same steps through
//! the same window calls; only the macOS window buttons need a call of their own.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

const STATE_FILE: &str = "mini-player.json";
/// The page is watched all the way: long enough to follow, short enough not to be waited for.
const RESIZE_MS: u64 = 320;
const TRAVEL_MS: u64 = 280;
const TICK: Duration = Duration::from_millis(8);
/// The last frame is handed to the window's own thread; the page is told afterwards.
const SETTLE: Duration = Duration::from_millis(40);
/// Kept between the mini player and the edge of its screen when it is put back.
const SCREEN_MARGIN: i32 = 8;
const SMALLEST: u32 = 48;

/// Outer top-left corner and inner size, in physical pixels. The main window has no frame of
/// its own on any desktop (an overlaid title bar on macOS, no decorations elsewhere).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Frame {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl Frame {
    fn right(self) -> i32 {
        self.x.saturating_add(self.width as i32)
    }
    fn bottom(self) -> i32 {
        self.y.saturating_add(self.height as i32)
    }
}

/// What is kept between runs: where the mini player was left, and whether it floats.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
struct Saved {
    place: Option<(i32, i32)>,
    on_top: bool,
}

impl Default for Saved {
    fn default() -> Self {
        Self { place: None, on_top: true }
    }
}

/// The whole window as it was, for the way back.
#[derive(Debug, Clone, Copy)]
struct Session {
    full: Frame,
    /// The whole window's size in CSS pixels: what the page keeps its layout at meanwhile.
    full_css: (f64, f64),
    maximized: bool,
    /// From the bubble's right and bottom edges to the whole window's.
    corner: (i32, i32),
    /// It has arrived at its place: from now until it is called back, a move is the
    /// listener's own and is where it will be next time.
    settled: bool,
}

#[derive(Default)]
struct Inner {
    saved: Saved,
    session: Option<Session>,
    busy: bool,
}

pub struct MiniPlayer {
    path: PathBuf,
    inner: Mutex<Inner>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct ClientRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MiniPlayerState {
    active: bool,
    on_top: bool,
    /// The whole window's size in CSS pixels while this is the mini player, else 0.
    full_width: f64,
    full_height: f64,
}

impl MiniPlayer {
    pub fn load(data_dir: &Path) -> Self {
        let path = data_dir.join(STATE_FILE);
        let saved = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Saved>(&bytes).ok())
            .unwrap_or_default();
        Self { path, inner: Mutex::new(Inner { saved, ..Inner::default() }) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn state(&self) -> MiniPlayerState {
        let inner = self.lock();
        let (full_width, full_height) = inner.session.map_or((0.0, 0.0), |session| session.full_css);
        MiniPlayerState { active: inner.session.is_some(), on_top: inner.saved.on_top, full_width, full_height }
    }

    fn save(&self, saved: Saved) {
        let written = serde_json::to_vec(&saved)
            .map_err(std::io::Error::other)
            .and_then(|bytes| std::fs::write(&self.path, bytes));
        if let Err(error) = written {
            tracing::warn!("保存迷你播放器位置失败：{error}");
        }
    }
}

/// The main window is the mini player now: its frame is not the main window's to remember.
pub fn active(app: &AppHandle) -> bool {
    app.try_state::<MiniPlayer>().is_some_and(|mini| mini.lock().session.is_some())
}

/// The window was moved. As a settled mini player that is the listener dragging it; the steps
/// of the way down and back are this module's own and are not remembered.
pub fn moved(app: &AppHandle, position: PhysicalPosition<i32>) {
    let Some(mini) = app.try_state::<MiniPlayer>() else { return; };
    let mut inner = mini.lock();
    if !inner.busy && inner.session.is_some_and(|session| session.settled) {
        inner.saved.place = Some((position.x, position.y));
    }
}

/// The app is closing as a mini player: where it was dragged to is kept for the next run.
pub fn persist(app: &AppHandle) {
    let Some(mini) = app.try_state::<MiniPlayer>() else { return; };
    let saved = {
        let inner = mini.lock();
        inner.session.map(|_| inner.saved)
    };
    if let Some(saved) = saved {
        mini.save(saved);
    }
}

/// One step at a time. Dropped at the end of a command, whatever way it ends.
struct Step<'a>(&'a MiniPlayer);

impl<'a> Step<'a> {
    fn begin(mini: &'a MiniPlayer) -> Result<Self, String> {
        let mut inner = mini.lock();
        if inner.busy {
            return Err("迷你播放器正在切换".into());
        }
        inner.busy = true;
        Ok(Self(mini))
    }
}

impl Drop for Step<'_> {
    fn drop(&mut self) {
        self.0.lock().busy = false;
    }
}

fn ease(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    if t < 0.5 {
        4.0 * t * t * t
    } else {
        1.0 - (-2.0 * t + 2.0).powi(3) / 2.0
    }
}

fn between(from: Frame, to: Frame, t: f64) -> Frame {
    let mix = |a: f64, b: f64| (a + (b - a) * t).round();
    Frame {
        x: mix(from.x as f64, to.x as f64) as i32,
        y: mix(from.y as f64, to.y as f64) as i32,
        width: mix(from.width as f64, to.width as f64).max(1.0) as u32,
        height: mix(from.height as f64, to.height as f64).max(1.0) as u32,
    }
}

/// Where the bubble stands in the whole window: `size` kept `corner` away from its right and
/// bottom edges, and never outside it.
fn corner_frame(full: Frame, corner: (i32, i32), size: (u32, u32)) -> Frame {
    let width = size.0.min(full.width);
    let height = size.1.min(full.height);
    Frame {
        x: (full.right() - corner.0.max(0) - width as i32).max(full.x),
        y: (full.bottom() - corner.1.max(0) - height as i32).max(full.y),
        width,
        height,
    }
}

fn overlap(a: Frame, b: Frame) -> i64 {
    let width = (a.right().min(b.right()) - a.x.max(b.x)).max(0) as i64;
    let height = (a.bottom().min(b.bottom()) - a.y.max(b.y)).max(0) as i64;
    width * height
}

/// A remembered place, brought back onto a screen that is there now. None: no screen shows
/// any of it (the display it was on is gone), and the mini player stays where it is.
fn place_on_screen(place: (i32, i32), size: (u32, u32), screens: &[Frame]) -> Option<(i32, i32)> {
    let wanted = Frame { x: place.0, y: place.1, width: size.0, height: size.1 };
    let screen = screens
        .iter()
        .copied()
        .max_by_key(|screen| overlap(wanted, *screen))
        .filter(|screen| overlap(wanted, *screen) > 0)?;
    let fit = |at: i32, length: u32, from: i32, room: u32| {
        let low = from + SCREEN_MARGIN;
        let high = from + room as i32 - SCREEN_MARGIN - length as i32;
        if high < low { from } else { at.clamp(low, high) }
    };
    Some((
        fit(place.0, size.0, screen.x, screen.width),
        fit(place.1, size.1, screen.y, screen.height),
    ))
}

/// Another size for the mini player where it is: it keeps the edges nearest to the edges of
/// its screen, so one parked in a bottom corner grows upwards.
fn resized_in_place(current: Frame, size: (u32, u32), screens: &[Frame]) -> Frame {
    let screen = screens.iter().copied().max_by_key(|screen| overlap(current, *screen));
    let (keep_right, keep_bottom) = screen.map_or((false, false), |screen| {
        let centre_x = current.x as i64 + current.width as i64 / 2;
        let centre_y = current.y as i64 + current.height as i64 / 2;
        (
            centre_x > screen.x as i64 + screen.width as i64 / 2,
            centre_y > screen.y as i64 + screen.height as i64 / 2,
        )
    });
    Frame {
        x: if keep_right { current.right() - size.0 as i32 } else { current.x },
        y: if keep_bottom { current.bottom() - size.1 as i32 } else { current.y },
        width: size.0,
        height: size.1,
    }
}

fn frame_of(window: &WebviewWindow) -> Result<Frame, String> {
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let size = window.inner_size().map_err(|error| error.to_string())?;
    Ok(Frame { x: position.x, y: position.y, width: size.width, height: size.height })
}

/// The parts of the screens a window may cover (without the menu bar, the Dock, the taskbar).
fn screens_of(window: &WebviewWindow) -> Vec<Frame> {
    window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| {
            let area = monitor.work_area();
            Frame { x: area.position.x, y: area.position.y, width: area.size.width, height: area.size.height }
        })
        .collect()
}

/// Both calls are made in one turn of the window's own thread, so no frame is shown between
/// the new size and the new position.
fn apply(window: &WebviewWindow, frame: Frame, resize: bool) {
    let target = window.clone();
    let applied = window.run_on_main_thread(move || {
        if resize {
            let _ = target.set_size(PhysicalSize::new(frame.width, frame.height));
        }
        let _ = target.set_position(PhysicalPosition::new(frame.x, frame.y));
    });
    if let Err(error) = applied {
        tracing::warn!("迷你播放器窗口未能移动：{error}");
    }
}

async fn animate(window: &WebviewWindow, from: Frame, to: Frame, duration: Duration) {
    let resize = from.width != to.width || from.height != to.height;
    if from == to {
        return;
    }
    let started = Instant::now();
    let mut shown = from;
    loop {
        let t = if duration.is_zero() {
            1.0
        } else {
            (started.elapsed().as_secs_f64() / duration.as_secs_f64()).min(1.0)
        };
        let next = between(from, to, ease(t));
        if next != shown {
            apply(window, next, resize);
            shown = next;
        }
        if t >= 1.0 {
            break;
        }
        tokio::time::sleep(TICK).await;
    }
    tokio::time::sleep(SETTLE).await;
}

fn time(animated: bool, ms: u64) -> Duration {
    Duration::from_millis(if animated { ms } else { 0 })
}

/// The red, yellow and green buttons lie over the page on macOS; the mini player has none.
#[cfg(target_os = "macos")]
fn show_window_buttons(window: &WebviewWindow, shown: bool) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::NSWindow;

    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        let Ok(raw) = target.ns_window() else { return; };
        // SAFETY: Tauri owns this NSWindow for target's lifetime, and the lookup and the
        // AppKit calls run in one main-thread closure holding that owner.
        let Some(native) = (unsafe { raw.cast::<NSWindow>().as_ref() }) else { return; };
        // NSWindowButton: close, miniaturize, zoom.
        for kind in 0usize..3 {
            // SAFETY: standardWindowButton: returns a view owned by the window, or nil.
            let button: *mut AnyObject = unsafe { msg_send![native, standardWindowButton: kind] };
            if let Some(button) = unsafe { button.as_ref() } {
                let _: () = unsafe { msg_send![button, setHidden: !shown] };
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn show_window_buttons(_window: &WebviewWindow, _shown: bool) {}

fn smallest_main_window(app: &AppHandle) -> Option<tauri::LogicalSize<f64>> {
    let config = app.config().app.windows.iter().find(|window| window.label == "main")?;
    Some(tauri::LogicalSize::new(config.min_width?, config.min_height?))
}

/// Gives the window the ways of a mini player, or the main window's own back.
fn dress(app: &AppHandle, window: &WebviewWindow, mini: bool, on_top: bool) {
    let smallest = if mini { None } else { smallest_main_window(app) };
    let results = [
        window.set_min_size(smallest),
        window.set_resizable(!mini),
        window.set_always_on_top(mini && on_top),
    ];
    for error in results.into_iter().filter_map(Result::err) {
        tracing::warn!("迷你播放器窗口属性未能切换：{error}");
    }
    show_window_buttons(window, !mini);
}

fn mini_of(app: &AppHandle) -> Result<tauri::State<'_, MiniPlayer>, String> {
    app.try_state::<MiniPlayer>().ok_or_else(|| "迷你播放器不可用".to_string())
}

/// Only the main window becomes the mini player; an editor window asking is a mistake.
fn main_only(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" { Ok(()) } else { Err("只有主窗口可以收成迷你播放器".into()) }
}

#[tauri::command]
pub fn mini_player_state(app: AppHandle) -> Result<MiniPlayerState, String> {
    Ok(mini_of(&app)?.state())
}

/// The window comes down to `rect`: where the bubble stands in the whole window (CSS pixels
/// of the viewport).
#[tauri::command]
pub async fn mini_player_collapse(
    app: AppHandle,
    window: WebviewWindow,
    rect: ClientRect,
    animated: bool,
) -> Result<MiniPlayerState, String> {
    main_only(&window)?;
    let mini = mini_of(&app)?;
    let _step = Step::begin(&mini)?;
    if mini.lock().session.is_some() {
        return Err("已经是迷你播放器".into());
    }
    if window.is_fullscreen().unwrap_or(false) {
        window.set_fullscreen(false).map_err(|error| error.to_string())?;
        // Leaving full screen is the system's own animation.
        for _ in 0..60 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            if !window.is_fullscreen().unwrap_or(false) {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    let maximized = window.is_maximized().unwrap_or(false);
    let full = frame_of(&window)?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let px = |value: f64| (value * scale).round();
    let bubble = Frame {
        x: full.x + px(rect.x) as i32,
        y: full.y + px(rect.y) as i32,
        width: px(rect.width).max(0.0) as u32,
        height: px(rect.height).max(0.0) as u32,
    };
    if bubble.width < SMALLEST
        || bubble.height < SMALLEST
        || bubble.x < full.x
        || bubble.y < full.y
        || bubble.right() > full.right()
        || bubble.bottom() > full.bottom()
    {
        return Err("曲目信息不在窗口里".into());
    }
    let on_top = {
        let mut inner = mini.lock();
        // From here on a move or a resize is the mini player's, not the main window's.
        inner.session = Some(Session {
            full,
            full_css: (full.width as f64 / scale, full.height as f64 / scale),
            maximized,
            corner: (full.right() - bubble.right(), full.bottom() - bubble.bottom()),
            settled: false,
        });
        inner.saved.on_top
    };
    if maximized {
        // A maximized window does not take a size; it is put back at the frame it shows.
        let _ = window.unmaximize();
        apply(&window, full, true);
        tokio::time::sleep(SETTLE).await;
    }
    dress(&app, &window, true, on_top);
    animate(&window, full, bubble, time(animated, RESIZE_MS)).await;
    Ok(mini.state())
}

/// The mini player goes to where it was last left, if that is still on a screen.
#[tauri::command]
pub async fn mini_player_settle(app: AppHandle, window: WebviewWindow, animated: bool) -> Result<(), String> {
    main_only(&window)?;
    let mini = mini_of(&app)?;
    let _step = Step::begin(&mini)?;
    let (active, place) = {
        let inner = mini.lock();
        (inner.session.is_some(), inner.saved.place)
    };
    if !active {
        return Err("不是迷你播放器".into());
    }
    let current = frame_of(&window)?;
    if let Some((x, y)) = place.and_then(|place| {
        place_on_screen(place, (current.width, current.height), &screens_of(&window))
    }) {
        animate(&window, current, Frame { x, y, ..current }, time(animated, TRAVEL_MS)).await;
    }
    if let Some(session) = mini.lock().session.as_mut() {
        session.settled = true;
    }
    Ok(())
}

/// The place it is left at is remembered, and it goes back to the bubble's corner of the
/// whole window.
#[tauri::command]
pub async fn mini_player_recall(app: AppHandle, window: WebviewWindow, animated: bool) -> Result<(), String> {
    main_only(&window)?;
    let mini = mini_of(&app)?;
    let _step = Step::begin(&mini)?;
    let current = frame_of(&window)?;
    let (session, saved) = {
        let mut inner = mini.lock();
        let Some(session) = inner.session.as_mut() else {
            return Err("不是迷你播放器".into());
        };
        // The way back is not a move of the listener's.
        session.settled = false;
        let session = *session;
        inner.saved.place = Some((current.x, current.y));
        (session, inner.saved)
    };
    mini.save(saved);
    let home = corner_frame(session.full, session.corner, (current.width, current.height));
    animate(&window, current, Frame { x: home.x, y: home.y, ..current }, time(animated, TRAVEL_MS)).await;
    Ok(())
}

/// The window grows back to what it was.
#[tauri::command]
pub async fn mini_player_expand(app: AppHandle, window: WebviewWindow, animated: bool) -> Result<MiniPlayerState, String> {
    main_only(&window)?;
    let mini = mini_of(&app)?;
    let _step = Step::begin(&mini)?;
    let Some(session) = mini.lock().session else {
        return Err("不是迷你播放器".into());
    };
    let current = frame_of(&window)?;
    animate(&window, current, session.full, time(animated, RESIZE_MS)).await;
    dress(&app, &window, false, false);
    if session.maximized {
        let _ = window.maximize();
    }
    // Only now is a move or a resize the main window's again.
    tokio::time::sleep(SETTLE).await;
    mini.lock().session = None;
    Ok(mini.state())
}

/// The bubble has another size (another song's title, another row): the window follows at
/// once. `width` and `height` are CSS pixels.
#[tauri::command]
pub fn mini_player_fit(app: AppHandle, window: WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    main_only(&window)?;
    let mini = mini_of(&app)?;
    {
        let inner = mini.lock();
        if inner.session.is_none() || inner.busy {
            return Ok(());
        }
    }
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let size = ((width * scale).round().max(0.0) as u32, (height * scale).round().max(0.0) as u32);
    if size.0 < SMALLEST || size.1 < SMALLEST {
        return Ok(());
    }
    let current = frame_of(&window)?;
    let next = resized_in_place(current, size, &screens_of(&window));
    if next != current {
        apply(&window, next, true);
    }
    Ok(())
}

#[tauri::command]
pub fn mini_player_set_on_top(app: AppHandle, window: WebviewWindow, on_top: bool) -> Result<MiniPlayerState, String> {
    main_only(&window)?;
    let mini = mini_of(&app)?;
    let (active, saved) = {
        let mut inner = mini.lock();
        inner.saved.on_top = on_top;
        (inner.session.is_some(), inner.saved)
    };
    mini.save(saved);
    if active {
        window.set_always_on_top(on_top).map_err(|error| error.to_string())?;
    }
    Ok(mini.state())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Frame = Frame { x: 0, y: 25, width: 1440, height: 875 };
    const FULL: Frame = Frame { x: 40, y: 60, width: 1360, height: 800 };

    #[test]
    fn the_frame_starts_and_ends_exactly_and_slows_at_both_ends() {
        let bubble = Frame { x: 1004, y: 700, width: 384, height: 148 };
        assert_eq!(between(FULL, bubble, ease(0.0)), FULL);
        assert_eq!(between(FULL, bubble, ease(1.0)), bubble);
        let early = between(FULL, bubble, ease(0.1));
        let middle = between(FULL, bubble, ease(0.5));
        assert!(FULL.width - early.width < 10, "slow out of the whole window: {early:?}");
        assert_eq!(middle.width, (FULL.width + bubble.width) / 2);
    }

    #[test]
    fn the_bubble_keeps_its_corner_of_the_whole_window() {
        let home = corner_frame(FULL, (12, 12), (384, 148));
        assert_eq!((home.right(), home.bottom()), (FULL.right() - 12, FULL.bottom() - 12));
        // Another song made it taller meanwhile: the same corner, higher up.
        assert_eq!(corner_frame(FULL, (12, 12), (384, 200)).bottom(), FULL.bottom() - 12);
        // Never outside the window it goes back into.
        let huge = corner_frame(FULL, (12, 12), (4000, 4000));
        assert_eq!(huge, FULL);
    }

    #[test]
    fn a_remembered_place_is_kept_on_a_screen_that_is_there() {
        let size = (384, 148);
        assert_eq!(place_on_screen((1000, 40), size, &[SCREEN]), Some((1000, 40)));
        // Half off the right edge: brought back in, a margin from the edge.
        assert_eq!(place_on_screen((1300, 40), size, &[SCREEN]), Some((1440 - 8 - 384, 40)));
        // Under the menu bar: below it.
        assert_eq!(place_on_screen((1000, 0), size, &[SCREEN]), Some((1000, 33)));
        // On a display that was unplugged: no place.
        assert_eq!(place_on_screen((3000, 40), size, &[SCREEN]), None);
        let second = Frame { x: 1440, y: 0, width: 1920, height: 1080 };
        assert_eq!(place_on_screen((3000, 40), size, &[SCREEN, second]), Some((2968, 40)));
    }

    #[test]
    fn a_resize_in_place_keeps_the_edges_nearest_the_screen_edges() {
        let bottom_right = Frame { x: 1040, y: 740, width: 384, height: 148 };
        let taller = resized_in_place(bottom_right, (384, 200), &[SCREEN]);
        assert_eq!((taller.right(), taller.bottom()), (bottom_right.right(), bottom_right.bottom()));
        let top_left = Frame { x: 16, y: 40, width: 384, height: 148 };
        let grown = resized_in_place(top_left, (384, 200), &[SCREEN]);
        assert_eq!((grown.x, grown.y), (16, 40));
    }

    #[test]
    fn it_floats_unless_the_listener_said_otherwise() {
        assert!(Saved::default().on_top);
        let saved: Saved = serde_json::from_str(r#"{"place":[10,20]}"#).unwrap();
        assert_eq!(saved, Saved { place: Some((10, 20)), on_top: true });
        let saved: Saved = serde_json::from_str(r#"{"on_top":false}"#).unwrap();
        assert_eq!(saved, Saved { place: None, on_top: false });
    }
}
