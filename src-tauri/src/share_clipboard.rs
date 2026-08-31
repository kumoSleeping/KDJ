#[cfg(target_os = "macos")]
use base64::Engine as _;
#[cfg(target_os = "macos")]
use objc2::runtime::ProtocolObject;
#[cfg(target_os = "macos")]
use objc2_app_kit::{
    NSPasteboard, NSPasteboardItem, NSPasteboardTypePNG, NSPasteboardTypeString,
    NSPasteboardWriting,
};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSArray, NSData, NSString};

const MAX_SHARE_TEXT_BYTES: usize = 64 * 1024;
const MAX_SHARE_PNG_BYTES: usize = 1024 * 1024;
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

/// QQ for macOS 不会把 HTML 里的 data URL 图片持久化成待上传附件：草稿能预览，
/// 发送后却只剩“加载失败”。这里直接写两个原生 pasteboard item，第一项是实际
/// PNG，第二项是文字，让聊天客户端按顺序取得可上传图片与分享链接。
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn write_share_clipboard(text: String, png: String) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("分享文字不能为空".into());
    }
    if text.len() > MAX_SHARE_TEXT_BYTES {
        return Err("分享文字过长".into());
    }

    let png = base64::engine::general_purpose::STANDARD
        .decode(png.trim())
        .map_err(|_| "分享封面不是有效的 Base64 PNG".to_string())?;
    if png.len() > MAX_SHARE_PNG_BYTES {
        return Err("分享封面过大".into());
    }
    if !png.starts_with(PNG_SIGNATURE) {
        return Err("分享封面不是有效的 PNG".into());
    }

    // SAFETY: AppKit exports these as process-lifetime immutable NSString constants.
    let png_type = unsafe { NSPasteboardTypePNG };
    // SAFETY: Same system-owned immutable constant as above.
    let string_type = unsafe { NSPasteboardTypeString };

    let image_item = NSPasteboardItem::new();
    let image_data = NSData::with_bytes(&png);
    if !image_item.setData_forType(&image_data, png_type) {
        return Err("无法准备分享封面".into());
    }

    let text_item = NSPasteboardItem::new();
    let text = NSString::from_str(text);
    if !text_item.setString_forType(&text, string_type) {
        return Err("无法准备分享文字".into());
    }

    let image_item = ProtocolObject::<dyn NSPasteboardWriting>::from_retained(image_item);
    let text_item = ProtocolObject::<dyn NSPasteboardWriting>::from_retained(text_item);
    let items = NSArray::from_retained_slice(&[image_item, text_item]);
    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    if !pasteboard.writeObjects(&items) {
        return Err("无法写入系统剪贴板".into());
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn write_share_clipboard(_text: String, _png: String) -> Result<(), String> {
    Err("当前系统不支持原生图文剪贴板".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_signature_is_strict() {
        assert_eq!(PNG_SIGNATURE, &[137, 80, 78, 71, 13, 10, 26, 10]);
        assert!(MAX_SHARE_TEXT_BYTES > 0);
        assert!(MAX_SHARE_PNG_BYTES > 0);
    }
}
