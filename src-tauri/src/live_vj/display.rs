//! Resolve automatic output from hardware identity, not the main window's location.
use super::monitor_id;

#[cfg(target_os = "macos")]
pub fn external(monitors: &[tauri::Monitor]) -> Result<Option<String>, String> {
    use objc2_core_graphics::{CGDisplayBounds, CGDisplayIsBuiltin, CGGetActiveDisplayList};
    let mut ids = [0u32; 32];
    let mut count = 0;
    let status = unsafe { CGGetActiveDisplayList(ids.len() as u32, ids.as_mut_ptr(), &mut count) };
    if status.0 != 0 { return Err(format!("读取显示设备失败：{}", status.0)); }
    for id in ids.into_iter().take(count as usize) {
        if CGDisplayIsBuiltin(id) { continue; }
        let bounds = CGDisplayBounds(id);
        if let Some(monitor) = monitors.iter().find(|monitor| {
            let position = monitor.position().to_logical::<f64>(monitor.scale_factor());
            (position.x - bounds.origin.x).abs() < 1. && (position.y - bounds.origin.y).abs() < 1.
        }) { return Ok(Some(monitor_id(monitor))); }
    }
    Ok(None)
}

#[cfg(windows)]
pub fn external(monitors: &[tauri::Monitor]) -> Result<Option<String>, String> {
    use windows_sys::Win32::{Devices::Display::*, Foundation::{ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS}};
    // Hotplug may change the required buffer sizes between these two calls.
    for _ in 0..3 {
        let (mut paths_count, mut modes_count) = (0, 0);
        let status = unsafe { GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut paths_count, &mut modes_count) };
        if status != ERROR_SUCCESS { return Err(format!("读取显示设备失败：{status}")); }
        let mut paths: Vec<DISPLAYCONFIG_PATH_INFO> = vec![unsafe { std::mem::zeroed() }; paths_count as usize];
        let mut modes: Vec<DISPLAYCONFIG_MODE_INFO> = vec![unsafe { std::mem::zeroed() }; modes_count as usize];
        let status = unsafe { QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &mut paths_count, paths.as_mut_ptr(), &mut modes_count, modes.as_mut_ptr(), std::ptr::null_mut()) };
        if status == ERROR_INSUFFICIENT_BUFFER { continue; }
        if status != ERROR_SUCCESS { return Err(format!("读取显示设备失败：{status}")); }
        for path in paths.iter().take(paths_count as usize) {
            if matches!(path.targetInfo.outputTechnology, DISPLAYCONFIG_OUTPUT_TECHNOLOGY_INTERNAL | DISPLAYCONFIG_OUTPUT_TECHNOLOGY_LVDS | DISPLAYCONFIG_OUTPUT_TECHNOLOGY_DISPLAYPORT_EMBEDDED | DISPLAYCONFIG_OUTPUT_TECHNOLOGY_UDI_EMBEDDED) { continue; }
            let index = unsafe { path.sourceInfo.Anonymous.modeInfoIdx } as usize;
            let Some(mode) = modes.get(index).filter(|m| m.infoType == DISPLAYCONFIG_MODE_INFO_TYPE_SOURCE) else { continue };
            let source = unsafe { mode.Anonymous.sourceMode };
            if let Some(monitor) = monitors.iter().find(|m| m.position().x == source.position.x && m.position().y == source.position.y) {
                return Ok(Some(monitor_id(monitor)));
            }
        }
        return Ok(None);
    }
    Err("显示设备正在变化，请重试".into())
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn external(monitors: &[tauri::Monitor]) -> Result<Option<String>, String> {
    // Desktop backends without built-in metadata conventionally expose the
    // laptop panel as eDP/LVDS/DSI. A lone unidentified display stays windowed.
    let internal = |m: &tauri::Monitor| m.name().is_some_and(|name| {
        let name = name.to_ascii_lowercase();
        name.contains("edp") || name.contains("lvds") || name.contains("dsi")
    });
    Ok(if monitors.iter().any(internal) || monitors.len() > 1 {
        monitors.iter().find(|m| !internal(m)).map(monitor_id)
    } else { None })
}
