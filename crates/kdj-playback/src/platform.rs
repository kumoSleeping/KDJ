use std::sync::Arc;

use kdj_player::{
    open_dynamic_default, DeckId, DecodedTrack, DynamicPlayer, RtCommand, StemFrame, StreamSource,
    TransportSnapshot,
};

#[derive(Clone, Copy, Debug)]
pub struct PlaybackOutputSpec {
    pub sample_rate: u32,
    pub channels: usize,
}

/// Platform output boundary consumed by the cross-platform coordinator.
///
/// Desktop uses the CPAL implementation below. Android/iOS adapters can drive the same renderer
/// from AAudio/AudioUnit while keeping media-session and interruption policy in platform code.
pub trait PlaybackOutput {
    fn spec(&self) -> PlaybackOutputSpec;
    fn install_stream(
        &mut self,
        deck: DeckId,
        source: Arc<StreamSource>,
        start_frame: u64,
    ) -> Result<u64, String>;
    fn install_stem_stream(
        &mut self,
        deck: DeckId,
        source: Arc<StreamSource<StemFrame>>,
        start_frame: u64,
    ) -> Result<u64, String>;
    /// Installs a bounded in-memory source for specialist/offline paths. Normal transport loops
    /// stay on the streaming source and use its worker-owned PCM reservoir.
    fn install_decoded(
        &mut self,
        deck: DeckId,
        track: Arc<DecodedTrack>,
        start_frame: u64,
    ) -> Result<u64, String>;
    fn clear(&mut self, deck: DeckId) -> Result<(), String>;
    fn send(&mut self, command: RtCommand) -> Result<(), String>;
    fn snapshot(&mut self) -> TransportSnapshot;
}

pub trait PlaybackOutputFactory: Send + Sync + 'static {
    fn open(
        &self,
        on_error: Box<dyn FnMut(String) + Send>,
    ) -> Result<Box<dyn PlaybackOutput>, String>;
}

#[derive(Default)]
pub struct CpalOutputFactory;

impl PlaybackOutputFactory for CpalOutputFactory {
    fn open(
        &self,
        mut on_error: Box<dyn FnMut(String) + Send>,
    ) -> Result<Box<dyn PlaybackOutput>, String> {
        open_dynamic_default(256, move |error| on_error(error.to_string()))
            .map(|player| Box::new(player) as Box<dyn PlaybackOutput>)
            .map_err(|error| error.to_string())
    }
}

impl PlaybackOutput for DynamicPlayer {
    fn spec(&self) -> PlaybackOutputSpec {
        let spec = DynamicPlayer::spec(self);
        PlaybackOutputSpec {
            sample_rate: spec.sample_rate,
            channels: spec.channels,
        }
    }

    fn install_stream(
        &mut self,
        deck: DeckId,
        source: Arc<StreamSource>,
        start_frame: u64,
    ) -> Result<u64, String> {
        DynamicPlayer::install_stream(self, deck, source, start_frame)
            .map_err(|error| error.to_string())
    }

    fn install_stem_stream(
        &mut self,
        deck: DeckId,
        source: Arc<StreamSource<StemFrame>>,
        start_frame: u64,
    ) -> Result<u64, String> {
        DynamicPlayer::install_stem_stream(self, deck, source, start_frame)
            .map_err(|error| error.to_string())
    }

    fn install_decoded(
        &mut self,
        deck: DeckId,
        track: Arc<DecodedTrack>,
        start_frame: u64,
    ) -> Result<u64, String> {
        DynamicPlayer::install(self, deck, track, start_frame).map_err(|error| error.to_string())
    }

    fn clear(&mut self, deck: DeckId) -> Result<(), String> {
        DynamicPlayer::clear(self, deck).map_err(|error| error.to_string())
    }

    fn send(&mut self, command: RtCommand) -> Result<(), String> {
        DynamicPlayer::send(self, command).map_err(|error| error.to_string())
    }

    fn snapshot(&mut self) -> TransportSnapshot {
        DynamicPlayer::snapshot(self)
    }
}
