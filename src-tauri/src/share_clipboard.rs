#[cfg(target_os = "macos")]
use base64::Engine as _;
#[cfg(target_os = "macos")]
use objc2::runtime::AnyObject;
#[cfg(target_os = "macos")]
use objc2::runtime::ProtocolObject;
#[cfg(target_os = "macos")]
use objc2_app_kit::{
    NSAttributedStringAppKitDocumentFormats, NSAttributedStringAttachmentConveniences,
    NSDocumentTypeDocumentAttribute, NSPasteboard, NSPasteboardItem, NSPasteboardTypeRTFD,
    NSPasteboardTypeString, NSPasteboardWriting, NSRTFDTextDocumentType, NSTextAttachment,
};
#[cfg(target_os = "macos")]
use objc2_foundation::{
    NSArray, NSAttributedString, NSData, NSDictionary, NSMutableAttributedString, NSRange, NSString,
};
const MAX_SHARE_TEXT_BYTES: usize = 64 * 1024;
const MAX_SHARE_PNG_BYTES: usize = 1024 * 1024;
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

#[cfg(target_os = "macos")]
pub(crate) const SHARE_RTFD_DRAG_TYPE: &str = "com.apple.flat-rtfd";

#[cfg(target_os = "macos")]
fn validate_png(png: &[u8]) -> Result<(), String> {
    if png.len() < 24 || !png.starts_with(PNG_SIGNATURE) || &png[12..16] != b"IHDR" {
        return Err("分享封面不是有效的 PNG".into());
    }
    let width = u32::from_be_bytes(png[16..20].try_into().expect("PNG width is four bytes"));
    let height = u32::from_be_bytes(png[20..24].try_into().expect("PNG height is four bytes"));
    if width == 0 || height == 0 || width > 4096 || height > 4096 {
        return Err("分享封面尺寸无效".into());
    }
    Ok(())
}

/// RTFD 把 PNG 作为真实二进制附件放进富文本，不依赖会在发送时失效的 data URL。
#[cfg(target_os = "macos")]
pub(crate) fn build_share_rtfd(text: &str, png: &[u8]) -> Result<Vec<u8>, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("分享文字不能为空".into());
    }
    validate_png(png)?;

    let image_data = NSData::with_bytes(png);
    let png_type = NSString::from_str("public.png");
    let attachment = NSTextAttachment::new();
    attachment.setContents(Some(&image_data));
    attachment.setFileType(Some(&png_type));
    let attachment_text = NSAttributedString::attributedStringWithAttachment(&attachment);
    let rich_text = NSMutableAttributedString::from_attributed_nsstring(&attachment_text);
    let copy = NSAttributedString::from_nsstring(&NSString::from_str(&format!("\n{text}")));
    rich_text.appendAttributedString(&copy);

    // SAFETY: AppKit owns these immutable process-lifetime NSString constants. The dictionary
    // stores the documented document type value under its matching document-attribute key.
    let document_type = unsafe { NSRTFDTextDocumentType };
    let document_type: &AnyObject = document_type;
    let document_attributes = NSDictionary::from_slices(
        &[unsafe { NSDocumentTypeDocumentAttribute }],
        &[document_type],
    );
    // SAFETY: The requested range is exactly the attributed string's UTF-16 length, and the
    // document-attribute dictionary above has the key/value types required by AppKit.
    let rtfd = unsafe {
        rich_text.RTFDFromRange_documentAttributes(
            NSRange::new(0, rich_text.length()),
            &document_attributes,
        )
    }
    .ok_or_else(|| "无法生成图文分享内容".to_string())?;

    Ok(rtfd.to_vec())
}

/// QQ for macOS 不会把 HTML 里的 data URL 图片持久化成待上传附件：草稿能预览，
/// 发送后却只剩“加载失败”。图片和文字也不能拆成两个 pasteboard item——不少
/// 接收端只读第一项，结果只剩封面。这里把 RTFD 图文与纯文本回退放在同一项。
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
    let rtfd = build_share_rtfd(text, &png)?;

    // SAFETY: AppKit exports these as process-lifetime immutable NSString constants.
    let rtfd_type = unsafe { NSPasteboardTypeRTFD };
    // SAFETY: Same system-owned immutable constant as above.
    let string_type = unsafe { NSPasteboardTypeString };

    let item = NSPasteboardItem::new();
    if !item.setData_forType(&NSData::with_bytes(&rtfd), rtfd_type) {
        return Err("无法准备 RTFD 图文分享内容".into());
    }
    let text = NSString::from_str(text);
    if !item.setString_forType(&text, string_type) {
        return Err("无法准备分享文字".into());
    }

    let item = ProtocolObject::<dyn NSPasteboardWriting>::from_retained(item);
    let items = NSArray::from_retained_slice(&[item]);
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

    #[cfg(target_os = "macos")]
    #[test]
    fn rtfd_share_is_one_embedded_image_followed_by_text() {
        use objc2::AnyThread as _;
        use objc2_app_kit::NSAttributedStringKitAdditions as _;

        // 1×1 transparent PNG. Round-tripping through AppKit proves the serialized pasteboard
        // payload still has exactly the real attachment plus the complete Unicode text.
        let png = base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
            .unwrap();
        let rtfd = build_share_rtfd("歌{曲}\\n\nShare from KDJ", &png).unwrap();
        assert!(!rtfd.is_empty());

        let rtfd_data = NSData::with_bytes(&rtfd);
        // SAFETY: `rtfd_data` remains immutable for the duration of the initializer; the
        // optional document-attributes out-parameter is deliberately omitted.
        let parsed_rtfd = unsafe {
            NSAttributedString::initWithRTFD_documentAttributes(
                NSAttributedString::alloc(),
                &rtfd_data,
                None,
            )
        }
        .expect("AppKit should parse the generated RTFD");
        assert!(parsed_rtfd.containsAttachmentsInRange(NSRange::new(0, parsed_rtfd.length())));
        assert!(parsed_rtfd
            .string()
            .to_string()
            .contains("歌{曲}\\n\nShare from KDJ"));
    }
}
