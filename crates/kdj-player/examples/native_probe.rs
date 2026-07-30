use std::{path::Path, sync::Arc, thread, time::Duration};

use kdj_player::{decode_file_with_limit, open_dynamic_default, DeckId, RtCommand};

fn main() {
    let path = std::env::args().nth(1).expect("audio path");
    let decoded = Arc::new(decode_file_with_limit(Path::new(&path), 128 * 1024 * 1024).unwrap());
    let mut player = open_dynamic_default(64, |error| eprintln!("device: {error}")).unwrap();
    player.send(RtCommand::SetMasterGain(0.0)).unwrap();
    player.install(DeckId::A, decoded, 48_000).unwrap();
    player
        .send(RtCommand::SetPlaying {
            playing: true,
            fade_frames: 0,
        })
        .unwrap();
    thread::sleep(Duration::from_millis(80));
    let first = player.snapshot();
    player
        .send(RtCommand::SeekPrepared {
            deck: DeckId::A,
            frame: 96_000,
        })
        .unwrap();
    thread::sleep(Duration::from_millis(40));
    let second = player.snapshot();
    assert!(
        first.deck_frames[0] > 48_000,
        "callback did not advance: {first:?}"
    );
    assert!(
        second.deck_frames[0] > 96_000,
        "seek did not commit: {second:?}"
    );
    println!("native probe ok: {first:?} -> {second:?}");
}
