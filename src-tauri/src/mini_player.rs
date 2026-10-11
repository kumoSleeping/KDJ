//! The main window as a mini player: the window itself is taken down to the playing song's
//! bubble and brought back, so playback, the page and its state never leave their WebView.
//!
//! The page owns what is drawn and the order of the steps (src/lib/miniPlayer.ts); this owns the
//! window's frame. The window never changes size where it can be seen: it is taken out of
//! sight (`conceal`), given its new size, and shown again (`mini_player_reveal`) once the page
//! has drawn for that size.
//!
//! Down, the whole window is gone at once, and the mini player pops out of the nearest corner
//! of its screen at the place it was last left at. Back, it goes into that corner again, and
//! the whole window fades in. Those are all the steps, and between them the window is out of
//! sight for as long as the page needs to draw the other size, and no longer. Nothing flies
//! from one place to another, nothing stands in for the window meanwhile, and nothing waits
//! for the look of it.
//!
//! Every platform runs the same steps through the same window calls; only the macOS window
//! buttons and its fade need calls of their own.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

const STATE_FILE: &str = "mini-player.json";
/// The mini player pops out of the nearest corner of its screen and goes back into it: this
/// far (CSS pixels), appearing as it comes and gone before it has arrived there.
const POP_PX: f64 = 32.0;
const POP_IN_MS: u64 = 200;
const POP_OUT_MS: u64 = 150;
/// The share of the pop's time the mini player takes to be all there, or to be gone.
const POP_FADE: f64 = 0.7;
/// A window left out of sight is shown after this long whatever the page does.
const REVEAL_WITHIN: Duration = Duration::from_millis(1600);
/// The whole window comes back by a short fade (macOS). It goes at once.
const FADE_IN_MS: u64 = 140;
/// All but clear rather than clear: still a window on show to the system, so the page in it
/// goes on drawing.
const CLEAR: f64 = 0.01;
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
    /// The window is out of sight with a new size: where it is shown again.
    pending: Option<Frame>,
    /// That new size is the whole window's: showing it ends the mini player.
    expanding: bool,
}

#[derive(Default)]
struct Inner {
    saved: Saved,
    session: Option<Session>,
    busy: bool,
    /// Each way down or back owns its fallback; a timer from another way does nothing.
    generation: u64,
}

pub struct MiniPlayer {
    path: PathBuf,
    inner: Mutex<Inner>,
    /// Window mutations, including a fallback reveal, must finish before the next begins.
    steps: tokio::sync::Mutex<()>,
}

/// The bubble as it stands in the whole window, in CSS pixels of the viewport.
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
        Self { path, inner: Mutex::new(Inner { saved, ..Inner::default() }), steps: tokio::sync::Mutex::new(()) }
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

/// One step at a time, through its last animation frame. A page reveal waits for a fallback
/// already showing the window rather than returning while that animation is still running.
struct Step<'a> {
    mini: &'a MiniPlayer,
    _guard: tokio::sync::MutexGuard<'a, ()>,
}

impl<'a> Step<'a> {
    async fn begin(mini: &'a MiniPlayer) -> Self {
        let guard = mini.steps.lock().await;
        mini.lock().busy = true;
        Self { mini, _guard: guard }
    }

    /// A resize notification during a transition is superseded by the next measurement.
    fn try_begin(mini: &'a MiniPlayer) -> Option<Self> {
        let guard = mini.steps.try_lock().ok()?;
        mini.lock().busy = true;
        Some(Self { mini, _guard: guard })
    }
}

impl Drop for Step<'_> {
    fn drop(&mut self) {
        self.mini.lock().busy = false;
    }
}

/// Whether the mini player comes out of its corner or goes into it. It fades as it moves
/// (macOS; elsewhere a window has no such thing and it only moves).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Pop {
    Out,
    Away,
}

/// How solid the window is when `t` of the pop's time has gone.
fn faded(pop: Pop, t: f64) -> f64 {
    let solid = match pop {
        Pop::Out => t / POP_FADE,
        Pop::Away => (1.0 - t) / POP_FADE,
    };
    CLEAR + (1.0 - CLEAR) * solid.clamp(0.0, 1.0)
}

/// How far along its way the window is: coming out it slows into its place, going away it
/// gathers speed.
fn paced(pop: Pop, t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    match pop {
        Pop::Out => 1.0 - (1.0 - t).powi(3),
        Pop::Away => t * t,
    }
}

/// Where `frame` is tucked a little way (`reach`, physical pixels) into the nearest corner of
/// its screen: where the mini player pops out from and goes back into. Never beyond the
/// screen: macOS does not let a window past the top, and one sent there stops at the edge.
fn tucked(frame: Frame, screens: &[Frame], reach: i32) -> Frame {
    let Some(screen) = screens.iter().copied().max_by_key(|screen| overlap(frame, *screen)) else {
        return frame;
    };
    let towards = |at: i32, length: u32, from: i32, room: u32| {
        let last = from + room as i32 - length as i32;
        if last < from {
            return at;
        }
        let far = at as i64 + length as i64 / 2 > from as i64 + room as i64 / 2;
        (if far { at + reach } else { at - reach }).clamp(from.min(at), last.max(at))
    };
    Frame {
        x: towards(frame.x, frame.width, screen.x, screen.width),
        y: towards(frame.y, frame.height, screen.y, screen.height),
        ..frame
    }
}

/// Where the mini player is shown: with `size` at the place it was last left at, or with no
/// such place on a screen that is there, at `corner` (the bubble's corner of the whole window).
fn shown_at(place: Option<(i32, i32)>, corner: Frame, screens: &[Frame]) -> Frame {
    place
        .and_then(|place| place_on_screen(place, (corner.width, corner.height), screens))
        .map_or(corner, |(x, y)| Frame { x, y, ..corner })
}

/// A corner no screen shows: a window put there is not seen, and is still a window that
/// draws. Not on macOS, which brings a window back onto its screen when it is given a size.
fn beyond(screens: &[Frame]) -> (i32, i32) {
    let right = screens.iter().map(|screen| screen.right()).max().unwrap_or(0);
    let bottom = screens.iter().map(|screen| screen.bottom()).max().unwrap_or(0);
    (right.saturating_add(400), bottom.saturating_add(400))
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

/// The screens, whole.
fn monitors_of(window: &WebviewWindow) -> Vec<Frame> {
    window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| {
            let (position, size) = (monitor.position(), monitor.size());
            Frame { x: position.x, y: position.y, width: size.width, height: size.height }
        })
        .collect()
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

/// Both calls are made in one turn of the window's own thread. The position first: a window
/// that is being put out of sight is gone before it has another size.
fn apply(window: &WebviewWindow, frame: Frame, resize: bool) {
    let target = window.clone();
    let applied = window.run_on_main_thread(move || {
        let _ = target.set_position(PhysicalPosition::new(frame.x, frame.y));
        if resize {
            let _ = target.set_size(PhysicalSize::new(frame.width, frame.height));
        }
    });
    if let Err(error) = applied {
        tracing::warn!("迷你播放器窗口未能移动：{error}");
    }
}

/// The mini player comes out of its corner, or goes into it: from `from` to `to`, fading.
async fn pop(window: &WebviewWindow, from: Frame, to: Frame, duration: Duration, pop: Pop) {
    let started = Instant::now();
    let mut shown = from;
    loop {
        let t = if duration.is_zero() {
            1.0
        } else {
            (started.elapsed().as_secs_f64() / duration.as_secs_f64()).min(1.0)
        };
        let next = between(from, to, paced(pop, t));
        set_alpha(window, faded(pop, t));
        if next != shown {
            apply(window, next, false);
            shown = next;
        }
        if t >= 1.0 {
            break;
        }
        tokio::time::sleep(TICK).await;
    }
}

/// How far the mini player's pop reaches, in physical pixels.
fn reach_of(window: &WebviewWindow) -> i32 {
    (POP_PX * window.scale_factor().unwrap_or(1.0)).round() as i32
}

/// How solid the window is. macOS only: there a window that is given a size is brought back
/// onto its screen, so it cannot be put out of sight by moving it.
#[cfg(target_os = "macos")]
fn set_alpha(window: &WebviewWindow, alpha: f64) {
    use objc2::msg_send;
    use objc2_app_kit::NSWindow;

    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        let Ok(raw) = target.ns_window() else { return; };
        // SAFETY: Tauri owns this NSWindow for target's lifetime, and the lookup and the
        // AppKit call run in one main-thread closure holding that owner.
        let Some(native) = (unsafe { raw.cast::<NSWindow>().as_ref() }) else { return; };
        // SAFETY: setAlphaValue: takes a CGFloat and returns nothing.
        let _: () = unsafe { msg_send![native, setAlphaValue: alpha] };
    });
}

#[cfg(not(target_os = "macos"))]
fn set_alpha(_window: &WebviewWindow, _alpha: f64) {}

/// The window fades from `from` to `to`. Nothing happens where a window has no such thing.
async fn fade(window: &WebviewWindow, from: f64, to: f64, duration: Duration) {
    if !cfg!(target_os = "macos") {
        return;
    }
    let started = Instant::now();
    loop {
        let t = if duration.is_zero() {
            1.0
        } else {
            (started.elapsed().as_secs_f64() / duration.as_secs_f64()).min(1.0)
        };
        set_alpha(window, from + (to - from) * t);
        if t >= 1.0 {
            break;
        }
        tokio::time::sleep(TICK).await;
    }
}

/// Takes the window out of sight as it is, at once: nothing of what is done to it next (its
/// ways, its size) is seen. Clear on macOS; elsewhere beyond the screens, where a window
/// stays put.
fn conceal(window: &WebviewWindow) -> Result<(), String> {
    if cfg!(target_os = "macos") {
        set_alpha(window, CLEAR);
    } else {
        let current = frame_of(window)?;
        apply(window, out_of_sight(window, current), false);
    }
    Ok(())
}

/// Where a concealed window that is to be shown at `frame` is kept: at `frame` itself on
/// macOS, where it is clear (and a window that is given a size is brought back onto its
/// screen); elsewhere beyond the screens.
fn out_of_sight(window: &WebviewWindow, frame: Frame) -> Frame {
    if cfg!(target_os = "macos") {
        return frame;
    }
    let (x, y) = beyond(&monitors_of(window));
    Frame { x, y, ..frame }
}

/// A concealed window is shown by `mini_player_reveal`. Should the page never ask, only this
/// transition is shown anyway: an old timer must not consume a later transition's pending frame.
fn shown_at_last(app: &AppHandle, window: &WebviewWindow, generation: u64, animated: bool) {
    let (app, window) = (app.clone(), window.clone());
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(REVEAL_WITHIN).await;
        reveal(&app, &window, generation, animated).await;
    });
}

/// Shows a concealed window. The whole window fades in where it was. The mini player pops
/// out of the nearest corner of its screen. Once: a second call waits, then finds nothing pending.
async fn reveal(app: &AppHandle, window: &WebviewWindow, generation: u64, animated: bool) {
    let Some(mini) = app.try_state::<MiniPlayer>() else { return; };
    let _step = Step::begin(&mini).await;
    let shown = {
        let mut inner = mini.lock();
        if inner.generation != generation {
            return;
        }
        inner.session.as_mut().and_then(|session| {
            let frame = session.pending.take()?;
            Some((frame, *session))
        })
    };
    let Some((frame, session)) = shown else { return; };
    if session.expanding {
        apply(window, frame, true);
        if session.maximized {
            let _ = window.maximize();
            tokio::time::sleep(SETTLE).await;
        }
        fade(window, CLEAR, 1.0, time(animated, FADE_IN_MS)).await;
        tokio::time::sleep(SETTLE).await;
        // Only now is a move or a resize the main window's again.
        mini.lock().session = None;
        return;
    }
    let from = tucked(frame, &screens_of(window), reach_of(window));
    // Its size as well: it has it already, unless the page never came to give it one.
    apply(window, from, true);
    pop(window, from, frame, time(animated, POP_IN_MS), Pop::Out).await;
    tokio::time::sleep(SETTLE).await;
    // From here on a move is the listener's own.
    let mut inner = mini.lock();
    if let Some(session) = inner.session.as_mut() {
        session.settled = true;
    }
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
        // Floating, it is on every desktop: it stays in sight when the listener changes desktop.
        window.set_visible_on_all_workspaces(mini && on_top),
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

/// The whole window is gone at once and is the mini player from here on, out of sight and still
/// of the whole window's size: `rect` is the bubble as it stands in it. The page gives it the
/// bubble's size when it has made ready for it (`mini_player_fit`), and `mini_player_reveal`
/// shows it at the place it was last left at.
#[tauri::command]
pub async fn mini_player_collapse(
    app: AppHandle,
    window: WebviewWindow,
    rect: ClientRect,
    animated: bool,
) -> Result<MiniPlayerState, String> {
    main_only(&window)?;
    let mini = mini_of(&app)?;
    let _step = Step::begin(&mini).await;
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
    let corner = (full.right() - bubble.right(), full.bottom() - bubble.bottom());
    let screens = screens_of(&window);
    let (on_top, generation) = {
        let mut inner = mini.lock();
        inner.generation = inner.generation.wrapping_add(1);
        let start = shown_at(inner.saved.place, bubble, &screens);
        // From here on a move or a resize is the mini player's, not the main window's.
        inner.session = Some(Session {
            full,
            full_css: (full.width as f64 / scale, full.height as f64 / scale),
            maximized,
            corner,
            settled: false,
            pending: Some(start),
            expanding: false,
        });
        (inner.saved.on_top, inner.generation)
    };
    // At once, with motion or without: there is nothing to animate about its going.
    conceal(&window)?;
    if maximized {
        // A maximized window does not take a size.
        let _ = window.unmaximize();
        tokio::time::sleep(SETTLE).await;
    }
    dress(&app, &window, true, on_top);
    shown_at_last(&app, &window, generation, animated);
    Ok(mini.state())
}

/// The page has drawn for the window's new size: the window is shown where it belongs.
#[tauri::command]
pub async fn mini_player_reveal(app: AppHandle, window: WebviewWindow, animated: bool) -> Result<MiniPlayerState, String> {
    main_only(&window)?;
    let mini = mini_of(&app)?;
    let generation = mini.lock().generation;
    reveal(&app, &window, generation, animated).await;
    Ok(mini.state())
}

/// Back to the whole window. The mini player goes into the nearest corner of its screen; the
/// window is the whole window again, out of sight until `mini_player_reveal`. Where the mini
/// player stood is where it is found next time.
#[tauri::command]
pub async fn mini_player_expand(app: AppHandle, window: WebviewWindow, animated: bool) -> Result<MiniPlayerState, String> {
    main_only(&window)?;
    let mini = mini_of(&app)?;
    let _step = Step::begin(&mini).await;
    let current = frame_of(&window)?;
    let (session, shown, saved, generation) = {
        let mut inner = mini.lock();
        let Some(session) = inner.session.as_mut() else {
            return Err("不是迷你播放器".into());
        };
        // On show at its place, or given back from a step that went wrong.
        let shown = session.settled && session.pending.is_none();
        session.settled = false;
        session.pending = Some(session.full);
        session.expanding = true;
        let session = *session;
        if shown {
            inner.saved.place = Some((current.x, current.y));
        }
        inner.generation = inner.generation.wrapping_add(1);
        (session, shown, inner.saved, inner.generation)
    };
    if shown {
        mini.save(saved);
        let to = tucked(current, &screens_of(&window), reach_of(&window));
        pop(&window, current, to, time(animated, POP_OUT_MS), Pop::Away).await;
    }
    conceal(&window)?;
    dress(&app, &window, false, false);
    apply(&window, out_of_sight(&window, session.full), true);
    shown_at_last(&app, &window, generation, animated);
    Ok(mini.state())
}

/// The bubble's size (CSS pixels): the window takes it at once. Out of sight on its way down,
/// that is the size it is going to be shown with, at the place it was last left at; on show
/// (another song's title, another row), it keeps the edges nearest its screen's.
#[tauri::command]
pub fn mini_player_fit(app: AppHandle, window: WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    main_only(&window)?;
    let mini = mini_of(&app)?;
    let Some(_step) = Step::try_begin(&mini) else { return Ok(()); };
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let size = ((width * scale).round().max(0.0) as u32, (height * scale).round().max(0.0) as u32);
    if size.0 < SMALLEST || size.1 < SMALLEST {
        return Ok(());
    }
    let screens = screens_of(&window);
    let waiting = {
        let mut inner = mini.lock();
        let Some(session) = inner.session.as_mut().filter(|session| !session.expanding) else {
            return Ok(());
        };
        let session = *session;
        let place = inner.saved.place;
        session.pending.is_some().then(|| {
            let start = shown_at(place, corner_frame(session.full, session.corner, size), &screens);
            if let Some(session) = inner.session.as_mut() {
                session.pending = Some(start);
            }
            start
        })
    };
    if let Some(start) = waiting {
        apply(&window, out_of_sight(&window, start), true);
        return Ok(());
    }
    let current = frame_of(&window)?;
    let next = resized_in_place(current, size, &screens);
    if next != current {
        apply(&window, next, true);
    }
    Ok(())
}

#[tauri::command]
pub async fn mini_player_set_on_top(app: AppHandle, window: WebviewWindow, on_top: bool) -> Result<MiniPlayerState, String> {
    main_only(&window)?;
    let mini = mini_of(&app)?;
    let _step = Step::begin(&mini).await;
    let (active, saved) = {
        let mut inner = mini.lock();
        inner.saved.on_top = on_top;
        (inner.session.is_some_and(|session| !session.expanding), inner.saved)
    };
    mini.save(saved);
    if active {
        window.set_always_on_top(on_top).map_err(|error| error.to_string())?;
        window.set_visible_on_all_workspaces(on_top).map_err(|error| error.to_string())?;
    }
    Ok(mini.state())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Frame = Frame { x: 0, y: 25, width: 1440, height: 875 };
    const FULL: Frame = Frame { x: 40, y: 60, width: 1360, height: 800 };

    #[test]
    fn it_pops_out_of_the_nearest_corner_of_its_screen_and_never_beyond_it() {
        // At the top right, 60 from the right edge and 8 under the menu bar: from the right,
        // and from no higher than the screen's top.
        let place = Frame { x: 996, y: 33, width: 384, height: 148 };
        assert_eq!(tucked(place, &[SCREEN], 32), Frame { x: 1028, y: 25, ..place });
        // At the bottom left: from the left and from below.
        let low = Frame { x: 100, y: 600, width: 384, height: 148 };
        assert_eq!(tucked(low, &[SCREEN], 32), Frame { x: 68, y: 632, ..low });
        // Against the edge already: it has nowhere to come from on that side.
        let edge = Frame { x: 1440 - 384, y: 300, width: 384, height: 148 };
        assert_eq!(tucked(edge, &[SCREEN], 32).x, edge.x);
        assert_eq!(tucked(place, &[], 32), place);
        // It comes out slowing into its place and is all there before it arrives; it goes
        // gathering speed and is gone before it has got there.
        assert_eq!(between(low, place, paced(Pop::Out, 0.0)), low);
        assert_eq!(between(low, place, paced(Pop::Out, 1.0)), place);
        assert!(paced(Pop::Out, 0.5) > 0.8 && paced(Pop::Away, 0.5) < 0.3);
        assert!(faded(Pop::Out, 0.0) < 0.02 && faded(Pop::Out, 0.7) > 0.99 && faded(Pop::Out, 1.0) > 0.99);
        assert!(faded(Pop::Away, 0.0) > 0.99 && faded(Pop::Away, 0.3) > 0.99 && faded(Pop::Away, 1.0) < 0.02);
    }

    #[test]
    fn it_is_shown_where_it_was_left_or_else_where_the_bubble_stood() {
        let corner = corner_frame(FULL, (12, 12), (384, 148));
        assert_eq!(shown_at(Some((1000, 40)), corner, &[SCREEN]), Frame { x: 1000, y: 40, ..corner });
        assert_eq!(shown_at(None, corner, &[SCREEN]), corner);
        // Left on a display that is gone: where the bubble stood.
        assert_eq!(shown_at(Some((3000, 40)), corner, &[SCREEN]), corner);
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
