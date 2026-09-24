//! WebView IPC can outlive the native mouse event. Never pass a nil/stale event
//! to Tao's drag_window (which dereferences NSApplication.currentEvent).
use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSEvent, NSEventType, NSWindow};
use objc2_foundation::NSProcessInfo;

pub fn start(window: tauri::Window) -> Result<(), tauri::Error> {
    let target = window.clone();
    window.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else { return; };
        // A queued drag after mouse-up is obsolete, not a reason to move the
        // window or synthesize another gesture.
        if NSEvent::pressedMouseButtons() & 1 == 0 { return; }
        let raw = match target.ns_window() {
            Ok(raw) => raw,
            Err(error) => { tracing::warn!(%error, "window drag target unavailable"); return; }
        };
        // SAFETY: Tauri owns this NSWindow for target's lifetime. Both the lookup
        // and all AppKit calls run in one main-thread closure holding that owner.
        let Some(native) = (unsafe { raw.cast::<NSWindow>().as_ref() }) else { return; };
        let event = NSApplication::sharedApplication(mtm).currentEvent().filter(|event| {
            event.windowNumber() == native.windowNumber()
                && matches!(event.r#type(), NSEventType::LeftMouseDown | NSEventType::LeftMouseDragged)
        }).or_else(|| {
            // IPC often arrives during an application-defined event, or with no
            // currentEvent at all. The physical button is still down: recreate
            // only its mouse-down in this window's coordinate space.
            NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
                NSEventType::LeftMouseDown,
                native.mouseLocationOutsideOfEventStream(),
                NSEvent::modifierFlags_class(),
                NSProcessInfo::processInfo().systemUptime(),
                native.windowNumber(),
                None, 0, 1, 1.,
            )
        });
        if let Some(event) = event {
            native.performWindowDragWithEvent(&event);
        }
    })
}
