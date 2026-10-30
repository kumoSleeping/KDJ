//! Picture files. The editor that used them as clips was taken out after 1.1.0-rc19; a picture
//! row an earlier build put in the library stays, and is never analysed or played.
use std::path::Path;

pub fn is_image_extension(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "webp" | "bmp" | "gif"
    )
}
pub fn is_image_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(is_image_extension)
}
