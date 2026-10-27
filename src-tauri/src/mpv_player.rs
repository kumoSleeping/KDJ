//! Native video window backed by libmpv (macOS).
//!
//! libmpv is optional. It is opened with dlopen on first use from `KDJ_LIBMPV`, the app bundle's
//! Frameworks (bundled by `tauri.mpv.conf.json`) or, in a debug build, `src-tauri/vendor/libmpv`
//! (`scripts/build-libmpv-macos.sh`). Without it `mpv_status` reports unavailable and the page
//! keeps its WebView `<video>` player.
//!
//! Each player is drawn by mpv's OpenGL render API into an NSView placed *under* the main
//! WebView, which stops painting its background: the page leaves a hole over the video
//! (videoHoles.ts), so its own controls draw over the picture as they do over a `<video>`.
//! Two ways to drive it:
//! - `network`: mpv owns transport and sound (online previews read from KDJ's loopback server);
//! - `follow`: picture only, following the clock of KDJ's native audio (`mpv_follow`): exact seeks
//!   for jumps and pauses, small speed changes for drift while it plays.

use serde::Serialize;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvAvailability {
    available: bool,
    version: Option<String>,
    error: Option<String>,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvPlaybackStatus {
    generation: u64,
    playing: bool,
    buffering: bool,
    ended: bool,
    position: f64,
    duration: f64,
    width: i64,
    height: i64,
    error: Option<String>,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const STATUS_EVENT: &str = "kdj:mpv-status";

fn require_main(caller: &tauri::Webview) -> Result<(), String> {
    if caller.label() == "main" {
        Ok(())
    } else {
        Err("视频播放器命令只允许主界面调用".into())
    }
}

fn valid_bounds(x: f64, y: f64, width: f64, height: f64) -> bool {
    [x, y, width, height].into_iter().all(f64::is_finite)
        && (-20_000.0..=20_000.0).contains(&x)
        && (-20_000.0..=20_000.0).contains(&y)
        && (0.0..=20_000.0).contains(&width)
        && (0.0..=20_000.0).contains(&height)
}

#[cfg(target_os = "macos")]
pub use macos::MpvState;

#[cfg(not(target_os = "macos"))]
#[derive(Default)]
pub struct MpvState;

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::{c_char, c_int, c_void, CStr, CString};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{Arc, Condvar, Mutex, OnceLock};
    use std::thread::JoinHandle;
    use std::time::{Duration, Instant};

    use objc2::encode::{Encode, Encoding};
    use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
    use objc2::{class, msg_send, sel};
    use tauri::Emitter;

    use super::{MpvAvailability, MpvPlaybackStatus, STATUS_EVENT};

    // ---- dynamic libmpv -------------------------------------------------------------------

    const RTLD_LAZY: c_int = 0x1;
    const RTLD_NOW: c_int = 0x2;
    const RTLD_LOCAL: c_int = 0x4;

    extern "C" {
        fn dlopen(path: *const c_char, mode: c_int) -> *mut c_void;
        fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
        fn dlerror() -> *const c_char;
    }

    const FORMAT_STRING: c_int = 1;
    const FORMAT_FLAG: c_int = 3;
    const FORMAT_INT64: c_int = 4;
    const FORMAT_DOUBLE: c_int = 5;

    const EVENT_SHUTDOWN: c_int = 1;
    const EVENT_LOG_MESSAGE: c_int = 2;
    const EVENT_END_FILE: c_int = 7;
    const EVENT_FILE_LOADED: c_int = 8;
    const EVENT_PLAYBACK_RESTART: c_int = 21;
    const EVENT_PROPERTY_CHANGE: c_int = 22;

    const END_FILE_REASON_ERROR: c_int = 4;

    const RENDER_PARAM_INVALID: c_int = 0;
    const RENDER_PARAM_API_TYPE: c_int = 1;
    const RENDER_PARAM_OPENGL_INIT_PARAMS: c_int = 2;
    const RENDER_PARAM_OPENGL_FBO: c_int = 3;
    const RENDER_PARAM_FLIP_Y: c_int = 4;
    const RENDER_UPDATE_FRAME: u64 = 1;

    #[repr(C)]
    struct Event {
        event_id: c_int,
        error: c_int,
        reply_userdata: u64,
        data: *mut c_void,
    }

    #[repr(C)]
    struct EventProperty {
        name: *const c_char,
        format: c_int,
        data: *mut c_void,
    }

    #[repr(C)]
    struct EventLogMessage {
        prefix: *const c_char,
        level: *const c_char,
        text: *const c_char,
    }

    #[repr(C)]
    struct EventEndFile {
        reason: c_int,
        error: c_int,
    }

    #[repr(C)]
    struct RenderParam {
        kind: c_int,
        data: *mut c_void,
    }

    #[repr(C)]
    struct OpenGlInitParams {
        get_proc_address: unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_void,
        get_proc_address_ctx: *mut c_void,
    }

    #[repr(C)]
    struct OpenGlFbo {
        fbo: c_int,
        w: c_int,
        h: c_int,
        internal_format: c_int,
    }

    type Handle = c_void;
    type RenderContext = c_void;

    struct Api {
        client_api_version: unsafe extern "C" fn() -> std::ffi::c_ulong,
        create: unsafe extern "C" fn() -> *mut Handle,
        initialize: unsafe extern "C" fn(*mut Handle) -> c_int,
        terminate_destroy: unsafe extern "C" fn(*mut Handle),
        set_option_string: unsafe extern "C" fn(*mut Handle, *const c_char, *const c_char) -> c_int,
        set_property_async: unsafe extern "C" fn(*mut Handle, u64, *const c_char, c_int, *mut c_void) -> c_int,
        // Only the smoke test reads properties; playback observes them (never blocks on mpv's core).
        #[cfg_attr(not(test), allow(dead_code))]
        get_property: unsafe extern "C" fn(*mut Handle, *const c_char, c_int, *mut c_void) -> c_int,
        command_async: unsafe extern "C" fn(*mut Handle, u64, *mut *const c_char) -> c_int,
        observe_property: unsafe extern "C" fn(*mut Handle, u64, *const c_char, c_int) -> c_int,
        request_log_messages: unsafe extern "C" fn(*mut Handle, *const c_char) -> c_int,
        wait_event: unsafe extern "C" fn(*mut Handle, f64) -> *mut Event,
        wakeup: unsafe extern "C" fn(*mut Handle),
        error_string: unsafe extern "C" fn(c_int) -> *const c_char,
        render_context_create: unsafe extern "C" fn(*mut *mut RenderContext, *mut Handle, *mut RenderParam) -> c_int,
        render_context_set_update_callback:
            unsafe extern "C" fn(*mut RenderContext, Option<unsafe extern "C" fn(*mut c_void)>, *mut c_void),
        render_context_update: unsafe extern "C" fn(*mut RenderContext) -> u64,
        render_context_render: unsafe extern "C" fn(*mut RenderContext, *mut RenderParam) -> c_int,
        render_context_report_swap: unsafe extern "C" fn(*mut RenderContext),
        render_context_free: unsafe extern "C" fn(*mut RenderContext),
    }

    fn last_dl_error() -> String {
        // SAFETY: dlerror returns null or a NUL-terminated string owned by the loader.
        let message = unsafe { dlerror() };
        if message.is_null() {
            "unknown error".into()
        } else {
            unsafe { CStr::from_ptr(message) }.to_string_lossy().into_owned()
        }
    }

    fn library_candidates() -> Vec<std::path::PathBuf> {
        let mut paths = Vec::new();
        if let Some(path) = std::env::var_os("KDJ_LIBMPV") {
            paths.push(path.into());
        }
        if let Some(contents) = std::env::current_exe().ok().and_then(|exe| exe.parent()?.parent().map(|dir| dir.to_path_buf())) {
            paths.push(contents.join("Frameworks/libmpv.2.dylib"));
        }
        #[cfg(debug_assertions)]
        paths.push(concat!(env!("CARGO_MANIFEST_DIR"), "/vendor/libmpv/macos/libmpv.2.dylib").into());
        paths
    }

    fn load_api() -> Result<(&'static Api, String), String> {
        let mut tried = Vec::new();
        for path in library_candidates() {
            if !path.is_file() {
                continue;
            }
            let c_path = CString::new(path.to_string_lossy().as_bytes()).map_err(|_| "libmpv 路径无效".to_string())?;
            // SAFETY: plain dlopen of a file path; the handle is never closed.
            let library = unsafe { dlopen(c_path.as_ptr(), RTLD_NOW | RTLD_LOCAL) };
            if library.is_null() {
                tried.push(format!("{}: {}", path.display(), last_dl_error()));
                continue;
            }
            macro_rules! symbol {
                ($name:literal) => {{
                    // SAFETY: the symbol is looked up by its libmpv name and cast to the signature
                    // of mpv/client.h / mpv/render.h for that name.
                    let pointer = unsafe { dlsym(library, concat!($name, "\0").as_ptr().cast()) };
                    if pointer.is_null() {
                        return Err(format!("libmpv 缺少 {}（{}）", $name, path.display()));
                    }
                    unsafe { std::mem::transmute::<*mut c_void, _>(pointer) }
                }};
            }
            let api = Api {
                client_api_version: symbol!("mpv_client_api_version"),
                create: symbol!("mpv_create"),
                initialize: symbol!("mpv_initialize"),
                terminate_destroy: symbol!("mpv_terminate_destroy"),
                set_option_string: symbol!("mpv_set_option_string"),
                set_property_async: symbol!("mpv_set_property_async"),
                get_property: symbol!("mpv_get_property"),
                command_async: symbol!("mpv_command_async"),
                observe_property: symbol!("mpv_observe_property"),
                request_log_messages: symbol!("mpv_request_log_messages"),
                wait_event: symbol!("mpv_wait_event"),
                wakeup: symbol!("mpv_wakeup"),
                error_string: symbol!("mpv_error_string"),
                render_context_create: symbol!("mpv_render_context_create"),
                render_context_set_update_callback: symbol!("mpv_render_context_set_update_callback"),
                render_context_update: symbol!("mpv_render_context_update"),
                render_context_render: symbol!("mpv_render_context_render"),
                render_context_report_swap: symbol!("mpv_render_context_report_swap"),
                render_context_free: symbol!("mpv_render_context_free"),
            };
            let version = unsafe { (api.client_api_version)() };
            if version >> 16 != 2 {
                return Err(format!("libmpv 客户端接口版本 {}.{} 不受支持", version >> 16, version & 0xffff));
            }
            return Ok((Box::leak(Box::new(api)), format!("{}.{}", version >> 16, version & 0xffff)));
        }
        Err(if tried.is_empty() { "没有找到 libmpv".into() } else { tried.join("；") })
    }

    fn api() -> Result<&'static Api, String> {
        static API: OnceLock<Result<(&'static Api, String), String>> = OnceLock::new();
        API.get_or_init(|| {
            let loaded = load_api();
            match &loaded {
                Ok((_, version)) => tracing::info!(version, "libmpv loaded"),
                Err(error) => tracing::warn!(%error, "libmpv unavailable"),
            }
            loaded
        })
        .as_ref()
        .map(|(api, _)| *api)
        .map_err(Clone::clone)
    }

    pub fn availability() -> MpvAvailability {
        match api() {
            Ok(api) => {
                let version = unsafe { (api.client_api_version)() };
                MpvAvailability {
                    available: true,
                    version: Some(format!("{}.{}", version >> 16, version & 0xffff)),
                    error: None,
                }
            }
            Err(error) => MpvAvailability { available: false, version: None, error: Some(error) },
        }
    }

    /// An mpv handle shared by the command, event and render threads (the client API is
    /// thread-safe; only `wait_event` must stay on one thread).
    #[derive(Clone, Copy)]
    struct Mpv {
        api: &'static Api,
        handle: *mut Handle,
    }
    unsafe impl Send for Mpv {}
    unsafe impl Sync for Mpv {}

    fn c(text: &str) -> CString {
        CString::new(text).unwrap_or_default()
    }

    impl Mpv {
        /// Creates a handle; it is a plain value so closures and futures hold the Send wrapper,
        /// never the raw pointer (closures capture fields one by one).
        fn create(api: &'static Api) -> Option<Self> {
            let handle = unsafe { (api.create)() };
            (!handle.is_null()).then_some(Self { api, handle })
        }

        fn wakeup(&self) {
            unsafe { (self.api.wakeup)(self.handle) };
        }

        fn destroy(&self) {
            unsafe { (self.api.terminate_destroy)(self.handle) };
        }

        fn error(&self, code: c_int) -> String {
            unsafe { CStr::from_ptr((self.api.error_string)(code)) }.to_string_lossy().into_owned()
        }

        fn option(&self, name: &str, value: &str) -> Result<(), String> {
            let code = unsafe { (self.api.set_option_string)(self.handle, c(name).as_ptr(), c(value).as_ptr()) };
            if code < 0 {
                Err(format!("mpv 选项 {name}={value}：{}", self.error(code)))
            } else {
                Ok(())
            }
        }

        fn command(&self, args: &[&str]) {
            let owned: Vec<CString> = args.iter().map(|arg| c(arg)).collect();
            let mut pointers: Vec<*const c_char> = owned.iter().map(|arg| arg.as_ptr()).collect();
            pointers.push(std::ptr::null());
            let code = unsafe { (self.api.command_async)(self.handle, 0, pointers.as_mut_ptr()) };
            if code < 0 {
                tracing::warn!(command = ?args, error = %self.error(code), "mpv command rejected");
            }
        }

        fn set_flag(&self, name: &str, value: bool) {
            let mut flag: c_int = value.into();
            unsafe { (self.api.set_property_async)(self.handle, 0, c(name).as_ptr(), FORMAT_FLAG, (&mut flag as *mut c_int).cast()) };
        }

        fn set_double(&self, name: &str, value: f64) {
            let mut number = value;
            unsafe { (self.api.set_property_async)(self.handle, 0, c(name).as_ptr(), FORMAT_DOUBLE, (&mut number as *mut f64).cast()) };
        }

        fn set_string(&self, name: &str, value: &str) {
            let text = c(value);
            let mut pointer = text.as_ptr();
            unsafe { (self.api.set_property_async)(self.handle, 0, c(name).as_ptr(), FORMAT_STRING, (&mut pointer as *mut *const c_char).cast()) };
        }

        #[cfg_attr(not(test), allow(dead_code))]
        fn get_double(&self, name: &str) -> Option<f64> {
            let mut number = 0.0f64;
            let code = unsafe { (self.api.get_property)(self.handle, c(name).as_ptr(), FORMAT_DOUBLE, (&mut number as *mut f64).cast()) };
            (code >= 0 && number.is_finite()).then_some(number)
        }

        fn observe(&self, name: &str, format: c_int) {
            unsafe { (self.api.observe_property)(self.handle, 0, c(name).as_ptr(), format) };
        }

        fn seek(&self, position: f64) {
            self.command(&["seek", &format!("{:.4}", position.max(0.0)), "absolute+exact"]);
        }
    }

    // ---- the picture: an NSView with an OpenGL context drawn by a render thread -----------

    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default)]
    struct CGPoint {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default)]
    struct CGSize {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default)]
    struct CGRect {
        origin: CGPoint,
        size: CGSize,
    }
    unsafe impl Encode for CGPoint {
        const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }
    unsafe impl Encode for CGSize {
        const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
    }
    unsafe impl Encode for CGRect {
        const ENCODING: Encoding = Encoding::Struct("CGRect", &[CGPoint::ENCODING, CGSize::ENCODING]);
    }

    const NS_WINDOW_BELOW: isize = -1;
    const NS_OPENGL_PFA_DOUBLE_BUFFER: u32 = 5;
    const NS_OPENGL_PFA_COLOR_SIZE: u32 = 8;
    const NS_OPENGL_PFA_ALPHA_SIZE: u32 = 11;
    const NS_OPENGL_PFA_ACCELERATED: u32 = 73;
    const NS_OPENGL_PFA_ALLOW_OFFLINE_RENDERERS: u32 = 96;
    const NS_OPENGL_PFA_OPENGL_PROFILE: u32 = 99;
    const NS_OPENGL_PROFILE_VERSION_3_2_CORE: u32 = 0x3200;
    const NS_OPENGL_CONTEXT_PARAMETER_SWAP_INTERVAL: isize = 222;

    struct Cgl {
        set_current: unsafe extern "C" fn(*mut c_void) -> c_int,
        lock: unsafe extern "C" fn(*mut c_void) -> c_int,
        unlock: unsafe extern "C" fn(*mut c_void) -> c_int,
        flush: unsafe extern "C" fn(*mut c_void) -> c_int,
        library: usize,
    }

    fn cgl() -> Option<&'static Cgl> {
        static CGL: OnceLock<Option<Cgl>> = OnceLock::new();
        CGL.get_or_init(|| unsafe {
            let library = dlopen(c"/System/Library/Frameworks/OpenGL.framework/OpenGL".as_ptr(), RTLD_LAZY | RTLD_LOCAL);
            if library.is_null() {
                return None;
            }
            let find = |name: &CStr| dlsym(library, name.as_ptr());
            let symbols = [find(c"CGLSetCurrentContext"), find(c"CGLLockContext"), find(c"CGLUnlockContext"), find(c"CGLFlushDrawable")];
            if symbols.iter().any(|symbol| symbol.is_null()) {
                return None;
            }
            Some(Cgl {
                set_current: std::mem::transmute::<*mut c_void, _>(symbols[0]),
                lock: std::mem::transmute::<*mut c_void, _>(symbols[1]),
                unlock: std::mem::transmute::<*mut c_void, _>(symbols[2]),
                flush: std::mem::transmute::<*mut c_void, _>(symbols[3]),
                library: library as usize,
            })
        })
        .as_ref()
    }

    unsafe extern "C" fn gl_proc_address(_context: *mut c_void, name: *const c_char) -> *mut c_void {
        match cgl() {
            Some(cgl) => unsafe { dlsym(cgl.library as *mut c_void, name) },
            None => std::ptr::null_mut(),
        }
    }

    /// The view class: an NSView that is never the target of a mouse event, so clicks, drags
    /// and hovers over the picture reach the page underneath.
    fn view_class() -> &'static AnyClass {
        static CLASS: OnceLock<usize> = OnceLock::new();
        let pointer = *CLASS.get_or_init(|| {
            extern "C-unwind" fn hit_test(_this: &AnyObject, _cmd: Sel, _point: CGPoint) -> *mut AnyObject {
                std::ptr::null_mut()
            }
            extern "C-unwind" fn is_opaque(_this: &AnyObject, _cmd: Sel) -> Bool {
                Bool::YES
            }
            let class = match ClassBuilder::new(c"KdjMpvVideoView", class!(NSView)) {
                Some(mut builder) => {
                    unsafe {
                        builder.add_method(sel!(hitTest:), hit_test as extern "C-unwind" fn(_, _, _) -> _);
                        builder.add_method(sel!(isOpaque), is_opaque as extern "C-unwind" fn(_, _) -> _);
                    }
                    builder.register()
                }
                None => AnyClass::get(c"KdjMpvVideoView").expect("KdjMpvVideoView registered"),
            };
            class as *const AnyClass as usize
        });
        unsafe { &*(pointer as *const AnyClass) }
    }

    #[derive(Default)]
    struct RenderFlags {
        redraw: bool,
        quit: bool,
        width: i32,
        height: i32,
    }

    struct RenderShared {
        flags: Mutex<RenderFlags>,
        wake: Condvar,
    }

    unsafe extern "C" fn render_update(data: *mut c_void) {
        let shared = unsafe { &*(data as *const RenderShared) };
        if let Ok(mut flags) = shared.flags.lock() {
            flags.redraw = true;
        }
        shared.wake.notify_one();
    }

    /// AppKit objects owned by the player, touched on the main thread only.
    #[derive(Clone, Copy)]
    struct MainObjects {
        view: usize,
        context: usize,
        webview: usize,
    }

    impl MainObjects {
        fn view(&self) -> *mut AnyObject {
            self.view as *mut AnyObject
        }
        fn context(&self) -> *mut AnyObject {
            self.context as *mut AnyObject
        }
        fn webview(&self) -> *mut AnyObject {
            self.webview as *mut AnyObject
        }

        /// Places the view at a rectangle given in the page's CSS pixels; returns the drawable
        /// size in pixels.
        #[allow(clippy::too_many_arguments)]
        unsafe fn place(&self, x: f64, y: f64, width: f64, height: f64, visible: bool, opacity: f64, cgl_context: *mut c_void) -> (i32, i32) {
            unsafe {
                let webview = self.webview();
                let superview: *mut AnyObject = msg_send![webview, superview];
                let bounds: CGRect = msg_send![webview, bounds];
                let flipped: bool = msg_send![webview, isFlipped];
                let in_webview = CGRect {
                    origin: CGPoint { x, y: if flipped { y } else { bounds.size.height - y - height } },
                    size: CGSize { width: width.max(1.0), height: height.max(1.0) },
                };
                // The view is the WebView's sibling, right under it.
                let frame: CGRect = msg_send![webview, convertRect: in_webview, toView: superview];
                let view = self.view();
                let _: () = msg_send![view, setFrame: frame];
                let hidden = !visible || width < 2.0 || height < 2.0;
                let _: () = msg_send![view, setHidden: hidden];
                let _: () = msg_send![view, setAlphaValue: opacity.clamp(0.0, 1.0)];
                if let Some(cgl) = cgl() {
                    (cgl.lock)(cgl_context);
                    let _: () = msg_send![self.context(), update];
                    (cgl.unlock)(cgl_context);
                }
                let local: CGRect = msg_send![view, bounds];
                let backing: CGRect = msg_send![view, convertRectToBacking: local];
                (backing.size.width.round() as i32, backing.size.height.round() as i32)
            }
        }

        /// Puts the view right under the WebView, above every other video view.
        unsafe fn raise(&self) {
            unsafe {
                let webview = self.webview();
                let superview: *mut AnyObject = msg_send![webview, superview];
                let _: () = msg_send![superview, addSubview: self.view(), positioned: NS_WINDOW_BELOW, relativeTo: webview];
            }
        }

        unsafe fn destroy(&self) {
            unsafe {
                let _: () = msg_send![self.context(), clearDrawable];
                let _: () = msg_send![self.view(), removeFromSuperview];
                let _: () = msg_send![self.context(), release];
                let _: () = msg_send![self.view(), release];
                let _: () = msg_send![self.webview(), release];
            }
        }
    }

    /// Creates the view inside the main WKWebView and its OpenGL context. Main thread only.
    unsafe fn create_view(webview: *mut AnyObject) -> Result<(MainObjects, usize), String> {
        unsafe {
            let attributes: [u32; 11] = [
                NS_OPENGL_PFA_OPENGL_PROFILE,
                NS_OPENGL_PROFILE_VERSION_3_2_CORE,
                NS_OPENGL_PFA_DOUBLE_BUFFER,
                NS_OPENGL_PFA_ACCELERATED,
                NS_OPENGL_PFA_ALLOW_OFFLINE_RENDERERS,
                NS_OPENGL_PFA_COLOR_SIZE,
                24,
                NS_OPENGL_PFA_ALPHA_SIZE,
                8,
                0,
                0,
            ];
            let format: *mut AnyObject = msg_send![class!(NSOpenGLPixelFormat), alloc];
            let format: *mut AnyObject = msg_send![format, initWithAttributes: attributes.as_ptr()];
            if format.is_null() {
                return Err("无法创建视频 OpenGL 像素格式".into());
            }
            let context: *mut AnyObject = msg_send![class!(NSOpenGLContext), alloc];
            let context: *mut AnyObject = msg_send![context, initWithFormat: format, shareContext: std::ptr::null_mut::<AnyObject>()];
            let _: () = msg_send![format, release];
            if context.is_null() {
                return Err("无法创建视频 OpenGL 上下文".into());
            }
            let swap: c_int = 1;
            let _: () = msg_send![context, setValues: &swap as *const c_int, forParameter: NS_OPENGL_CONTEXT_PARAMETER_SWAP_INTERVAL];

            let view: *mut AnyObject = msg_send![view_class(), alloc];
            let view: *mut AnyObject = msg_send![view, initWithFrame: CGRect { origin: CGPoint::default(), size: CGSize { width: 1.0, height: 1.0 } }];
            let _: () = msg_send![view, setWantsBestResolutionOpenGLSurface: true];
            let _: () = msg_send![view, setHidden: true];
            let superview: *mut AnyObject = msg_send![webview, superview];
            if superview.is_null() {
                let _: () = msg_send![view, release];
                let _: () = msg_send![context, release];
                return Err("主界面尚未放进窗口".into());
            }
            let _: () = msg_send![superview, addSubview: view, positioned: NS_WINDOW_BELOW, relativeTo: webview];
            // The page shows the video through the holes it leaves (videoHoles.ts).
            let no: *mut AnyObject = msg_send![class!(NSNumber), numberWithBool: false];
            let key: *mut AnyObject = msg_send![class!(NSString), stringWithUTF8String: c"drawsBackground".as_ptr()];
            let _: () = msg_send![webview, setValue: no, forKey: key];
            let _: () = msg_send![context, setView: view];
            let _: *mut AnyObject = msg_send![webview, retain];
            let cgl_context: *mut c_void = msg_send![context, CGLContextObj];
            Ok((MainObjects { view: view as usize, context: context as usize, webview: webview as usize }, cgl_context as usize))
        }
    }

    struct RenderThread {
        shared: Arc<RenderShared>,
        thread: Option<JoinHandle<()>>,
    }

    impl RenderThread {
        fn start(mpv: Mpv, cgl_context: usize) -> Result<Self, String> {
            let shared = Arc::new(RenderShared { flags: Mutex::new(RenderFlags::default()), wake: Condvar::new() });
            let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
            let thread_shared = Arc::clone(&shared);
            let thread = std::thread::Builder::new()
                .name("kdj-mpv-render".into())
                .spawn(move || render_loop(mpv, cgl_context as *mut c_void, thread_shared, ready_tx))
                .map_err(|error| format!("无法启动视频渲染线程：{error}"))?;
            match ready_rx.recv() {
                Ok(Ok(())) => Ok(Self { shared, thread: Some(thread) }),
                Ok(Err(error)) => {
                    let _ = thread.join();
                    Err(error)
                }
                Err(_) => Err("视频渲染线程意外退出".into()),
            }
        }

        fn resize(&self, width: i32, height: i32) {
            if let Ok(mut flags) = self.shared.flags.lock() {
                flags.width = width;
                flags.height = height;
                flags.redraw = true;
            }
            self.shared.wake.notify_one();
        }

        fn stop(&mut self) {
            if let Ok(mut flags) = self.shared.flags.lock() {
                flags.quit = true;
            }
            self.shared.wake.notify_one();
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    fn render_loop(mpv: Mpv, cgl_context: *mut c_void, shared: Arc<RenderShared>, ready: std::sync::mpsc::Sender<Result<(), String>>) {
        let Some(cgl) = cgl() else {
            let _ = ready.send(Err("系统没有 OpenGL".into()));
            return;
        };
        unsafe { (cgl.set_current)(cgl_context) };
        let mut init = OpenGlInitParams { get_proc_address: gl_proc_address, get_proc_address_ctx: std::ptr::null_mut() };
        let api_type = c"opengl";
        let mut params = [
            RenderParam { kind: RENDER_PARAM_API_TYPE, data: api_type.as_ptr() as *mut c_void },
            RenderParam { kind: RENDER_PARAM_OPENGL_INIT_PARAMS, data: (&mut init as *mut OpenGlInitParams).cast() },
            RenderParam { kind: RENDER_PARAM_INVALID, data: std::ptr::null_mut() },
        ];
        let mut render: *mut RenderContext = std::ptr::null_mut();
        let code = unsafe { (mpv.api.render_context_create)(&mut render, mpv.handle, params.as_mut_ptr()) };
        if code < 0 || render.is_null() {
            unsafe { (cgl.set_current)(std::ptr::null_mut()) };
            let _ = ready.send(Err(format!("无法创建 mpv 渲染上下文：{}", mpv.error(code))));
            return;
        }
        unsafe {
            (mpv.api.render_context_set_update_callback)(render, Some(render_update), Arc::as_ptr(&shared) as *mut c_void);
        }
        let _ = ready.send(Ok(()));
        loop {
            let (width, height) = {
                let Ok(mut flags) = shared.flags.lock() else { break };
                while !flags.redraw && !flags.quit {
                    flags = match shared.wake.wait(flags) {
                        Ok(flags) => flags,
                        Err(_) => return,
                    };
                }
                if flags.quit {
                    break;
                }
                flags.redraw = false;
                (flags.width, flags.height)
            };
            // A resize without a new frame still redraws the last one at the new size, so the
            // update flags only matter to mpv's own bookkeeping here.
            let _ = unsafe { (mpv.api.render_context_update)(render) } & RENDER_UPDATE_FRAME;
            if width <= 0 || height <= 0 {
                continue;
            }
            let mut fbo = OpenGlFbo { fbo: 0, w: width, h: height, internal_format: 0 };
            let mut flip: c_int = 1;
            let mut render_params = [
                RenderParam { kind: RENDER_PARAM_OPENGL_FBO, data: (&mut fbo as *mut OpenGlFbo).cast() },
                RenderParam { kind: RENDER_PARAM_FLIP_Y, data: (&mut flip as *mut c_int).cast() },
                RenderParam { kind: RENDER_PARAM_INVALID, data: std::ptr::null_mut() },
            ];
            unsafe {
                (cgl.lock)(cgl_context);
                (mpv.api.render_context_render)(render, render_params.as_mut_ptr());
                (cgl.flush)(cgl_context);
                (cgl.unlock)(cgl_context);
                (mpv.api.render_context_report_swap)(render);
            }
        }
        unsafe {
            (mpv.api.render_context_set_update_callback)(render, None, std::ptr::null_mut());
            (mpv.api.render_context_free)(render);
            (cgl.set_current)(std::ptr::null_mut());
        }
    }

    // ---- following KDJ's audio clock ------------------------------------------------------

    #[derive(Clone, Copy)]
    struct Clock {
        at: Instant,
        position: f64,
        rate: f64,
        playing: bool,
    }

    #[derive(Default)]
    struct Follow {
        clock: Option<Clock>,
        /// The target of the seek sent last, until mpv reports it has landed.
        pending: Option<(Instant, f64)>,
        /// The target of the seek that landed last: a paused picture there is where it should be,
        /// even when its frame starts a little before the clock (hr-seek shows the frame at or
        /// before the target).
        settled: Option<f64>,
        /// How long the last seek took to show its frame; a seek while playing aims that far ahead.
        lead: f64,
        speed: f64,
        /// Speed correction is on until the drift is back under the inner band.
        correcting: bool,
        paused: Option<bool>,
    }

    impl Follow {
        fn seek(&mut self, mpv: &Mpv, target: f64) {
            mpv.seek(target);
            self.pending = Some((Instant::now(), target));
        }

        fn pause(&mut self, mpv: &Mpv, paused: bool) {
            if self.paused != Some(paused) {
                mpv.set_flag("pause", paused);
                self.paused = Some(paused);
            }
        }

        fn landed(&mut self) {
            if let Some((sent, target)) = self.pending.take() {
                self.lead = sent.elapsed().as_secs_f64().clamp(0.0, 0.6);
                self.settled = Some(target);
            }
        }

        /// `position` is mpv's last observed `time-pos` (frame-accurate, no blocking read).
        fn tick(&mut self, mpv: &Mpv, duration: f64, position: Option<f64>) {
            let Some(clock) = self.clock else {
                self.pause(mpv, true);
                return;
            };
            if duration <= 0.0 {
                return;
            }
            let moving = clock.playing && clock.rate > 0.05;
            let elapsed = clock.at.elapsed().as_secs_f64();
            let end = (duration - 0.05).max(0.0);
            let target = (clock.position + if moving { elapsed * clock.rate } else { 0.0 }).clamp(0.0, end);
            let Some(position) = position else { return };
            let drift = target - position;
            if let Some((sent, pending)) = self.pending {
                // A seek is on its way: send another only when the clock has left its target.
                let far = if moving { 0.5 } else { 0.03 };
                if (target - pending).abs() <= far && sent.elapsed() < Duration::from_secs(3) {
                    return;
                }
            }
            if !moving {
                self.pause(mpv, true);
                let settled = self.settled.is_some_and(|settled| (settled - target).abs() < 1e-3);
                if drift.abs() > 0.03 && !settled {
                    self.seek(mpv, target);
                }
                return;
            }
            self.settled = None;
            if drift.abs() > 0.35 || (self.paused != Some(false) && drift.abs() > 0.08) {
                let aim = (target + self.lead * clock.rate).min(end);
                self.seek(mpv, aim);
                self.pause(mpv, false);
                return;
            }
            self.pause(mpv, false);
            // time-pos moves a frame at a time: under ~1.5 frames of drift play at the clock's
            // own rate, and only a drift beyond that is pulled in (by at most 10%).
            if drift.abs() > 0.05 {
                self.correcting = true;
            } else if drift.abs() < 0.015 {
                self.correcting = false;
            }
            let speed = if self.correcting { clock.rate * (1.0 + (drift * 0.5).clamp(-0.1, 0.1)) } else { clock.rate };
            if (speed - self.speed).abs() > 0.005 || (!self.correcting && speed != self.speed) {
                mpv.set_double("speed", speed.clamp(0.05, 8.0));
                self.speed = speed;
            }
        }
    }

    // ---- the player -----------------------------------------------------------------------

    /// mpv's options for one player. Only the first three are required; the build leaves out
    /// whole features (scripting, for one), and an option such a feature owns does not exist
    /// there: it is logged and skipped instead of refusing the video.
    fn player_options(follow: bool, volume: f64) -> Vec<(&'static str, String)> {
        vec![
            ("vo", "libmpv".into()),
            ("pause", "yes".into()),
            ("audio", if follow { "no".into() } else { "auto".into() }),
            ("hwdec", "videotoolbox,videotoolbox-copy".into()),
            ("config", "no".into()),
            ("input-default-bindings", "no".into()),
            ("input-vo-keyboard", "no".into()),
            ("osd-level", "0".into()),
            ("sid", "no".into()),
            ("sub-auto", "no".into()),
            ("idle", "yes".into()),
            ("keep-open", "yes".into()),
            ("hr-seek", "yes".into()),
            ("cache", "yes".into()),
            ("demuxer-max-bytes", "150MiB".into()),
            ("demuxer-max-back-bytes", "100MiB".into()),
            ("network-timeout", "15".into()),
            ("volume", format!("{:.1}", volume.clamp(0.0, 1.0) * 100.0)),
        ]
    }

    fn apply_options(mpv: &Mpv, follow: bool, volume: f64) -> Result<(), String> {
        for (index, (name, value)) in player_options(follow, volume).iter().enumerate() {
            match mpv.option(name, value) {
                Ok(()) => {}
                Err(error) if index < 3 => return Err(error),
                Err(error) => tracing::warn!(%error, "mpv option skipped"),
            }
        }
        Ok(())
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Mode {
        Network,
        Follow,
    }

    struct Player {
        mode: Mode,
        layer: i32,
        mpv: Mpv,
        objects: MainObjects,
        cgl_context: usize,
        render: RenderThread,
        follow: Arc<Mutex<Follow>>,
        quit: Arc<AtomicBool>,
        events: Option<JoinHandle<()>>,
    }

    #[derive(Default)]
    pub struct MpvState {
        players: Mutex<std::collections::HashMap<u64, Player>>,
        generation: AtomicU64,
        lifecycle: tokio::sync::Mutex<()>,
    }

    fn event_loop(app: tauri::AppHandle, mpv: Mpv, generation: u64, mode: Mode, follow: Arc<Mutex<Follow>>, quit: Arc<AtomicBool>) {
        let mut status = MpvPlaybackStatus { generation, ..Default::default() };
        let mut paused = true;
        let mut eof = false;
        let mut cache_wait = false;
        let mut seeking = false;
        let mut sent = MpvPlaybackStatus::default();
        let mut sent_at = Instant::now() - Duration::from_secs(1);
        let timeout = if mode == Mode::Follow { 0.03 } else { 0.1 };
        while !quit.load(Ordering::Acquire) {
            let event = unsafe { &*(mpv.api.wait_event)(mpv.handle, timeout) };
            match event.event_id {
                EVENT_SHUTDOWN => break,
                EVENT_LOG_MESSAGE => {
                    let message = unsafe { &*(event.data as *const EventLogMessage) };
                    let text = |pointer: *const c_char| unsafe { CStr::from_ptr(pointer) }.to_string_lossy();
                    tracing::warn!(generation, module = %text(message.prefix), level = %text(message.level), "mpv: {}", text(message.text).trim_end());
                }
                EVENT_PROPERTY_CHANGE => {
                    let property = unsafe { &*(event.data as *const EventProperty) };
                    let name = unsafe { CStr::from_ptr(property.name) }.to_bytes();
                    let flag = || property.format == FORMAT_FLAG && unsafe { *(property.data as *const c_int) } != 0;
                    let double = || (property.format == FORMAT_DOUBLE).then(|| unsafe { *(property.data as *const f64) });
                    let int = || (property.format == FORMAT_INT64).then(|| unsafe { *(property.data as *const i64) });
                    match name {
                        b"time-pos" => status.position = double().unwrap_or(status.position),
                        b"duration" => status.duration = double().unwrap_or(0.0),
                        b"pause" => paused = flag(),
                        b"eof-reached" => eof = flag(),
                        b"paused-for-cache" => cache_wait = flag(),
                        b"seeking" => seeking = flag(),
                        b"dwidth" => status.width = int().unwrap_or(0),
                        b"dheight" => status.height = int().unwrap_or(0),
                        _ => {}
                    }
                }
                EVENT_PLAYBACK_RESTART => {
                    if let Ok(mut follow) = follow.lock() {
                        follow.landed();
                    }
                }
                EVENT_FILE_LOADED => status.error = None,
                EVENT_END_FILE => {
                    let end = unsafe { &*(event.data as *const EventEndFile) };
                    if end.reason == END_FILE_REASON_ERROR {
                        status.error = Some(format!("视频无法播放：{}", mpv.error(end.error)));
                        tracing::warn!(generation, error = %mpv.error(end.error), "mpv could not play the file");
                    }
                }
                _ => {}
            }
            if mode == Mode::Follow {
                if let Ok(mut follow) = follow.lock() {
                    let position = (status.duration > 0.0).then_some(status.position);
                    follow.tick(&mpv, status.duration, position);
                }
            }
            status.playing = !paused && !eof;
            status.ended = eof;
            status.buffering = cache_wait || (seeking && mode == Mode::Network);
            // Until a seek has shown its frame, time-pos still reads the old spot: report the
            // target, or the progress bar jumps back and forth on every jump.
            let observed = status.position;
            if let Some(target) = follow.lock().ok().and_then(|follow| follow.pending.map(|(_, target)| target)) {
                status.position = target;
            }
            let moved = (status.position - sent.position).abs() > 1e-3;
            let changed = MpvPlaybackStatus { position: sent.position, ..status.clone() } != sent;
            if changed || (moved && sent_at.elapsed() >= Duration::from_millis(100)) {
                let _ = app.emit_to("main", STATUS_EVENT, &status);
                sent = status.clone();
                sent_at = Instant::now();
            }
            status.position = observed;
        }
    }

    fn on_main<R: Send + 'static>(
        webview: &tauri::Webview,
        work: impl FnOnce(*mut AnyObject) -> R + Send + 'static,
    ) -> tokio::sync::oneshot::Receiver<R> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let result = webview.with_webview(move |native| {
            let _ = tx.send(work(native.inner() as *mut AnyObject));
        });
        if let Err(error) = result {
            tracing::warn!(%error, "mpv main-thread dispatch failed");
        }
        rx
    }

    async fn place(webview: &tauri::Webview, player: (MainObjects, usize), bounds: (f64, f64, f64, f64), visible: bool, opacity: f64) -> Result<(i32, i32), String> {
        let (objects, cgl_context) = player;
        let (x, y, width, height) = bounds;
        on_main(webview, move |_| unsafe { objects.place(x, y, width, height, visible, opacity, cgl_context as *mut c_void) })
            .await
            .map_err(|_| "视频窗口已关闭".to_string())
    }

    fn shutdown(webview: tauri::Webview, mut player: Player) {
        // Off the command thread: mpv may take a moment to stop a network read.
        std::thread::spawn(move || {
            player.quit.store(true, Ordering::Release);
            player.mpv.wakeup();
            if let Some(events) = player.events.take() {
                let _ = events.join();
            }
            player.render.stop();
            player.mpv.destroy();
            let objects = player.objects;
            let _ = webview.with_webview(move |_| unsafe { objects.destroy() });
        });
    }

    pub struct OpenRequest {
        pub url: String,
        pub follow: bool,
        pub crop: Option<String>,
        pub stretch: bool,
        pub bounds: (f64, f64, f64, f64),
        pub volume: f64,
        pub start: f64,
        pub paused: bool,
    }

    impl MpvState {
        pub async fn open(&self, app: tauri::AppHandle, webview: tauri::Webview, request: OpenRequest) -> Result<u64, String> {
            let _lifecycle = self.lifecycle.lock().await;
            let api = api()?;
            let mpv = Mpv::create(api).ok_or_else(|| "无法创建 mpv 播放器".to_string())?;
            let fail = |error: String| {
                mpv.destroy();
                error
            };
            let mode = if request.follow { Mode::Follow } else { Mode::Network };
            apply_options(&mpv, request.follow, request.volume).map_err(fail)?;
            // A project clip: its part of the source, stretched over a view already its shape.
            if let Some(crop) = &request.crop {
                if let Err(error) = mpv.option("video-crop", crop) {
                    tracing::warn!(%error, "mpv crop skipped");
                }
            }
            if request.stretch {
                if let Err(error) = mpv.option("keepaspect", "no") {
                    tracing::warn!(%error, "mpv stretch skipped");
                }
            }
            let code = unsafe { (api.initialize)(mpv.handle) };
            unsafe { (api.request_log_messages)(mpv.handle, c"warn".as_ptr()) };
            if code < 0 {
                return Err(fail(format!("mpv 初始化失败：{}", mpv.error(code))));
            }
            let created = on_main(&webview, |native| unsafe { create_view(native) })
                .await
                .map_err(|_| fail("主窗口不可用".into()))?
                .map_err(fail)?;
            let (objects, cgl_context) = created;
            let render = match RenderThread::start(mpv, cgl_context) {
                Ok(render) => render,
                Err(error) => {
                    let _ = webview.with_webview(move |_| unsafe { objects.destroy() });
                    return Err(fail(error));
                }
            };
            let mut render = render;
            let teardown = |render: &mut RenderThread, error: String| {
                render.stop();
                let _ = webview.with_webview(move |_| unsafe { objects.destroy() });
                fail(error)
            };
            let (pixel_width, pixel_height) = match place(&webview, (objects, cgl_context), request.bounds, false, 1.0).await {
                Ok(size) => size,
                Err(error) => return Err(teardown(&mut render, error)),
            };
            render.resize(pixel_width, pixel_height);

            for (name, format) in [
                ("time-pos", FORMAT_DOUBLE),
                ("duration", FORMAT_DOUBLE),
                ("pause", FORMAT_FLAG),
                ("eof-reached", FORMAT_FLAG),
                ("paused-for-cache", FORMAT_FLAG),
                ("seeking", FORMAT_FLAG),
                ("dwidth", FORMAT_INT64),
                ("dheight", FORMAT_INT64),
            ] {
                mpv.observe(name, format);
            }
            if request.start > 0.0 && request.start.is_finite() {
                mpv.set_string("start", &format!("{:.4}", request.start));
            }
            mpv.command(&["loadfile", &request.url, "replace"]);
            if !request.paused && !request.follow {
                mpv.set_flag("pause", false);
            }

            let generation = self.generation.fetch_add(1, Ordering::Relaxed) + 1;
            let follow = Arc::new(Mutex::new(Follow { speed: 1.0, paused: Some(true), ..Default::default() }));
            let quit = Arc::new(AtomicBool::new(false));
            let events = {
                let (app, follow, quit) = (app.clone(), Arc::clone(&follow), Arc::clone(&quit));
                std::thread::Builder::new()
                    .name("kdj-mpv-events".into())
                    .spawn(move || event_loop(app, mpv, generation, mode, follow, quit))
            };
            let events = match events {
                Ok(events) => events,
                Err(error) => return Err(teardown(&mut render, format!("无法启动视频事件线程：{error}"))),
            };
            tracing::info!(generation, follow = request.follow, "mpv window opened");
            self.players.lock().map_err(|_| "视频播放器状态损坏")?.insert(generation, Player {
                mode,
                layer: 0,
                mpv,
                objects,
                cgl_context,
                render,
                follow,
                quit,
                events: Some(events),
            });
            Ok(generation)
        }

        fn with_player<R>(&self, generation: u64, work: impl FnOnce(&Player) -> R) -> Result<R, String> {
            let players = self.players.lock().map_err(|_| "视频播放器状态损坏")?;
            players.get(&generation).map(work).ok_or_else(|| "视频播放器已切换".into())
        }

        #[allow(clippy::too_many_arguments)]
        pub async fn set_bounds(
            &self,
            webview: &tauri::Webview,
            generation: u64,
            bounds: (f64, f64, f64, f64),
            visible: bool,
            opacity: f64,
            layer: i32,
        ) -> Result<(), String> {
            let target = self.with_player(generation, |player| (player.objects, player.cgl_context))?;
            // A new layer number re-stacks every view, lowest first, so the order is the layers'.
            let restack = {
                let mut players = self.players.lock().map_err(|_| "视频播放器状态损坏")?;
                match players.get_mut(&generation) {
                    Some(player) if player.layer != layer => {
                        player.layer = layer;
                        let mut views: Vec<(i32, u64, MainObjects)> =
                            players.iter().map(|(key, player)| (player.layer, *key, player.objects)).collect();
                        views.sort_by_key(|(layer, key, _)| (*layer, *key));
                        Some(views.into_iter().map(|(_, _, objects)| objects).collect::<Vec<_>>())
                    }
                    _ => None,
                }
            };
            if let Some(views) = restack {
                on_main(webview, move |_| unsafe {
                    for objects in views {
                        objects.raise();
                    }
                })
                .await
                .map_err(|_| "视频窗口已关闭".to_string())?;
            }
            let (width, height) = place(webview, target, bounds, visible, opacity).await?;
            self.with_player(generation, |player| player.render.resize(width, height))
        }

        pub fn control(&self, generation: u64, action: &str, value: Option<f64>) -> Result<(), String> {
            self.with_player(generation, |player| {
                let mpv = &player.mpv;
                match (action, value) {
                    ("play", _) => mpv.set_flag("pause", false),
                    ("pause", _) => mpv.set_flag("pause", true),
                    ("seek", Some(position)) if position.is_finite() => {
                        if let Ok(mut follow) = player.follow.lock() {
                            follow.seek(mpv, position);
                        }
                    }
                    ("volume", Some(volume)) if volume.is_finite() => mpv.set_double("volume", volume.clamp(0.0, 1.0) * 100.0),
                    _ => return Err(format!("未知的视频播放器动作：{action}")),
                }
                Ok(())
            })?
        }

        pub fn follow(&self, generation: u64, position: Option<f64>, rate: f64, playing: bool) -> Result<(), String> {
            self.with_player(generation, |player| {
                if player.mode != Mode::Follow {
                    return;
                }
                if let Ok(mut follow) = player.follow.lock() {
                    follow.clock = position.filter(|value| value.is_finite()).map(|position| Clock {
                        at: Instant::now(),
                        position: position.max(0.0),
                        rate: if rate.is_finite() { rate } else { 1.0 },
                        playing,
                    });
                }
                player.mpv.wakeup();
            })
        }

        pub async fn close(&self, webview: tauri::Webview, generation: Option<u64>) -> Result<(), String> {
            let _lifecycle = self.lifecycle.lock().await;
            let mut players = self.players.lock().map_err(|_| "视频播放器状态损坏")?;
            let closing: Vec<u64> = players.keys().copied().filter(|key| generation.is_none_or(|wanted| wanted == *key)).collect();
            for key in closing {
                if let Some(player) = players.remove(&key) {
                    tracing::info!(generation = key, "mpv window closed");
                    shutdown(webview.clone(), player);
                }
            }
            Ok(())
        }
    }

    /// Smoke test of the libmpv build without a window: an offscreen OpenGL context, a video
    /// rendered into a framebuffer, an exact seek.
    /// `KDJ_MPV_TEST_VIDEO=<file> cargo test -p kdj-app --lib mpv_renders -- --ignored --nocapture`
    #[cfg(test)]
    mod tests {
        use super::*;

        type GlFn = unsafe extern "C" fn();

        fn gl(name: &CStr) -> GlFn {
            let pointer = unsafe { gl_proc_address(std::ptr::null_mut(), name.as_ptr()) };
            assert!(!pointer.is_null(), "missing {name:?}");
            unsafe { std::mem::transmute::<*mut c_void, GlFn>(pointer) }
        }

        fn string_property(mpv: &Mpv, name: &str) -> String {
            let mut value: *const c_char = std::ptr::null();
            let code = unsafe { (mpv.api.get_property)(mpv.handle, c(name).as_ptr(), FORMAT_STRING, (&mut value as *mut *const c_char).cast()) };
            if code < 0 || value.is_null() {
                return format!("<{}>", mpv.error(code));
            }
            unsafe { CStr::from_ptr(value) }.to_string_lossy().into_owned()
        }

        #[test]
        #[ignore = "needs the built libmpv and a video file"]
        fn mpv_renders_and_seeks_offscreen() {
            let video = std::env::var("KDJ_MPV_TEST_VIDEO").expect("KDJ_MPV_TEST_VIDEO");
            let api = api().expect("libmpv");
            let cgl = cgl().expect("OpenGL");
            let library = cgl.library as *mut c_void;
            let find = |name: &CStr| unsafe { dlsym(library, name.as_ptr()) };
            unsafe {
                let choose: unsafe extern "C" fn(*const c_int, *mut *mut c_void, *mut c_int) -> c_int =
                    std::mem::transmute(find(c"CGLChoosePixelFormat"));
                let create: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut *mut c_void) -> c_int =
                    std::mem::transmute(find(c"CGLCreateContext"));
                let attributes: [c_int; 6] = [99, 0x3200, 73, 96, 0, 0];
                let (mut format, mut count, mut context) = (std::ptr::null_mut(), 0, std::ptr::null_mut());
                assert_eq!(choose(attributes.as_ptr(), &mut format, &mut count), 0);
                assert_eq!(create(format, std::ptr::null_mut(), &mut context), 0);
                (cgl.set_current)(context);

                // A 320x180 RGBA framebuffer to render into and read back.
                let (width, height) = (320, 180);
                let gen_framebuffers: unsafe extern "C" fn(c_int, *mut u32) = std::mem::transmute(gl(c"glGenFramebuffers"));
                let bind_framebuffer: unsafe extern "C" fn(u32, u32) = std::mem::transmute(gl(c"glBindFramebuffer"));
                let gen_textures: unsafe extern "C" fn(c_int, *mut u32) = std::mem::transmute(gl(c"glGenTextures"));
                let bind_texture: unsafe extern "C" fn(u32, u32) = std::mem::transmute(gl(c"glBindTexture"));
                let tex_image: unsafe extern "C" fn(u32, c_int, c_int, c_int, c_int, c_int, u32, u32, *const c_void) =
                    std::mem::transmute(gl(c"glTexImage2D"));
                let attach: unsafe extern "C" fn(u32, u32, u32, u32, c_int) = std::mem::transmute(gl(c"glFramebufferTexture2D"));
                let read_pixels: unsafe extern "C" fn(c_int, c_int, c_int, c_int, u32, u32, *mut c_void) =
                    std::mem::transmute(gl(c"glReadPixels"));
                let (mut framebuffer, mut texture) = (0u32, 0u32);
                gen_framebuffers(1, &mut framebuffer);
                bind_framebuffer(0x8D40, framebuffer);
                gen_textures(1, &mut texture);
                bind_texture(0x0DE1, texture);
                tex_image(0x0DE1, 0, 0x8058, width, height, 0, 0x1908, 0x1401, std::ptr::null());
                attach(0x8D40, 0x8CE0, 0x0DE1, texture, 0);

                let mpv = Mpv::create(api).expect("mpv_create");
                // Exactly the options playback sets, each of which must exist in this build.
                for (name, value) in player_options(true, 0.0) {
                    mpv.option(name, &value).unwrap();
                }
                mpv.option("pause", "no").unwrap();
                assert!((api.initialize)(mpv.handle) >= 0);
                let mut init = OpenGlInitParams { get_proc_address: gl_proc_address, get_proc_address_ctx: std::ptr::null_mut() };
                let mut params = [
                    RenderParam { kind: RENDER_PARAM_API_TYPE, data: c"opengl".as_ptr() as *mut c_void },
                    RenderParam { kind: RENDER_PARAM_OPENGL_INIT_PARAMS, data: (&mut init as *mut OpenGlInitParams).cast() },
                    RenderParam { kind: RENDER_PARAM_INVALID, data: std::ptr::null_mut() },
                ];
                let mut render: *mut RenderContext = std::ptr::null_mut();
                let code = (api.render_context_create)(&mut render, mpv.handle, params.as_mut_ptr());
                assert!(code >= 0, "render context: {}", mpv.error(code));

                let render_frame = || {
                    (api.render_context_update)(render);
                    let mut fbo = OpenGlFbo { fbo: framebuffer as c_int, w: width, h: height, internal_format: 0 };
                    let mut render_params = [
                        RenderParam { kind: RENDER_PARAM_OPENGL_FBO, data: (&mut fbo as *mut OpenGlFbo).cast() },
                        RenderParam { kind: RENDER_PARAM_INVALID, data: std::ptr::null_mut() },
                    ];
                    (api.render_context_render)(render, render_params.as_mut_ptr());
                };
                let started = Instant::now();
                mpv.command(&["loadfile", &video, "replace"]);
                let restarted = std::cell::Cell::new(0);
                let wait_until = |done: &dyn Fn() -> bool| {
                    let deadline = Instant::now() + Duration::from_secs(10);
                    while Instant::now() < deadline && !done() {
                        let event = &*(api.wait_event)(mpv.handle, 0.01);
                        if event.event_id == EVENT_PLAYBACK_RESTART {
                            restarted.set(restarted.get() + 1);
                        }
                        assert_ne!(event.event_id, EVENT_END_FILE, "playback ended early");
                        render_frame();
                    }
                };
                wait_until(&|| mpv.get_double("time-pos").is_some_and(|position| position > 1.0));
                let first_second = started.elapsed();
                let mut pixels = vec![0u8; (width * height * 4) as usize];
                // mpv leaves the default framebuffer bound after rendering.
                bind_framebuffer(0x8D40, framebuffer);
                read_pixels(0, 0, width, height, 0x1908, 0x1401, pixels.as_mut_ptr().cast());
                let lit = pixels.chunks(4).filter(|pixel| pixel[0] as u32 + pixel[1] as u32 + pixel[2] as u32 > 60).count();
                println!(
                    "mpv: hwdec-current={} video-codec={} first second after {:?}, lit pixels {}/{}",
                    string_property(&mpv, "hwdec-current"),
                    string_property(&mpv, "video-codec"),
                    first_second,
                    lit,
                    width * height
                );
                assert!(lit > (width * height / 4) as usize, "the rendered frame is (nearly) black");

                mpv.set_flag("pause", true);
                let before = restarted.get();
                let seek_started = Instant::now();
                mpv.seek(4.0);
                wait_until(&|| restarted.get() > before);
                let landed = mpv.get_double("time-pos").unwrap_or(-1.0);
                println!("mpv: exact seek to 4.0 landed at {landed:.3} after {:?}", seek_started.elapsed());
                assert!((landed - 4.0).abs() < 0.1, "seek landed at {landed}");

                (api.render_context_free)(render);
                mpv.destroy();
                (cgl.set_current)(std::ptr::null_mut());
            }
        }
    }
}

// ---- commands -------------------------------------------------------------------------------

#[tauri::command]
pub fn mpv_status() -> MpvAvailability {
    #[cfg(target_os = "macos")]
    return macos::availability();
    #[cfg(not(target_os = "macos"))]
    MpvAvailability { available: false, version: None, error: Some("当前系统尚未接入 mpv 视频窗口".into()) }
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn mpv_open(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: tauri::State<'_, MpvState>,
    url: String,
    follow: bool,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    volume: f64,
    start: f64,
    paused: bool,
    crop: Option<String>,
    stretch: Option<bool>,
) -> Result<u64, String> {
    require_main(&webview)?;
    // `WxH+X+Y` in source pixels, nothing else reaches mpv's option parser.
    let crop = crop.filter(|crop| {
        !crop.is_empty() && crop.len() <= 40 && crop.bytes().all(|byte| byte.is_ascii_digit() || byte == b'x' || byte == b'+')
    });
    let stretch = stretch.unwrap_or(false);
    if !valid_bounds(x, y, width, height) {
        return Err("视频窗口位置无效".into());
    }
    let parsed = tauri::Url::parse(&url).map_err(|_| "视频地址无效".to_string())?;
    // Only KDJ's own loopback server: mpv is built without TLS and must not reach the network.
    if parsed.scheme() != "http" || !matches!(parsed.host_str(), Some("127.0.0.1" | "localhost")) {
        return Err("视频播放器只读取 KDJ 本机服务的地址".into());
    }
    #[cfg(target_os = "macos")]
    {
        let request = macos::OpenRequest { url, follow, crop, stretch, bounds: (x, y, width, height), volume, start, paused };
        state.open(app, webview, request).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state, url, follow, volume, start, paused, crop, stretch);
        Err("当前系统尚未接入 mpv 视频窗口".into())
    }
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn mpv_set_bounds(
    webview: tauri::Webview,
    state: tauri::State<'_, MpvState>,
    generation: u64,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
    opacity: Option<f64>,
    layer: Option<i32>,
) -> Result<(), String> {
    require_main(&webview)?;
    if !valid_bounds(x, y, width, height) {
        return Err("视频窗口位置无效".into());
    }
    let opacity = opacity.filter(|value| value.is_finite()).unwrap_or(1.0);
    #[cfg(target_os = "macos")]
    return state.set_bounds(&webview, generation, (x, y, width, height), visible, opacity, layer.unwrap_or(0)).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, generation, visible, opacity, layer);
        Err("当前系统尚未接入 mpv 视频窗口".into())
    }
}

#[tauri::command]
pub async fn mpv_control(
    webview: tauri::Webview,
    state: tauri::State<'_, MpvState>,
    generation: u64,
    action: String,
    value: Option<f64>,
) -> Result<(), String> {
    // async: a plain command would run on the main thread, beside the UI and the native views.
    require_main(&webview)?;
    #[cfg(target_os = "macos")]
    return state.control(generation, &action, value);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, generation, action, value);
        Err("当前系统尚未接入 mpv 视频窗口".into())
    }
}

#[tauri::command]
pub async fn mpv_follow(
    webview: tauri::Webview,
    state: tauri::State<'_, MpvState>,
    generation: u64,
    position: Option<f64>,
    rate: f64,
    playing: bool,
) -> Result<(), String> {
    require_main(&webview)?;
    #[cfg(target_os = "macos")]
    return state.follow(generation, position, rate, playing);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, generation, position, rate, playing);
        Err("当前系统尚未接入 mpv 视频窗口".into())
    }
}

#[tauri::command]
pub async fn mpv_close(
    webview: tauri::Webview,
    state: tauri::State<'_, MpvState>,
    generation: Option<u64>,
) -> Result<(), String> {
    require_main(&webview)?;
    #[cfg(target_os = "macos")]
    return state.close(webview, generation).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, generation);
        Ok(())
    }
}
