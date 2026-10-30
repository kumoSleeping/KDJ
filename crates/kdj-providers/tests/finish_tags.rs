//! A download finished by kdj-media must survive the tag writer: lofty moves the media when it
//! grows `moov`, and only updates the chunk offsets when it edits an existing metadata list.
//! FFmpeg makes the input and reads the result; without it the test returns early.

use std::path::Path;
use std::process::Command;

fn packets(path: &Path) -> String {
    let out = Command::new("ffmpeg").args(["-v", "error", "-i"]).arg(path).args(["-map", "0:a", "-c", "copy", "-f", "md5", "-"]).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

#[tokio::test]
async fn tags_and_a_large_cover_keep_the_copied_audio_intact() {
    if Command::new("ffmpeg").arg("-version").output().is_err() {
        return;
    }
    let dir = std::env::temp_dir().join(format!("kdj-finish-tags-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let source = dir.join("audio.m4s");
    let made = Command::new("ffmpeg")
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "8", "-c:a", "aac", "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-f", "mp4"])
        .arg(&source)
        .status()
        .unwrap();
    assert!(made.success());
    let output = dir.join("out.m4a");
    let cancel = tokio_util::sync::CancellationToken::new();
    kdj_providers::finish::extract_audio(&source, &output, 0, &dir.join("log"), &cancel).await.unwrap();
    // A cover far larger than any padding, so the media has to move.
    let cover = image::RgbImage::from_fn(900, 900, |x, y| image::Rgb([(x * 7) as u8, (y * 13) as u8, ((x ^ y) * 3) as u8]));
    let mut png = Vec::new();
    image::DynamicImage::ImageRgb8(cover).write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
    assert!(png.len() > 200_000);
    kdj_providers::tags::embed_metadata(&output, "Title", &["Artist".to_string()], "", Some(&png)).unwrap();
    assert_eq!(packets(&output), packets(&source));
    let _ = std::fs::remove_dir_all(&dir);
}
