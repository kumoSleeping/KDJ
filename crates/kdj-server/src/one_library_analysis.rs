//! 把 KDJ 已有的本地分析组装成 Pioneer/OneLibrary 可直接读取的 ANLZ 文件。
//!
//! 这里只做格式转换，不解码音频。完整 BPM、首拍和波形可直接生成分析；缺少它们时
//! 仍生成只预留 Cue 段的占位 bundle，让 djay 有稳定、可写的 ANLZ 目标。

use std::path::PathBuf;

use kdj_core::models::{Track, Waveform};

const ANLZ_HEADER_LEN: u32 = 28;
const DETAIL_COLUMNS_PER_SECOND: f64 = 150.0;
const MAX_DETAIL_COLUMNS: usize = 1_500_000;
const PREVIEW_COLUMNS: usize = 400;
const TINY_PREVIEW_COLUMNS: usize = 100;
const COLOR_PREVIEW_COLUMNS: usize = 1_200;

#[derive(Debug, Clone, Copy)]
struct Beat {
    number: u16,
    tempo: u16,
    time_ms: u32,
}

#[derive(Debug, Clone, Copy, Default)]
struct WaveColumn {
    height: u8,
    whiteness: u8,
    low: u8,
    mid: u8,
    high: u8,
}

/// 一首本地曲目中足以避免目标软件重新分析的那部分数据。
pub(crate) struct LocalAnalysis {
    beats: Vec<Beat>,
    waveform: Waveform,
    detail_columns: usize,
}

pub(crate) struct AnalysisFile {
    pub relative_path: PathBuf,
    pub body: Vec<u8>,
}

pub(crate) struct AnalysisBundle {
    /// `content.analysisDataFilePath` 使用带前导 `/` 的 DAT 路径。
    pub database_path: String,
    pub files: Vec<AnalysisFile>,
}

impl AnalysisBundle {
    /// 未完成本地分析的曲目仍必须有关联 ANLZ。djay 把 Cue 写在这些文件里；若
    /// `analysisDataFilePath` 为空，Cue 只活在当前 deck，换歌后立即消失。
    pub fn placeholder(usb_path: &str) -> Self {
        let directory = anlz_directory(usb_path);
        let path = path_section(usb_path);
        let dat = anlz_file(&[path.clone(), empty_cue_section(1), empty_cue_section(0)]);
        let ext = anlz_file(&[
            path.clone(),
            empty_cue_section(1),
            empty_cue_section(0),
            empty_extended_cue_section(1),
            empty_extended_cue_section(0),
        ]);
        let two_ex = anlz_file(&[path]);
        let database_path = format!("/{directory}/ANLZ0000.DAT");
        Self {
            database_path,
            files: vec![
                AnalysisFile {
                    relative_path: PathBuf::from(&directory).join("ANLZ0000.DAT"),
                    body: dat,
                },
                AnalysisFile {
                    relative_path: PathBuf::from(&directory).join("ANLZ0000.EXT"),
                    body: ext,
                },
                AnalysisFile {
                    relative_path: PathBuf::from(directory).join("ANLZ0000.2EX"),
                    body: two_ex,
                },
            ],
        }
    }
}

impl LocalAnalysis {
    /// 只接受已经持久化完成的本地分析与现成波形缓存。
    pub fn from_local(track: &Track, waveform: Waveform) -> Option<Self> {
        track.analyzed_at.as_ref()?;
        let bpm = track
            .bpm
            .filter(|value| value.is_finite() && *value > 0.0)?;
        let first_beat = track
            .first_beat
            .filter(|value| value.is_finite() && *value >= 0.0)?;
        let duration = track
            .duration
            .filter(|value| value.is_finite() && *value > 0.0)
            .or_else(|| {
                (waveform.duration.is_finite() && waveform.duration > 0.0)
                    .then_some(waveform.duration)
            })?;
        let count = waveform.amp.len();
        if count == 0
            || waveform.track_id != track.id
            || waveform.r.len() != count
            || waveform.g.len() != count
            || waveform.b.len() != count
            || waveform.amp.iter().any(|value| !value.is_finite())
        {
            return None;
        }

        let tempo = (bpm * 100.0).round();
        if !(1.0..=f64::from(u16::MAX)).contains(&tempo) {
            return None;
        }
        let tempo = tempo as u16;
        let interval = 60.0 / bpm;
        if !interval.is_finite() || interval <= 0.0 {
            return None;
        }
        let mut time = first_beat.rem_euclid(interval);
        let mut beats = Vec::new();
        while time <= duration {
            let time_ms = (time * 1_000.0).round();
            if time_ms > f64::from(u32::MAX) {
                break;
            }
            beats.push(Beat {
                number: (beats.len() % 4 + 1) as u16,
                tempo,
                time_ms: time_ms as u32,
            });
            time += interval;
        }
        if beats.len() < 2 {
            return None;
        }

        let detail_columns = (duration * DETAIL_COLUMNS_PER_SECOND).round() as usize;
        if detail_columns == 0 || detail_columns > MAX_DETAIL_COLUMNS {
            return None;
        }
        Some(Self {
            beats,
            waveform,
            detail_columns,
        })
    }

    pub fn bundle(&self, usb_path: &str) -> AnalysisBundle {
        let directory = anlz_directory(usb_path);
        let path = path_section(usb_path);
        let dat = anlz_file(&[
            path.clone(),
            vbr_section(),
            beat_grid_section(&self.beats),
            mono_preview_section(b"PWAV", self, PREVIEW_COLUMNS),
            mono_preview_section(b"PWV2", self, TINY_PREVIEW_COLUMNS),
            empty_cue_section(1),
            empty_cue_section(0),
        ]);
        let ext = anlz_file(&[
            path.clone(),
            mono_detail_section(self),
            empty_cue_section(1),
            empty_cue_section(0),
            empty_extended_cue_section(1),
            empty_extended_cue_section(0),
            extended_beat_grid_section(&self.beats),
            color_detail_section(self),
            color_preview_section(self),
            extended_vbr_section(),
        ]);
        let two_ex = anlz_file(&[
            path,
            three_band_detail_section(self),
            three_band_preview_section(self),
            three_band_summary_section(),
        ]);
        let database_path = format!("/{directory}/ANLZ0000.DAT");
        AnalysisBundle {
            database_path,
            files: vec![
                AnalysisFile {
                    relative_path: PathBuf::from(&directory).join("ANLZ0000.DAT"),
                    body: dat,
                },
                AnalysisFile {
                    relative_path: PathBuf::from(&directory).join("ANLZ0000.EXT"),
                    body: ext,
                },
                AnalysisFile {
                    relative_path: PathBuf::from(directory).join("ANLZ0000.2EX"),
                    body: two_ex,
                },
            ],
        }
    }

    fn interpolated(&self, index: usize, count: usize) -> WaveColumn {
        let source_len = self.waveform.amp.len();
        if source_len == 1 || count <= 1 {
            return self.source_column(0);
        }
        let position = index as f64 * (source_len - 1) as f64 / (count - 1) as f64;
        let left = position.floor() as usize;
        let right = position.ceil() as usize;
        if left == right {
            return self.source_column(left);
        }
        let ratio = position - left as f64;
        blend(self.source_column(left), self.source_column(right), ratio)
    }

    fn pooled(&self, index: usize, count: usize) -> WaveColumn {
        let source_len = self.waveform.amp.len();
        if count >= source_len {
            return self.interpolated(index, count);
        }
        let start = index * source_len / count;
        let end = ((index + 1) * source_len).div_ceil(count).min(source_len);
        let mut peak = WaveColumn::default();
        let mut whiteness = 0u32;
        let mut samples = 0u32;
        for source in start..end.max(start + 1).min(source_len) {
            let value = self.source_column(source);
            peak.height = peak.height.max(value.height);
            peak.low = peak.low.max(value.low);
            peak.mid = peak.mid.max(value.mid);
            peak.high = peak.high.max(value.high);
            whiteness += u32::from(value.whiteness);
            samples += 1;
        }
        peak.whiteness = if samples == 0 {
            0
        } else {
            (whiteness / samples) as u8
        };
        peak
    }

    fn source_column(&self, index: usize) -> WaveColumn {
        let amplitude = self.waveform.amp[index].clamp(0.0, 1.0);
        let height = (amplitude * 31.0).round() as u8;
        let low_color = self.waveform.r[index];
        let mid_color = self.waveform.g[index];
        let high_color = self.waveform.b[index];
        let color_peak = low_color.max(mid_color).max(high_color);
        let scale = if color_peak == 0 {
            0.0
        } else {
            f32::from(height) / f32::from(color_peak)
        };
        let band = |value: u8| (f32::from(value) * scale).round().clamp(0.0, 31.0) as u8;
        let color_sum = u32::from(low_color) + u32::from(mid_color) + u32::from(high_color);
        let whiteness = if height == 0 {
            7
        } else if color_sum == 0 {
            0
        } else {
            (u32::from(high_color) * 7 / color_sum).min(7) as u8
        };
        WaveColumn {
            height,
            whiteness,
            low: band(low_color),
            mid: band(mid_color),
            high: band(high_color),
        }
    }
}

fn blend(left: WaveColumn, right: WaveColumn, ratio: f64) -> WaveColumn {
    let mix = |a: u8, b: u8| {
        (f64::from(a) + (f64::from(b) - f64::from(a)) * ratio)
            .round()
            .clamp(0.0, 255.0) as u8
    };
    WaveColumn {
        height: mix(left.height, right.height),
        whiteness: mix(left.whiteness, right.whiteness).min(7),
        low: mix(left.low, right.low).min(31),
        mid: mix(left.mid, right.mid).min(31),
        high: mix(left.high, right.high).min(31),
    }
}

fn tag(name: &[u8; 4], header_extra: &[u8], body: &[u8]) -> Vec<u8> {
    let header_len = 12 + header_extra.len();
    let total_len = header_len + body.len();
    let mut value = Vec::with_capacity(total_len);
    value.extend_from_slice(name);
    value.extend_from_slice(&(header_len as u32).to_be_bytes());
    value.extend_from_slice(&(total_len as u32).to_be_bytes());
    value.extend_from_slice(header_extra);
    value.extend_from_slice(body);
    value
}

fn anlz_file(sections: &[Vec<u8>]) -> Vec<u8> {
    let total_len = ANLZ_HEADER_LEN as usize + sections.iter().map(Vec::len).sum::<usize>();
    let mut value = Vec::with_capacity(total_len);
    value.extend_from_slice(b"PMAI");
    value.extend_from_slice(&ANLZ_HEADER_LEN.to_be_bytes());
    value.extend_from_slice(&(total_len as u32).to_be_bytes());
    value.extend_from_slice(&1u32.to_be_bytes());
    value.extend_from_slice(&0x0001_0000u32.to_be_bytes());
    value.extend_from_slice(&0x0001_0000u32.to_be_bytes());
    value.extend_from_slice(&0u32.to_be_bytes());
    for section in sections {
        value.extend_from_slice(section);
    }
    value
}

fn path_section(path: &str) -> Vec<u8> {
    let mut body = Vec::with_capacity((path.encode_utf16().count() + 1) * 2);
    for unit in path.encode_utf16().chain(std::iter::once(0)) {
        body.extend_from_slice(&unit.to_be_bytes());
    }
    tag(b"PPTH", &(body.len() as u32).to_be_bytes(), &body)
}

fn vbr_section() -> Vec<u8> {
    tag(b"PVBR", &[0; 4], &vec![0; 1_604])
}

fn extended_vbr_section() -> Vec<u8> {
    tag(b"PVB2", &[0; 20], &vec![0; 8_000])
}

fn beat_grid_section(beats: &[Beat]) -> Vec<u8> {
    let mut header = Vec::with_capacity(12);
    header.extend_from_slice(&0u32.to_be_bytes());
    header.extend_from_slice(&0x0008_0000u32.to_be_bytes());
    header.extend_from_slice(&(beats.len() as u32).to_be_bytes());
    let mut body = Vec::with_capacity(beats.len() * 8);
    for beat in beats {
        body.extend_from_slice(&beat.number.to_be_bytes());
        body.extend_from_slice(&beat.tempo.to_be_bytes());
        body.extend_from_slice(&beat.time_ms.to_be_bytes());
    }
    tag(b"PQTZ", &header, &body)
}

fn extended_beat_grid_section(beats: &[Beat]) -> Vec<u8> {
    let mut header = Vec::with_capacity(44);
    header.extend_from_slice(&0u32.to_be_bytes());
    header.extend_from_slice(&0x0100_0002u32.to_be_bytes());
    header.extend_from_slice(&0u32.to_be_bytes());
    for index in 0..2 {
        let beat = beats[index.min(beats.len() - 1)];
        header.extend_from_slice(&beat.number.to_be_bytes());
        header.extend_from_slice(&beat.tempo.to_be_bytes());
        header.extend_from_slice(&beat.time_ms.to_be_bytes());
    }
    header.extend_from_slice(&(beats.len() as u32).to_be_bytes());
    header.extend_from_slice(&0u32.to_be_bytes());
    header.extend_from_slice(&0u32.to_be_bytes());
    header.extend_from_slice(&0u32.to_be_bytes());
    let mut body = Vec::with_capacity(beats.len() * 2);
    for beat in beats {
        body.push(beat.number as u8);
        body.push(0);
    }
    tag(b"PQT2", &header, &body)
}

fn empty_cue_section(kind: u32) -> Vec<u8> {
    let mut header = Vec::with_capacity(12);
    header.extend_from_slice(&kind.to_be_bytes());
    header.extend_from_slice(&0u32.to_be_bytes());
    header.extend_from_slice(&u32::MAX.to_be_bytes());
    tag(b"PCOB", &header, &[])
}

fn empty_extended_cue_section(kind: u32) -> Vec<u8> {
    let mut header = Vec::with_capacity(8);
    header.extend_from_slice(&kind.to_be_bytes());
    header.extend_from_slice(&0u32.to_be_bytes());
    tag(b"PCO2", &header, &[])
}

fn mono_byte(column: WaveColumn) -> u8 {
    ((column.whiteness & 7) << 5) | (column.height & 31)
}

fn mono_preview_section(name: &[u8; 4], analysis: &LocalAnalysis, columns: usize) -> Vec<u8> {
    let body: Vec<u8> = (0..columns)
        .map(|index| mono_byte(analysis.pooled(index, columns)))
        .collect();
    let mut header = Vec::with_capacity(8);
    header.extend_from_slice(&(columns as u32).to_be_bytes());
    header.extend_from_slice(&0x0001_0000u32.to_be_bytes());
    tag(name, &header, &body)
}

fn mono_detail_section(analysis: &LocalAnalysis) -> Vec<u8> {
    let count = analysis.detail_columns;
    let body: Vec<u8> = (0..count)
        .map(|index| mono_byte(analysis.interpolated(index, count)))
        .collect();
    let mut header = Vec::with_capacity(12);
    header.extend_from_slice(&1u32.to_be_bytes());
    header.extend_from_slice(&(count as u32).to_be_bytes());
    header.extend_from_slice(&0x0096_0000u32.to_be_bytes());
    tag(b"PWV3", &header, &body)
}

fn color_detail_section(analysis: &LocalAnalysis) -> Vec<u8> {
    let count = analysis.detail_columns;
    let mut body = Vec::with_capacity(count * 2);
    for index in 0..count {
        let column = analysis.interpolated(index, count);
        let red = scale_3bit(column.high, column.height);
        let green = scale_3bit(column.mid, column.height);
        let blue = scale_3bit(column.low, column.height);
        let encoded = (u16::from(red) << 13)
            | (u16::from(green) << 10)
            | (u16::from(blue) << 7)
            | (u16::from(column.height) << 2);
        body.extend_from_slice(&encoded.to_be_bytes());
    }
    let mut header = Vec::with_capacity(12);
    header.extend_from_slice(&2u32.to_be_bytes());
    header.extend_from_slice(&(count as u32).to_be_bytes());
    header.extend_from_slice(&0x0096_0305u32.to_be_bytes());
    tag(b"PWV5", &header, &body)
}

fn scale_3bit(band: u8, height: u8) -> u8 {
    if height == 0 {
        7
    } else {
        (u16::from(band) * 7 / u16::from(height.max(1))).min(7) as u8
    }
}

fn color_preview_section(analysis: &LocalAnalysis) -> Vec<u8> {
    let mut body = Vec::with_capacity(COLOR_PREVIEW_COLUMNS * 6);
    for index in 0..COLOR_PREVIEW_COLUMNS {
        let column = analysis.pooled(index, COLOR_PREVIEW_COLUMNS);
        let red = scale_3bit(column.high, column.height) * 31 / 7;
        let green = scale_3bit(column.mid, column.height) * 31 / 7;
        let blue = scale_3bit(column.low, column.height) * 31 / 7;
        body.extend_from_slice(&[column.height, column.height, red, green, blue, 0]);
    }
    let mut header = Vec::with_capacity(12);
    header.extend_from_slice(&6u32.to_be_bytes());
    header.extend_from_slice(&(COLOR_PREVIEW_COLUMNS as u32).to_be_bytes());
    header.extend_from_slice(&0u32.to_be_bytes());
    tag(b"PWV4", &header, &body)
}

fn three_band_detail_section(analysis: &LocalAnalysis) -> Vec<u8> {
    let count = analysis.detail_columns;
    let mut body = Vec::with_capacity(count * 3);
    for index in 0..count {
        let column = analysis.interpolated(index, count);
        body.extend_from_slice(&[column.low, column.mid, column.high]);
    }
    let mut header = Vec::with_capacity(12);
    header.extend_from_slice(&3u32.to_be_bytes());
    header.extend_from_slice(&(count as u32).to_be_bytes());
    header.extend_from_slice(&0x0096_0000u32.to_be_bytes());
    tag(b"PWV7", &header, &body)
}

fn three_band_preview_section(analysis: &LocalAnalysis) -> Vec<u8> {
    let mut body = Vec::with_capacity(COLOR_PREVIEW_COLUMNS * 3);
    for index in 0..COLOR_PREVIEW_COLUMNS {
        let column = analysis.pooled(index, COLOR_PREVIEW_COLUMNS);
        body.extend_from_slice(&[column.low, column.mid, column.high]);
    }
    let mut header = Vec::with_capacity(8);
    header.extend_from_slice(&3u32.to_be_bytes());
    header.extend_from_slice(&(COLOR_PREVIEW_COLUMNS as u32).to_be_bytes());
    tag(b"PWV6", &header, &body)
}

fn three_band_summary_section() -> Vec<u8> {
    let mut body = Vec::with_capacity(6);
    body.extend_from_slice(&0x007fu16.to_be_bytes());
    body.extend_from_slice(&0x008cu16.to_be_bytes());
    body.extend_from_slice(&0x008eu16.to_be_bytes());
    tag(b"PWVC", &[0, 0], &body)
}

fn anlz_section_ranges(body: &[u8]) -> Option<(usize, Vec<std::ops::Range<usize>>)> {
    if body.len() < ANLZ_HEADER_LEN as usize || body.get(..4)? != b"PMAI" {
        return None;
    }
    let header_len = usize::try_from(u32::from_be_bytes(body.get(4..8)?.try_into().ok()?)).ok()?;
    let declared_len =
        usize::try_from(u32::from_be_bytes(body.get(8..12)?.try_into().ok()?)).ok()?;
    if header_len < 12 || header_len > body.len() || declared_len != body.len() {
        return None;
    }
    let mut ranges = Vec::new();
    let mut offset = header_len;
    while offset < body.len() {
        let section_header_end = offset.checked_add(12)?;
        if section_header_end > body.len() {
            return None;
        }
        let total_len = usize::try_from(u32::from_be_bytes(
            body.get(offset + 8..section_header_end)?.try_into().ok()?,
        ))
        .ok()?;
        if total_len < 12 {
            return None;
        }
        let end = offset.checked_add(total_len)?;
        if end > body.len() {
            return None;
        }
        ranges.push(offset..end);
        offset = end;
    }
    (offset == body.len()).then_some((header_len, ranges))
}

fn cue_section_key(body: &[u8], range: &std::ops::Range<usize>) -> Option<([u8; 4], u32)> {
    if range.end.saturating_sub(range.start) < 16 {
        return None;
    }
    let tag: [u8; 4] = body.get(range.start..range.start + 4)?.try_into().ok()?;
    if tag != *b"PCOB" && tag != *b"PCO2" {
        return None;
    }
    let list_type = u32::from_be_bytes(
        body.get(range.start + 12..range.start + 16)?
            .try_into()
            .ok()?,
    );
    Some((tag, list_type))
}

/// KDJ 只拥有 beatgrid 与波形；djay/Rekordbox 写入的 PCOB/PCO2 才是演出 Cue 的
/// 权威副本。增量导出可以更新其它段，但绝不能用本地生成的空 Cue 段覆盖它们。
pub(crate) fn preserve_external_cue_sections(generated: &[u8], existing: &[u8]) -> Vec<u8> {
    let Some((generated_header_len, generated_ranges)) = anlz_section_ranges(generated) else {
        return generated.to_vec();
    };
    let Some((_, existing_ranges)) = anlz_section_ranges(existing) else {
        return generated.to_vec();
    };

    let mut merged = Vec::with_capacity(generated.len().max(existing.len()));
    merged.extend_from_slice(&generated[..generated_header_len]);
    for generated_range in generated_ranges {
        let replacement = cue_section_key(generated, &generated_range).and_then(|key| {
            existing_ranges.iter().find_map(|existing_range| {
                (cue_section_key(existing, existing_range) == Some(key))
                    .then(|| &existing[existing_range.clone()])
            })
        });
        merged.extend_from_slice(replacement.unwrap_or(&generated[generated_range]));
    }
    let Ok(total_len) = u32::try_from(merged.len()) else {
        return generated.to_vec();
    };
    merged[8..12].copy_from_slice(&total_len.to_be_bytes());
    merged
}

/// Rekordbox 从音频的 USB 路径计算 USBANLZ 目录；数据库路径也必须指向同一处。
fn anlz_directory(usb_path: &str) -> String {
    let mut hash = 0u32;
    for unit in usb_path.encode_utf16() {
        let unit = u32::from(unit);
        let intermediate = hash.wrapping_mul(0x5bc9).wrapping_add(unit);
        hash = intermediate.wrapping_mul(0x93b5).wrapping_add(unit);
    }
    let hash = hash % 0x30d43;
    let prefix = ((hash >> 0) & 0x01)
        | ((hash >> 1) & 0x02)
        | ((hash >> 4) & 0x04)
        | ((hash >> 4) & 0x08)
        | ((hash >> 5) & 0x10)
        | ((hash >> 8) & 0x20)
        | ((hash >> 10) & 0x40);
    format!("PIONEER/USBANLZ/P{prefix:03X}/{hash:08X}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track() -> Track {
        Track {
            id: 7,
            bpm: Some(120.0),
            first_beat: Some(0.25),
            duration: Some(2.0),
            analyzed_at: Some("2026-01-01T00:00:00Z".into()),
            ..Track::default()
        }
    }

    fn waveform() -> Waveform {
        Waveform {
            track_id: 7,
            duration: 2.0,
            amp: vec![0.0, 0.5, 1.0, 0.25],
            r: vec![0, 255, 64, 32],
            g: vec![0, 64, 255, 64],
            b: vec![0, 32, 64, 255],
        }
    }

    fn tags(body: &[u8]) -> Vec<String> {
        assert_eq!(&body[..4], b"PMAI");
        assert_eq!(
            u32::from_be_bytes(body[8..12].try_into().unwrap()) as usize,
            body.len()
        );
        let mut offset = u32::from_be_bytes(body[4..8].try_into().unwrap()) as usize;
        let mut result = Vec::new();
        while offset < body.len() {
            let total =
                u32::from_be_bytes(body[offset + 8..offset + 12].try_into().unwrap()) as usize;
            assert!(total >= 12 && offset + total <= body.len());
            result.push(String::from_utf8_lossy(&body[offset..offset + 4]).into_owned());
            offset += total;
        }
        assert_eq!(offset, body.len());
        result
    }

    #[test]
    fn analysis_bundle_contains_grid_and_all_waveform_generations() {
        let analysis = LocalAnalysis::from_local(&track(), waveform()).unwrap();
        let bundle = analysis.bundle("/Contents/KDJ/Test.mp3");
        assert_eq!(bundle.files.len(), 3);
        assert_eq!(
            tags(&bundle.files[0].body),
            ["PPTH", "PVBR", "PQTZ", "PWAV", "PWV2", "PCOB", "PCOB"]
        );
        assert_eq!(
            tags(&bundle.files[1].body),
            ["PPTH", "PWV3", "PCOB", "PCOB", "PCO2", "PCO2", "PQT2", "PWV5", "PWV4", "PVB2"]
        );
        assert_eq!(
            tags(&bundle.files[2].body),
            ["PPTH", "PWV7", "PWV6", "PWVC"]
        );
        assert!(bundle.database_path.ends_with("/ANLZ0000.DAT"));
    }

    #[test]
    fn path_hash_matches_a_rekordbox_ground_truth_export() {
        let path = "/Contents/Various Artists/Reel People Music Sampler Volume 3/04 Joe Buhdha Presents Terri Walker – Feel .aiff";
        assert_eq!(anlz_directory(path), "PIONEER/USBANLZ/P040/0001C418");
    }

    #[test]
    fn incomplete_local_analysis_keeps_the_target_reanalysis_fallback() {
        let mut incomplete = track();
        incomplete.first_beat = None;
        assert!(LocalAnalysis::from_local(&incomplete, waveform()).is_none());
        incomplete.first_beat = Some(0.25);
        incomplete.analyzed_at = None;
        assert!(LocalAnalysis::from_local(&incomplete, waveform()).is_none());
    }

    #[test]
    fn placeholder_bundle_reserves_writable_memory_hot_and_extended_cues() {
        let bundle = AnalysisBundle::placeholder("/Contents/KDJ/Test.mp3");
        assert_eq!(bundle.files.len(), 3);
        let dat = &bundle.files[0].body;
        let dat_keys: Vec<_> = anlz_section_ranges(dat)
            .unwrap()
            .1
            .iter()
            .filter_map(|range| cue_section_key(dat, range))
            .collect();
        assert_eq!(dat_keys, vec![(*b"PCOB", 1), (*b"PCOB", 0)]);
        let ext = &bundle.files[1].body;
        let ext_keys: Vec<_> = anlz_section_ranges(ext)
            .unwrap()
            .1
            .iter()
            .filter_map(|range| cue_section_key(ext, range))
            .collect();
        assert_eq!(
            ext_keys,
            vec![(*b"PCOB", 1), (*b"PCOB", 0), (*b"PCO2", 1), (*b"PCO2", 0),]
        );
        assert!(bundle.database_path.ends_with("/ANLZ0000.DAT"));
    }

    #[test]
    fn incremental_analysis_keeps_external_cue_sections_byte_for_byte() {
        let analysis = LocalAnalysis::from_local(&track(), waveform()).unwrap();
        let generated = analysis.bundle("/Contents/KDJ/Test.mp3").files[0]
            .body
            .clone();
        let (_, ranges) = anlz_section_ranges(&generated).unwrap();
        let hot_range = ranges
            .into_iter()
            .find(|range| cue_section_key(&generated, range) == Some((*b"PCOB", 1)))
            .unwrap();
        let mut external_hot = generated[hot_range.clone()].to_vec();
        external_hot[18..20].copy_from_slice(&1u16.to_be_bytes());
        external_hot.extend_from_slice(b"PCPT-external-cue");
        let section_len = u32::try_from(external_hot.len()).unwrap();
        external_hot[8..12].copy_from_slice(&section_len.to_be_bytes());

        let mut existing = Vec::new();
        existing.extend_from_slice(&generated[..hot_range.start]);
        existing.extend_from_slice(&external_hot);
        existing.extend_from_slice(&generated[hot_range.end..]);
        let existing_len = u32::try_from(existing.len()).unwrap();
        existing[8..12].copy_from_slice(&existing_len.to_be_bytes());

        let mut regenerated = generated.clone();
        // 改一个非 Cue 段字节，证明合并仍采用新分析内容。
        let path_range = anlz_section_ranges(&regenerated).unwrap().1[0].clone();
        regenerated[path_range.end - 2] ^= 0x01;

        let merged = preserve_external_cue_sections(&regenerated, &existing);
        let (_, merged_ranges) = anlz_section_ranges(&merged).unwrap();
        let merged_hot = merged_ranges
            .into_iter()
            .find(|range| cue_section_key(&merged, range) == Some((*b"PCOB", 1)))
            .unwrap();
        assert_eq!(&merged[merged_hot], external_hot);
        assert_eq!(merged[path_range.end - 2], regenerated[path_range.end - 2]);
    }
}
