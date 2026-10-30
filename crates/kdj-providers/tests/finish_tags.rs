//! A download finished by kdj-media must survive the tag writer: lofty moves the media when it
//! grows `moov`, and only updates the chunk offsets when it edits an existing metadata list.
//! The input is kdj-media's DASH audio sample (crates/kdj-media/tests/fixtures/README.md); the
//! result is read back with kdj-media's own MP4 reader.

use std::path::{Path, PathBuf};

/// The bytes of every audio sample, in order.
fn packets(path: &Path) -> Vec<Vec<u8>> {
    let movie = kdj_media::mp4::read::Movie::open(path).unwrap();
    let track = movie.audio().unwrap();
    let file = std::fs::read(path).unwrap();
    track.samples.iter().map(|s| file[s.offset as usize..s.offset as usize + s.size as usize].to_vec()).collect()
}

#[tokio::test]
async fn tags_and_a_large_cover_keep_the_copied_audio_intact() {
    let dir = std::env::temp_dir().join(format!("kdj-finish-tags-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../kdj-media/tests/fixtures/audio.m4s");
    let output = dir.join("out.m4a");
    let cancel = tokio_util::sync::CancellationToken::new();
    kdj_providers::finish::extract_audio(&source, &output, 0, &cancel).await.unwrap();
    // A cover far larger than any padding, so the media has to move.
    let cover = image::RgbImage::from_fn(900, 900, |x, y| image::Rgb([(x * 7) as u8, (y * 13) as u8, ((x ^ y) * 3) as u8]));
    let mut png = Vec::new();
    image::DynamicImage::ImageRgb8(cover).write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
    assert!(png.len() > 200_000);
    kdj_providers::tags::embed_metadata(&output, "Title", &["Artist".to_string()], "", Some(&png)).unwrap();
    assert_eq!(packets(&output), packets(&source));
    let _ = std::fs::remove_dir_all(&dir);
}
