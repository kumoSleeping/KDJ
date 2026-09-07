//! Bounded decoding for untrusted cover/QR/thumbnail bytes, not full-size workshop media.
use std::io::Cursor;

use image::{DynamicImage, ImageReader, ImageResult, Limits};

pub(crate) fn decode_thumbnail_source(bytes: &[u8]) -> ImageResult<DynamicImage> {
    let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format()?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    reader.decode()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageFormat, Rgb, RgbImage};

    #[test]
    fn ordinary_cover_decodes_without_changing_pixels() {
        let expected = RgbImage::from_pixel(32, 16, Rgb([10, 20, 30]));
        let mut encoded = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(expected.clone())
            .write_to(&mut encoded, ImageFormat::Png)
            .unwrap();
        assert_eq!(
            decode_thumbnail_source(encoded.get_ref())
                .unwrap()
                .to_rgb8(),
            expected
        );
    }

    #[test]
    fn oversized_dimensions_are_rejected_before_pixel_allocation() {
        // Header-only BMPs: width-only violation (tiny allocation), allocation-only violation
        // (75 MB, within dimension limits), and both. Reject before reading/allocating pixels.
        let mut bmp = vec![0u8; 54];
        bmp[..2].copy_from_slice(b"BM");
        bmp[10..14].copy_from_slice(&54u32.to_le_bytes());
        bmp[14..18].copy_from_slice(&40u32.to_le_bytes());
        bmp[26..28].copy_from_slice(&1u16.to_le_bytes());
        bmp[28..30].copy_from_slice(&24u16.to_le_bytes());
        for (width, height) in [(8193u32, 1u32), (5000, 5000), (32768, 32768)] {
            bmp[18..22].copy_from_slice(&width.to_le_bytes());
            bmp[22..26].copy_from_slice(&height.to_le_bytes());
            assert!(matches!(
                decode_thumbnail_source(&bmp),
                Err(image::ImageError::Limits(_))
            ));
        }
    }

    #[test]
    fn malformed_bytes_are_an_error() {
        assert!(decode_thumbnail_source(b"not an image").is_err());
    }
}
