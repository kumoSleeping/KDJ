//! KDJ regression: muxed HLS may finish one track before the other.
//! Keep every sample in a single-track tail, but require a complete first TS
//! segment and reject empty/corrupt subsequent segments. No network or temp files.
use std::sync::Arc;

use hls_transmux::{
    transmux_hls_to_writer_async, HlsInput, MemorySource, OutputFormat, SourceLocation,
    TransmuxOptions,
};
use url::Url;

const TS: &[u8] = include_bytes!("../../../vendor/hls-transmux/tests/fixtures/h264_aac_fhd.ts");
const VIDEO_PID: u16 = 256;
const AUDIO_PID: u16 = 257;

fn tail(keep: Option<u16>) -> Vec<u8> {
    TS.chunks_exact(188)
        .filter(|p| {
            let pid = (u16::from(p[1] & 31) << 8) | u16::from(p[2]);
            !matches!(pid, VIDEO_PID | AUDIO_PID) || Some(pid) == keep
        })
        .flat_map(|p| {
            let mut p = p.to_vec();
            let pid = (u16::from(p[1] & 31) << 8) | u16::from(p[2]);
            // Shift PES PTS/DTS by ten seconds so the tail follows the fixture.
            if matches!(pid, VIDEO_PID | AUDIO_PID) && p[1] & 64 != 0 {
                let offset = if p[3] & 32 != 0 { 5 + p[4] as usize } else { 4 };
                assert_eq!(&p[offset..offset + 3], &[0, 0, 1]);
                let stamps = match p[offset + 7] >> 6 {
                    2 => 1,
                    3 => 2,
                    _ => 0,
                };
                for i in 0..stamps {
                    let b = &mut p[offset + 9 + i * 5..offset + 14 + i * 5];
                    let pts = (u64::from((b[0] >> 1) & 7) << 30)
                        | (u64::from(b[1]) << 22)
                        | (u64::from(b[2] >> 1) << 15)
                        | (u64::from(b[3]) << 7)
                        | u64::from(b[4] >> 1);
                    let pts = pts + 900_000;
                    b[0] = (b[0] & 0xf0) | (((pts >> 30) as u8 & 7) << 1) | 1;
                    b[1] = (pts >> 22) as u8;
                    b[2] = ((pts >> 15) as u8 & 0x7f) << 1 | 1;
                    b[3] = (pts >> 7) as u8;
                    b[4] = (pts as u8 & 0x7f) << 1 | 1;
                }
            }
            p
        })
        .collect()
}

async fn remux(segments: Vec<Vec<u8>>) -> hls_transmux::Result<Vec<u8>> {
    let mut playlist = String::from("#EXTM3U\n#EXT-X-TARGETDURATION:10\n");
    let mut source = MemorySource::new();
    for (i, data) in segments.into_iter().enumerate() {
        playlist.push_str(&format!("#EXTINF:10,\n{i}.ts\n"));
        source = source.segment(format!("https://fixture.test/{i}.ts"), data);
    }
    playlist.push_str("#EXT-X-ENDLIST\n");
    let source = source.text("https://fixture.test/media.m3u8", playlist);
    let mut output = Vec::new();
    transmux_hls_to_writer_async(
        HlsInput::custom(
            Arc::new(source),
            SourceLocation::Url(Url::parse("https://fixture.test/media.m3u8").unwrap()),
        ),
        &mut output,
        TransmuxOptions {
            output_format: OutputFormat::FragmentedMp4,
            ..Default::default()
        },
    )
    .await?;
    Ok(output)
}

fn boxes(mut bytes: &[u8]) -> Vec<([u8; 4], &[u8])> {
    let mut result = Vec::new();
    while !bytes.is_empty() {
        assert!(bytes.len() >= 8);
        let len = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
        assert!(len >= 8 && len <= bytes.len());
        result.push((bytes[4..8].try_into().unwrap(), &bytes[8..len]));
        bytes = &bytes[len..];
    }
    result
}

fn sample_counts(mp4: &[u8]) -> [u32; 2] {
    let mut counts = [0, 0];
    for (_, moof) in boxes(mp4).into_iter().filter(|(kind, _)| kind == b"moof") {
        for (_, traf) in boxes(moof).into_iter().filter(|(kind, _)| kind == b"traf") {
            let children = boxes(traf);
            let tfhd = children.iter().find(|(kind, _)| kind == b"tfhd").unwrap().1;
            let track = u32::from_be_bytes(tfhd[4..8].try_into().unwrap()) as usize;
            assert!((1..=2).contains(&track));
            for (_, trun) in children.into_iter().filter(|(kind, _)| kind == b"trun") {
                counts[track - 1] += u32::from_be_bytes(trun[4..8].try_into().unwrap());
            }
        }
    }
    counts
}

#[tokio::test]
async fn sparse_ts_audio_tail_preserves_all_samples() {
    let baseline = sample_counts(&remux(vec![TS.to_vec()]).await.unwrap());
    assert!(baseline.iter().all(|count| *count > 0));
    let actual = sample_counts(
        &remux(vec![TS.to_vec(), tail(Some(AUDIO_PID))])
            .await
            .unwrap(),
    );
    assert_eq!(actual, [baseline[0], baseline[1] * 2]);
}

#[tokio::test]
async fn sparse_ts_video_tail_preserves_all_samples() {
    let baseline = sample_counts(&remux(vec![TS.to_vec()]).await.unwrap());
    let actual = sample_counts(
        &remux(vec![TS.to_vec(), tail(Some(VIDEO_PID))])
            .await
            .unwrap(),
    );
    assert_eq!(actual, [baseline[0] * 2, baseline[1]]);
}

#[tokio::test]
async fn sparse_ts_rejects_missing_initial_track_and_invalid_tails() {
    for pid in [AUDIO_PID, VIDEO_PID] {
        assert!(remux(vec![tail(Some(pid)), TS.to_vec()]).await.is_err());
    }
    for invalid in [
        tail(None),
        vec![],
        TS[..TS.len() - 1].to_vec(),
        vec![0; 188],
    ] {
        assert!(remux(vec![TS.to_vec(), invalid]).await.is_err());
    }
}
