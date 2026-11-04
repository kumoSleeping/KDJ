//! Local still/animated pictures. Decode GIF disposal in source order; never retain
//! all full-size frames in memory. Playback and export share the same frame clock.
use anyhow::{bail, Context, Result};
use image::{AnimationDecoder, DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use std::{
    collections::BTreeSet,
    fs::File,
    io::{BufReader, Cursor},
    path::Path,
};

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
fn reader(path: &Path) -> Result<BufReader<File>> {
    Ok(BufReader::new(File::open(path)?))
}
fn limits() -> Limits {
    let mut limits = Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(256 * 1024 * 1024);
    limits
}
fn still(path: &Path) -> Result<DynamicImage> {
    let mut r = ImageReader::open(path)?.with_guessed_format()?;
    r.limits(limits());
    let mut decoder = r.into_decoder()?;
    let orientation = decoder.orientation()?;
    let mut image = DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);
    Ok(image)
}
fn gif(path: &Path) -> Result<image::codecs::gif::GifDecoder<BufReader<File>>> {
    let mut decoder = image::codecs::gif::GifDecoder::new(reader(path)?)?;
    decoder.set_limits(limits())?;
    Ok(decoder)
}
#[derive(Debug)]
pub struct Info {
    pub width: u32,
    pub height: u32,
    pub frame_ends_ms: Vec<f64>,
}
pub fn inspect(path: &Path) -> Result<Info> {
    let format = ImageReader::open(path)?
        .with_guessed_format()?
        .format()
        .context("无法识别图片格式")?;
    if !is_image_path(path) {
        bail!("不支持此图片格式")
    }
    match format {
        ImageFormat::Gif => {
            let decoder = gif(path)?;
            let (width, height) = decoder.dimensions();
            let mut ends = vec![];
            let mut time = 0.;
            for frame in decoder.into_frames() {
                let frame = frame?;
                let (n, d) = frame.delay().numer_denom_ms();
                // Match GIF's common zero-delay convention, independent of WebKit.
                time += if n == 0 {
                    100.
                } else {
                    n as f64 / d.max(1) as f64
                };
                ends.push(time);
                if ends.len() > 100_000 || time > 21_600_000. {
                    bail!("GIF 长度超出范围")
                }
            }
            if ends.is_empty() {
                bail!("GIF 没有可用画面")
            }
            Ok(Info {
                width,
                height,
                frame_ends_ms: ends,
            })
        }
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP | ImageFormat::Bmp => {
            if format == ImageFormat::Png
                && image::codecs::png::PngDecoder::new(reader(path)?)?.is_apng()?
            {
                bail!("暂不支持 APNG")
            }
            if format == ImageFormat::WebP
                && image::codecs::webp::WebPDecoder::new(reader(path)?)?.has_animation()
            {
                bail!("暂不支持动态 WebP")
            }
            let image = still(path)?;
            Ok(Info {
                width: image.width(),
                height: image.height(),
                frame_ends_ms: vec![],
            })
        }
        _ => bail!("不支持此图片格式"),
    }
}
/// Bound and normalize a WebView-rendered caption before retaining its PNG pixels.
pub fn subtitle_png(bytes: &[u8]) -> Result<(u32, u32, Vec<u8>)> {
    let mut reader = ImageReader::with_format(Cursor::new(bytes), ImageFormat::Png);
    let mut limits = Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let decoder = reader.into_decoder()?;
    let (width, height) = decoder.dimensions();
    if width as u64 * height as u64 > 8_388_608 { bail!("字幕画面过大") }
    let image = DynamicImage::from_decoder(decoder)?;
    let mut png = Cursor::new(Vec::new());
    image.write_to(&mut png, ImageFormat::Png)?;
    Ok((width, height, png.into_inner()))
}
pub fn frame_index(ends: &[f64], ms: f64) -> usize {
    let duration = ends.last().copied().unwrap_or(1.).max(1.);
    let time = ms.max(0.) % duration;
    ends.partition_point(|end| *end <= time)
        .min(ends.len().saturating_sub(1))
}
pub fn frame_png(path: &Path, animated: bool, index: usize, width: u32) -> Result<Vec<u8>> {
    let image = if animated {
        let frame = gif(path)?
            .into_frames()
            .nth(index)
            .context("GIF 帧不存在")??;
        DynamicImage::ImageRgba8(frame.into_buffer())
    } else {
        still(path)?
    };
    encode(image, width)
}
/// Export needs many frames of one GIF: decode it once in order, holding one frame
/// at a time, instead of replaying from frame 0 for every index as `frame_png` does.
pub fn frame_pngs(
    path: &Path,
    wanted: &BTreeSet<usize>,
    width: u32,
    mut sink: impl FnMut(usize, Vec<u8>) -> Result<()>,
) -> Result<()> {
    let Some(&last) = wanted.last() else { return Ok(()) };
    let mut frames = gif(path)?.into_frames();
    for index in 0..=last {
        let frame = frames.next().context("GIF 帧不存在")??;
        if wanted.contains(&index) {
            sink(index, encode(DynamicImage::ImageRgba8(frame.into_buffer()), width)?)?;
        }
    }
    Ok(())
}
fn encode(image: DynamicImage, width: u32) -> Result<Vec<u8>> {
    let image = if width > 0 {
        image.thumbnail(width, width)
    } else {
        image
    };
    let mut out = Cursor::new(Vec::new());
    image.write_to(&mut out, ImageFormat::Png)?;
    Ok(out.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageEncoder, Rgb, RgbImage};
    #[test]
    fn jpeg_orientation_is_applied_before_reporting_size_and_decoding() {
        struct Fixture(std::path::PathBuf);
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }
        let file = Fixture(
            std::env::temp_dir().join(format!("kdj-oriented-{}.jpg", rand::random::<u64>())),
        );
        let pixels = RgbImage::from_pixel(40, 20, Rgb([255, 0, 0]));
        let mut encoder = image::codecs::jpeg::JpegEncoder::new(File::create(&file.0).unwrap());
        // Little-endian TIFF, one IFD entry: orientation=6 (90° clockwise).
        encoder
            .set_exif_metadata(vec![
                b'I', b'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0,
                0, 0,
            ])
            .unwrap();
        encoder.encode_image(&pixels).unwrap();
        drop(encoder);
        let info = inspect(&file.0).unwrap();
        assert_eq!((info.width, info.height), (20, 40));
        let png = frame_png(&file.0, false, 0, 0).unwrap();
        let decoded = image::load_from_memory(&png).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (20, 40));
    }
    struct TempGif(std::path::PathBuf);
    impl Drop for TempGif {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    fn temp_gif(count: u32, width: u32, height: u32) -> TempGif {
        use image::{codecs::gif::GifEncoder, Delay, Frame, Rgba, RgbaImage};
        let file = TempGif(std::env::temp_dir().join(format!("kdj-frames-{}.gif", rand::random::<u64>())));
        // Offset partial frames composite over earlier ones, like real GIF deltas.
        let frames = (0..count).map(|i| {
            let (w, h, x, y) = if i % 3 == 0 { (width, height, 0, 0) } else { (width / 2, height / 3, i % (width / 2), i % (height / 2)) };
            let img = RgbaImage::from_fn(w, h, |x, y| Rgba([(x + i) as u8, (y * 2 + i) as u8, (i * 3) as u8, if (x + y + i) % 9 == 0 { 0 } else { 255 }]));
            Frame::from_parts(img, x, y, Delay::from_numer_denom_ms(40, 1))
        });
        GifEncoder::new(File::create(&file.0).unwrap()).encode_frames(frames).unwrap();
        file
    }
    #[test]
    fn one_pass_gif_frames_match_single_frame_decoding() {
        let file = temp_gif(24, 64, 48);
        for width in [0, 160, 32] {
            let wanted = BTreeSet::from([0, 1, 5, 6, 17, 23]);
            let mut seen = vec![];
            frame_pngs(&file.0, &wanted, width, |index, png| {
                assert_eq!(png, frame_png(&file.0, true, index, width).unwrap(), "frame {index} width {width}");
                seen.push(index);
                Ok(())
            })
            .unwrap();
            assert_eq!(seen, wanted.into_iter().collect::<Vec<_>>());
        }
        let error = frame_pngs(&file.0, &BTreeSet::from([3, 24]), 0, |_, _| Ok(())).unwrap_err();
        assert_eq!(error.to_string(), frame_png(&file.0, true, 24, 0).unwrap_err().to_string());
    }
    #[test]
    #[ignore = "benchmark: cargo test -p kdj-providers --release --lib gif_frame_cost -- --ignored --nocapture"]
    fn gif_frame_cost() {
        let file = temp_gif(200, 480, 270);
        let t = std::time::Instant::now();
        let n = gif(&file.0).unwrap().into_frames().map(|f| f.unwrap()).count();
        let decode_only = t.elapsed();
        let t = std::time::Instant::now();
        let mut one_pass = vec![];
        frame_pngs(&file.0, &(0..200).collect(), 0, |_, png| Ok(one_pass.push(png))).unwrap();
        let one_pass_time = t.elapsed();
        let t = std::time::Instant::now();
        let per_frame = (0..200).map(|i| frame_png(&file.0, true, i, 0).unwrap()).collect::<Vec<_>>();
        let per_frame_time = t.elapsed();
        assert_eq!(one_pass, per_frame);
        eprintln!("frames={n} decode_only={decode_only:?} frame_pngs={one_pass_time:?} frame_png_each={per_frame_time:?} each/decode={:.1} each/frame_pngs={:.1}",
            per_frame_time.as_secs_f64() / decode_only.as_secs_f64(), per_frame_time.as_secs_f64() / one_pass_time.as_secs_f64());
    }
    #[test]
    fn unequal_gif_frame_delays_repeat_on_the_same_boundary() {
        assert_eq!(
            [0., 99., 100., 299., 300., 450.].map(|t| frame_index(&[100., 300.], t)),
            [0, 0, 1, 1, 0, 1]
        );
    }
}
