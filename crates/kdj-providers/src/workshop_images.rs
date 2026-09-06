//! Local still/animated pictures. Decode GIF disposal in source order; never retain
//! all full-size frames in memory. Playback and export share the same frame clock.
use anyhow::{bail, Context, Result};
use image::{AnimationDecoder, DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use std::{
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
    #[test]
    fn unequal_gif_frame_delays_repeat_on_the_same_boundary() {
        assert_eq!(
            [0., 99., 100., 299., 300., 450.].map(|t| frame_index(&[100., 300.], t)),
            [0, 0, 1, 1, 0, 1]
        );
    }
}
