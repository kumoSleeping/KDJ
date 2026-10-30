//! H.264 Annex B → MP4 samples: access units, the `avcC` record, and the colour
//! description an export promises (BT.709, limited range) written into the SPS.

use crate::bits::{escape, unescape, BitReader, BitWriter};
use crate::mp4::boxes::{mp4_box, BoxBuf};
use anyhow::{bail, ensure, Context, Result};

/// NAL units of an Annex B stream, without start codes or the zero that a four-byte
/// start code leaves at the end of the previous unit.
pub fn nal_units(stream: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut i = 2;
    while i < stream.len() {
        match stream[i] {
            0 => i += 1,
            1 if stream[i - 1] == 0 && stream[i - 2] == 0 => {
                starts.push(i + 1);
                i += 3;
            }
            _ => i += 3,
        }
    }
    let mut units = Vec::with_capacity(starts.len());
    for (n, &start) in starts.iter().enumerate() {
        let end = starts.get(n + 1).map_or(stream.len(), |next| next - 3);
        let mut unit = &stream[start..end.max(start)];
        while unit.len() > 1 && unit.last() == Some(&0) {
            unit = &unit[..unit.len() - 1];
        }
        if !unit.is_empty() {
            units.push(unit);
        }
    }
    units
}

pub fn nal_type(unit: &[u8]) -> u8 {
    unit.first().map_or(0, |b| b & 0x1f)
}

/// One picture's NAL units in decode order.
pub struct AccessUnit<'a> {
    pub units: Vec<&'a [u8]>,
    pub key: bool,
}

/// Groups NAL units into pictures: a slice with `first_mb_in_slice == 0`, or an AUD,
/// parameter set or SEI after a picture's slices, opens the next access unit.
pub fn access_units(stream: &[u8]) -> Result<Vec<AccessUnit<'_>>> {
    let mut out: Vec<AccessUnit> = Vec::new();
    let mut current = AccessUnit { units: Vec::new(), key: false };
    let mut has_slice = false;
    for unit in nal_units(stream) {
        ensure!(unit[0] & 0x80 == 0, "H.264 码流损坏");
        let kind = nal_type(unit);
        let opens = match kind {
            1 | 5 => has_slice && unit.get(1).is_some_and(|b| b & 0x80 != 0),
            6..=9 | 14 | 15 => has_slice,
            _ => false,
        };
        if opens {
            out.push(std::mem::replace(&mut current, AccessUnit { units: Vec::new(), key: false }));
            has_slice = false;
        }
        if matches!(kind, 1 | 5) {
            has_slice = true;
            current.key |= kind == 5;
        }
        current.units.push(unit);
    }
    if has_slice {
        out.push(current);
    }
    Ok(out)
}

/// An access unit as an MP4 sample: four-byte lengths, parameter sets and AUDs left to
/// the sample entry (every GOP of an export carries the same ones).
pub fn sample_bytes(unit: &AccessUnit<'_>) -> Vec<u8> {
    let mut out = Vec::new();
    for nal in &unit.units {
        if matches!(nal_type(nal), 7 | 8 | 9) {
            continue;
        }
        out.extend_from_slice(&(nal.len() as u32).to_be_bytes());
        out.extend_from_slice(nal);
    }
    out
}

const HIGH_PROFILES: [u32; 13] = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];

fn skip_scaling_list(reader: &mut BitReader, size: usize) -> Result<()> {
    let (mut last, mut next) = (8i32, 8i32);
    for _ in 0..size {
        if next != 0 {
            next = (last + reader.se()? + 256) % 256;
        }
        last = if next == 0 { last } else { next };
    }
    Ok(())
}

fn copy_bits(reader: &mut BitReader, writer: &mut BitWriter, count: usize) -> Result<()> {
    for _ in 0..count {
        writer.bit(reader.bit()?);
    }
    Ok(())
}

/// The SPS with its VUI saying BT.709 primaries, transfer and matrix in limited range —
/// what the export's I420 frames are, whatever the encoder wrote. Everything else in the
/// SPS, including the rest of the VUI, is copied bit for bit.
pub fn sps_bt709_limited(sps: &[u8]) -> Result<Vec<u8>> {
    ensure!(nal_type(sps) == 7 && sps.len() > 4, "不是 H.264 SPS");
    let rbsp = unescape(&sps[1..]);
    let mut r = BitReader::new(&rbsp);
    let profile = r.bits(8)?;
    r.bits(16)?;
    r.ue()?;
    if HIGH_PROFILES.contains(&profile) {
        let chroma = r.ue()?;
        if chroma == 3 {
            r.bit()?;
        }
        r.ue()?;
        r.ue()?;
        r.bit()?;
        if r.flag()? {
            for list in 0..if chroma == 3 { 12 } else { 8 } {
                if r.flag()? {
                    skip_scaling_list(&mut r, if list < 6 { 16 } else { 64 })?;
                }
            }
        }
    }
    r.ue()?;
    match r.ue()? {
        0 => {
            r.ue()?;
        }
        1 => {
            r.bit()?;
            r.se()?;
            r.se()?;
            for _ in 0..r.ue()? {
                r.se()?;
            }
        }
        _ => {}
    }
    r.ue()?;
    r.bit()?;
    r.ue()?;
    r.ue()?;
    if !r.flag()? {
        r.bit()?;
    }
    r.bit()?;
    if r.flag()? {
        for _ in 0..4 {
            r.ue()?;
        }
    }
    let vui_flag = r.position();
    let mut w = BitWriter::default();
    let mut copy = BitReader::new(&rbsp);
    copy_bits(&mut copy, &mut w, vui_flag)?;
    w.bit(1);
    if r.flag()? {
        // aspect_ratio_info and overscan_info stay as they are.
        let start = r.position();
        if r.flag()? && r.bits(8)? == 255 {
            r.bits(32)?;
        }
        if r.flag()? {
            r.bit()?;
        }
        let mut copy = BitReader::new(&rbsp);
        copy.bits(start as u32)?;
        copy_bits(&mut copy, &mut w, r.position() - start)?;
        if r.flag()? {
            r.bits(3)?;
            r.bit()?;
            if r.flag()? {
                r.bits(24)?;
            }
        }
        write_signal_type(&mut w);
        // chroma location, timing, HRD and bitstream restriction, then the trailing bits.
        let rest = r.position();
        let mut copy = BitReader::new(&rbsp);
        copy.bits(rest as u32)?;
        let remaining = copy.remaining();
        copy_bits(&mut copy, &mut w, remaining)?;
    } else {
        // No VUI: aspect and overscan absent, the signal type, nothing else.
        w.bits(0, 2);
        write_signal_type(&mut w);
        w.bits(0, 6);
        w.bit(1);
    }
    let mut out = vec![sps[0]];
    let mut body = w.into_bytes();
    // A copied tail ends on the original stop bit; drop any whole zero bytes after it.
    while body.last() == Some(&0) {
        body.pop();
    }
    ensure!(!body.is_empty(), "SPS 改写失败");
    out.extend(escape(&body));
    Ok(out)
}

fn write_signal_type(w: &mut BitWriter) {
    w.bit(1); // video_signal_type_present_flag
    w.bits(5, 3); // video_format: unspecified
    w.bit(0); // video_full_range_flag
    w.bit(1); // colour_description_present_flag
    w.bits(1, 8); // BT.709 primaries
    w.bits(1, 8); // BT.709 transfer
    w.bits(1, 8); // BT.709 matrix
}

/// Picture size coded in an SPS, after cropping.
pub fn sps_dimensions(sps: &[u8]) -> Result<(u32, u32)> {
    ensure!(nal_type(sps) == 7, "不是 H.264 SPS");
    let rbsp = unescape(&sps[1..]);
    let mut r = BitReader::new(&rbsp);
    let profile = r.bits(8)?;
    r.bits(16)?;
    r.ue()?;
    let mut chroma = 1;
    if HIGH_PROFILES.contains(&profile) {
        chroma = r.ue()?;
        if chroma == 3 {
            r.bit()?;
        }
        r.ue()?;
        r.ue()?;
        r.bit()?;
        if r.flag()? {
            for list in 0..if chroma == 3 { 12 } else { 8 } {
                if r.flag()? {
                    skip_scaling_list(&mut r, if list < 6 { 16 } else { 64 })?;
                }
            }
        }
    }
    r.ue()?;
    match r.ue()? {
        0 => {
            r.ue()?;
        }
        1 => {
            r.bit()?;
            r.se()?;
            r.se()?;
            for _ in 0..r.ue()? {
                r.se()?;
            }
        }
        _ => {}
    }
    r.ue()?;
    r.bit()?;
    let width_mbs = r.ue()? + 1;
    let height_units = r.ue()? + 1;
    let frame_mbs_only = r.flag()?;
    if !frame_mbs_only {
        r.bit()?;
    }
    r.bit()?;
    let (mut width, mut height) = (width_mbs * 16, height_units * 16 * if frame_mbs_only { 1 } else { 2 });
    if r.flag()? {
        let (left, right, top, bottom) = (r.ue()?, r.ue()?, r.ue()?, r.ue()?);
        let (unit_x, unit_y) = match chroma {
            0 | 3 => (1, 1),
            2 => (2, 1),
            _ => (2, 2),
        };
        let unit_y = unit_y * if frame_mbs_only { 1 } else { 2 };
        width = width.checked_sub((left + right) * unit_x).context("SPS 裁剪无效")?;
        height = height.checked_sub((top + bottom) * unit_y).context("SPS 裁剪无效")?;
    }
    Ok((width, height))
}

/// The `avc1` sample entry: `avcC` with one SPS and one PPS, and a `colr` box that
/// repeats the colour description for players that read the container instead.
pub fn sample_entry(sps: &[u8], pps: &[u8], width: u32, height: u32) -> Result<Vec<u8>> {
    if sps.len() < 4 || nal_type(sps) != 7 || nal_type(pps) != 8 {
        bail!("缺少 H.264 参数集");
    }
    let mut avcc = BoxBuf::default();
    avcc.u8(1);
    avcc.u8(sps[1]);
    avcc.u8(sps[2]);
    avcc.u8(sps[3]);
    avcc.u8(0xff);
    avcc.u8(0xe1);
    avcc.u16(sps.len() as u16);
    avcc.bytes(sps);
    avcc.u8(1);
    avcc.u16(pps.len() as u16);
    avcc.bytes(pps);
    if HIGH_PROFILES.contains(&(sps[1] as u32)) {
        // 4:2:0, 8-bit: the export only encodes I420.
        avcc.bytes(&[0xfd, 0xf8, 0xf8, 0x00]);
    }
    let mut colr = BoxBuf::default();
    colr.bytes(b"nclx");
    colr.u16(1);
    colr.u16(1);
    colr.u16(1);
    colr.u8(0);
    Ok(visual_entry(&avcc.0, Some(&colr.0), width, height))
}

/// The `avc1` sample entry for a stream that brings its own AVCDecoderConfigurationRecord
/// (an FLV's sequence header): the record as it is, its first SPS giving the size. The
/// colour description stays the stream's own, in its SPS.
pub fn record_sample_entry(record: &[u8]) -> Result<(Vec<u8>, u32, u32)> {
    ensure!(record.len() >= 8 && record[0] == 1, "H.264 配置记录无效");
    ensure!(record[5] & 0x1f >= 1, "H.264 配置记录里没有 SPS");
    let len = u16::from_be_bytes([record[6], record[7]]) as usize;
    let sps = record.get(8..8 + len).context("H.264 配置记录被截断")?;
    let (width, height) = sps_dimensions(sps)?;
    Ok((visual_entry(record, None, width, height), width, height))
}

fn visual_entry(avcc: &[u8], colr: Option<&[u8]>, width: u32, height: u32) -> Vec<u8> {
    let mut entry = BoxBuf::default();
    entry.bytes(&[0; 6]);
    entry.u16(1);
    entry.bytes(&[0; 16]);
    entry.u16(width as u16);
    entry.u16(height as u16);
    entry.u32(0x0048_0000);
    entry.u32(0x0048_0000);
    entry.u32(0);
    entry.u16(1);
    entry.bytes(&[0; 32]);
    entry.u16(0x18);
    entry.u16(0xffff);
    entry.bytes(&mp4_box(b"avcC", avcc));
    if let Some(colr) = colr {
        entry.bytes(&mp4_box(b"colr", colr));
    }
    let mut pasp = BoxBuf::default();
    pasp.u32(1);
    pasp.u32(1);
    entry.bytes(&mp4_box(b"pasp", &pasp.0));
    mp4_box(b"avc1", &entry.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    // x264, 1280x720 High@3.1, no VUI colour description.
    const SPS: [u8; 25] = [
        0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x40, 0x50, 0x05, 0xbb, 0x01, 0x10, 0x00, 0x00, 0x03,
        0x00, 0x10, 0x00, 0x00, 0x03, 0x03, 0xc0, 0xf1, 0x83, 0x19,
    ];

    fn vui_signal(sps: &[u8]) -> (bool, u32, u32, u32, u32) {
        // Re-parse the rewritten SPS down to its signal type.
        let rbsp = unescape(&sps[1..]);
        let mut r = BitReader::new(&rbsp);
        let profile = r.bits(8).unwrap();
        r.bits(16).unwrap();
        r.ue().unwrap();
        if HIGH_PROFILES.contains(&profile) {
            assert_eq!(r.ue().unwrap(), 1);
            r.ue().unwrap();
            r.ue().unwrap();
            r.bit().unwrap();
            assert!(!r.flag().unwrap());
        }
        r.ue().unwrap();
        if r.ue().unwrap() == 0 {
            r.ue().unwrap();
        }
        r.ue().unwrap();
        r.bit().unwrap();
        r.ue().unwrap();
        r.ue().unwrap();
        if !r.flag().unwrap() {
            r.bit().unwrap();
        }
        r.bit().unwrap();
        if r.flag().unwrap() {
            for _ in 0..4 {
                r.ue().unwrap();
            }
        }
        assert!(r.flag().unwrap());
        if r.flag().unwrap() && r.bits(8).unwrap() == 255 {
            r.bits(32).unwrap();
        }
        if r.flag().unwrap() {
            r.bit().unwrap();
        }
        assert!(r.flag().unwrap());
        r.bits(3).unwrap();
        let full = r.flag().unwrap();
        assert!(r.flag().unwrap());
        let (p, t, m) = (r.bits(8).unwrap(), r.bits(8).unwrap(), r.bits(8).unwrap());
        // timing info survives: chroma_loc flag, then timing_info_present
        r.bit().unwrap();
        let timing = r.flag().unwrap();
        let scale = if timing { r.bits(32).unwrap(); r.bits(32).unwrap() } else { 0 };
        (full, p, t, m, scale)
    }

    #[test]
    fn sps_gets_a_bt709_limited_signal_type_and_keeps_its_size_and_timing() {
        let before = sps_dimensions(&SPS).unwrap();
        let rewritten = sps_bt709_limited(&SPS).unwrap();
        assert_eq!(sps_dimensions(&rewritten).unwrap(), before);
        assert_eq!(before, (1280, 720));
        let (full, p, t, m, scale) = vui_signal(&rewritten);
        assert_eq!((full, p, t, m), (false, 1, 1, 1));
        assert_eq!(scale, 60);
        // Idempotent.
        assert_eq!(sps_bt709_limited(&rewritten).unwrap(), rewritten);
    }

    #[test]
    fn access_units_split_on_new_pictures() {
        let mut stream = Vec::new();
        for unit in [&[0x09u8, 0xf0][..], &SPS, &[0x68, 0xeb, 0xe3, 0xcb], &[0x65, 0x88, 0x84], &[0x41, 0x9a, 0x00], &[0x41, 0x9a, 0x01]] {
            stream.extend_from_slice(&[0, 0, 0, 1]);
            stream.extend_from_slice(unit);
        }
        let units = access_units(&stream).unwrap();
        assert_eq!(units.len(), 3);
        assert!(units[0].key && !units[1].key);
        assert_eq!(units[0].units.len(), 4);
        assert_eq!(sample_bytes(&units[0]), [0, 0, 0, 3, 0x65, 0x88, 0x84]);
    }
}
