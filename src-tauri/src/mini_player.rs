//! The main window as a mini player: the window itself is taken down to the playing song's
//! bubble and brought back, so playback, the page and its state never leave their WebView.
//!
//! The page owns what is drawn and the order of the steps (src/lib/miniPlayer.ts); this owns the
//! window's frame. The window never changes size where it can be seen: it is taken out of
//! sight (`conceal`), given its new size, and shown again (`mini_player_reveal`) once the page
//! has drawn for that size.
//!
//! Down, the whole window fades away; the mini player appears where the bubble stood in it and
//! jumps, in an arc like something thrown, to the place it was last left at. Back, it jumps to
//! the bubble's corner of the whole window, is gone as it lands, and the whole window is there.
//! Those are all the steps: a fade and the jump, and between them the window is out of sight
//! for as long as the page needs to draw the other size, and no longer. Nothing stands in for
//! it meanwhile and nothing waits for the look of it.
//!
//! Every platform runs the same steps through the same window calls; only the macOS window
//! buttons and its fade need calls of their own.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

const STATE_FILE: &str = "mini-player.json";
/// The jump between the bubble's corner of the whole window and the mini player's place.
const FLIGHT_MS: u64 = 340;
/// The share of the jump's time the mini player takes to appear as it sets off, and to be gone
/// as it lands.
const FLIGHT_FADE: f64 = 0.25;
/// A window left out of sight is shown after this long whatever the page does.
const REVEAL_WITHIN: Duration = Duration::from_millis(1600);
/// The whole window goes out of sight and comes back by a short fade (macOS): a hard cut
/// there read as a flicker.
const FADE_OUT_MS: u64 = 70;
const FADE_IN_MS: u64 = 100;
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
}

pub struct MiniPlayer {
    path: PathBuf,
    inner: Mutex<Inner>,
}

/// The bubble as it stands in the whole window, in CSS pixels of the viewport.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct ClientRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    /// How tall the page expects it to be as the mini player (with its transport row).
    tall: f64,
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

/// Whether the mini player appears as it sets off on its jump or is gone as it lands (macOS;
/// elsewhere a window has no such thing and nothing happens).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Fade {
    In,
    Out,
}

/// How solid the window is when `t` of the jump's time has gone.
fn faded(fade: Fade, t: f64) -> f64 {
    let solid = match fade {
        Fade::In => t / FLIGHT_FADE,
        Fade::Out => (1.0 - t) / FLIGHT_FADE,
    };
    CLEAR + (1.0 - CLEAR) * solid.clamp(0.0, 1.0)
}

fn ease(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    if t < 0.5 {
        4.0 * t * t * t
    } else {
        1.0 - (-2.0 * t + 2.0).powi(3) / 2.0
    }
}

/// How high a flight rises above the straight line between its ends, in physical pixels.
fn arc_of(from: Frame, to: Frame, scale: f64) -> f64 {
    let distance = ((to.x - from.x) as f64).hypot((to.y - from.y) as f64);
    if distance < 1.0 { 0.0 } else { (distance * 0.3).clamp(56.0 * scale, 240.0 * scale) }
}

/// The highest point a flight reaches: its smallest y.
fn summit(from: Frame, to: Frame, arc: f64) -> f64 {
    let (start, fall) = (from.y as f64, (to.y - from.y) as f64);
    let at = |t: f64| start + fall * t - arc * 4.0 * t * (1.0 - t);
    let turn = if arc > 0.0 { ((4.0 * arc - fall) / (8.0 * arc)).clamp(0.0, 1.0) } else { 0.0 };
    at(turn).min(at(0.0)).min(at(1.0))
}

/// `arc`, lowered until the flight stays below `ceiling`: macOS does not let a window above
/// the top of its screen, and one sent there stops at the edge and slides along it. A straight
/// line when no arc fits.
fn arc_within(from: Frame, to: Frame, arc: f64, ceiling: i32) -> f64 {
    let mut arc = arc;
    for _ in 0..16 {
        if summit(from, to, arc) >= ceiling as f64 {
            return arc;
        }
        arc *= 0.7;
    }
    0.0
}

/// The top of the screens a flight starts and ends on: the lower of the two.
fn ceiling_of(from: Frame, to: Frame, screens: &[Frame]) -> i32 {
    [from, to]
        .into_iter()
        .filter_map(|frame| screens.iter().copied().max_by_key(|screen| overlap(frame, *screen)))
        .map(|screen| screen.y)
        .max()
        .unwrap_or(i32::MIN)
}

/// The frame at `t` of a flight: along the line, lifted by a parabola that is `arc` high
/// halfway and nothing at both ends.
fn along(from: Frame, to: Frame, t: f64, arc: f64) -> Frame {
    let mut frame = between(from, to, t);
    frame.y -= (arc * 4.0 * t * (1.0 - t)).round() as i32;
    frame
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

/// Moves the window from `from` to `to`, rising `arc` above the straight line on the way,
/// slow at both ends.
async fn animate(window: &WebviewWindow, from: Frame, to: Frame, duration: Duration, arc: f64, fade: Fade) {
    let started = Instant::now();
    let mut shown = from;
    loop {
        let t = if duration.is_zero() {
            1.0
        } else {
            (started.elapsed().as_secs_f64() / duration.as_secs_f64()).min(1.0)
        };
        let next = along(from, to, ease(t), arc);
        set_alpha(window, faded(fade, t));
        if next != shown {
            apply(window, next, false);
            shown = next;
        }
        if t >= 1.0 {
            break;
        }
        tokio::time::sleep(TICK).await;
    }
    tokio::time::sleep(SETTLE).await;
}

/// The jump between the bubble's corner of the whole window and the mini player's place.
async fn jump(window: &WebviewWindow, from: Frame, to: Frame, animated: bool, fade: Fade) {
    let rise = arc_of(from, to, window.scale_factor().unwrap_or(1.0));
    let arc = arc_within(from, to, rise, ceiling_of(from, to, &screens_of(window)));
    animate(window, from, to, time(animated, FLIGHT_MS), arc, fade).await;
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

/// Takes the window out of sight as it is: nothing of what is done to it next (its ways, its
/// size) is seen. Faded out on macOS over `fade`; elsewhere beyond the screens, where a window
/// stays put.
async fn conceal(window: &WebviewWindow, fade_for: Duration) -> Result<(), String> {
    if cfg!(target_os = "macos") {
        fade(window, 1.0, CLEAR, fade_for).await;
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

/// A concealed window takes `frame`'s size; `mini_player_reveal` shows it at `frame`. Should
/// the page never ask, it is shown anyway.
fn park(app: &AppHandle, window: &WebviewWindow, frame: Frame) {
    apply(window, out_of_sight(window, frame), true);
    let (app, window) = (app.clone(), window.clone());
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(REVEAL_WITHIN).await;
        reveal(&app, &window, true).await;
    });
}

/// Shows a concealed window. The whole window fades in where it was. The mini player appears
/// where the bubble stood in the whole window and jumps to the place it was last left at;
/// with no such place on a screen that is there, it fades in and stays. Once: a second call
/// finds nothing pending.
async fn reveal(app: &AppHandle, window: &WebviewWindow, animated: bool) {
    let Some(mini) = app.try_state::<MiniPlayer>() else { return; };
    let shown = {
        let mut inner = mini.lock();
        let place = inner.saved.place;
        inner.session.as_mut().and_then(|session| {
            let frame = session.pending.take()?;
            Some((frame, *session, place))
        })
    };
    let Some((frame, session, place)) = shown else { return; };
    apply(window, frame, false);
    if session.expanding {
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
    let to = place
        .and_then(|place| place_on_screen(place, (frame.width, frame.height), &screens_of(window)))
        .map_or(frame, |(x, y)| Frame { x, y, ..frame });
    if to == frame {
        fade(window, CLEAR, 1.0, time(animated, FADE_IN_MS)).await;
    } else {
        jump(window, frame, to, animated, Fade::In).await;
    }
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

/// The whole window fades away and the window becomes the bubble, out of sight: `rect` is the
/// bubble as it stands in the whole window. `mini_player_reveal` shows it there and sends it
/// to its place.
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
    let corner = (full.right() - bubble.right(), full.bottom() - bubble.bottom());
    let tall = px(rect.tall).max(0.0) as u32;
    let start = corner_frame(full, corner, (bubble.width, if tall < SMALLEST { bubble.height } else { tall }));
    let on_top = {
        let mut inner = mini.lock();
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
        inner.saved.on_top
    };
    conceal(&window, time(animated, FADE_OUT_MS)).await?;
    if maximized {
        // A maximized window does not take a size.
        let _ = window.unmaximize();
        tokio::time::sleep(SETTLE).await;
    }
    dress(&app, &window, true, on_top);
    park(&app, &window, start);
    Ok(mini.state())
}

/// The page has drawn for the window's new size: the window is shown where it belongs.
#[tauri::command]
pub async fn mini_player_reveal(app: AppHandle, window: WebviewWindow, animated: bool) -> Result<MiniPlayerState, String> {
    main_only(&window)?;
    reveal(&app, &window, animated).await;
    Ok(mini_of(&app)?.state())
}

/// Back to the whole window. The mini player jumps to the bubble's corner of the whole window
/// and is gone as it lands; the window is the whole window again, out of sight until
/// `mini_player_reveal`. Where the mini player stood is where it is found next time.
#[tauri::command]
pub async fn mini_player_expand(app: AppHandle, window: WebviewWindow, animated: bool) -> Result<MiniPlayerState, String> {
    main_only(&window)?;
    let mini = mini_of(&app)?;
    let _step = Step::begin(&mini)?;
    let current = frame_of(&window)?;
    let (session, shown, saved) = {
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
        (session, shown, inner.saved)
    };
    let home = corner_frame(session.full, session.corner, (current.width, current.height));
    let to = Frame { x: home.x, y: home.y, ..current };
    if shown {
        mini.save(saved);
    }
    if shown && to != current {
        jump(&window, current, to, animated, Fade::Out).await;
        conceal(&window, Duration::ZERO).await?;
    } else {
        conceal(&window, time(animated, FADE_OUT_MS)).await?;
    }
    dress(&app, &window, false, false);
    park(&app, &window, session.full);
    Ok(mini.state())
}

/// The bubble has another size (another song's title, another row): the window follows at
/// once. `width` and `height` are CSS pixels. Out of sight on its way down, it keeps the
/// bubble's corner of the whole window; at its place, the edges nearest its screen's.
#[tauri::command]
pub fn mini_player_fit(app: AppHandle, window: WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    main_only(&window)?;
    let mini = mini_of(&app)?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let size = ((width * scale).round().max(0.0) as u32, (height * scale).round().max(0.0) as u32);
    if size.0 < SMALLEST || size.1 < SMALLEST {
        return Ok(());
    }
    let waiting = {
        let mut inner = mini.lock();
        if inner.busy {
            return Ok(());
        }
        let Some(session) = inner.session.as_mut().filter(|session| !session.expanding) else {
            return Ok(());
        };
        session.pending.is_some().then(|| {
            let start = corner_frame(session.full, session.corner, size);
            session.pending = Some(start);
            start
        })
    };
    if let Some(start) = waiting {
        apply(&window, out_of_sight(&window, start), true);
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
    fn a_flight_rises_between_its_ends_and_lands_exactly() {
        let from = Frame { x: 1004, y: 700, width: 384, height: 148 };
        let to = Frame { x: 40, y: 600, width: 384, height: 148 };
        let arc = arc_of(from, to, 2.0);
        assert!(arc >= 112.0 && arc <= 480.0, "{arc}");
        assert_eq!(along(from, to, 0.0, arc), from);
        assert_eq!(along(from, to, 1.0, arc), to);
        assert_eq!(along(from, to, 0.5, arc).y, 650 - arc.round() as i32);
        // Nowhere to go: no arc.
        assert_eq!(arc_of(from, from, 2.0), 0.0);
    }

    #[test]
    fn a_flight_stays_below_the_top_of_its_screen() {
        // From the bottom right of the whole window to the top right of the screen.
        let from = Frame { x: 2000, y: 1500, width: 768, height: 296 };
        let to = Frame { x: 2096, y: 66, width: 768, height: 296 };
        let rise = arc_of(from, to, 2.0);
        assert!(summit(from, to, rise) < 60.0, "as thrown it would pass the top: {}", summit(from, to, rise));
        let arc = arc_within(from, to, rise, 60);
        assert!(arc > 0.0 && arc < rise, "{arc}");
        assert!(summit(from, to, arc) >= 60.0);
        // With room above, the arc is as thrown; with none at either end, a straight line.
        assert_eq!(arc_within(from, to, rise, -4000), rise);
        assert_eq!(arc_within(from, to, rise, 100), 0.0);
        // Downwards, the summit is where it started or above.
        assert!(summit(to, from, rise) <= 66.0);
        let screens = [SCREEN, Frame { x: 1440, y: 0, width: 1920, height: 1080 }];
        assert_eq!(ceiling_of(FULL, Frame { x: 2000, y: 40, width: 384, height: 148 }, &screens), 25);
        // The mini player is there before a quarter of its jump has gone, and gone the same way.
        assert!(faded(Fade::In, 0.0) < 0.02 && faded(Fade::In, 0.25) > 0.99 && faded(Fade::In, 1.0) > 0.99);
        assert!(faded(Fade::Out, 0.0) > 0.99 && faded(Fade::Out, 0.75) > 0.99 && faded(Fade::Out, 1.0) < 0.02);
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
