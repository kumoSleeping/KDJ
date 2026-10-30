//! A placement locked to the song's beats: the video's own beats, carried by a placement found by
//! listening (a recording or melody match, only roughly timed and sped), are paired with the
//! song's beats near where they land, and the speed and start that put them on those beats are
//! fitted by least squares. A remix plays the same music at another tempo, often re-timed in
//! places: one straight line through the pairs is the whole placement at one speed; following
//! where the pairs bend gives pieces, each with its own speed, joined end to end.
//!
//! All times are seconds: video time for the video's beats and placements, song time for the
//! song's. A placement maps `video` to `ref_at + (video - video_in) / speed`.

/// One stretch of the video laid on the song.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Piece {
    pub video_in: f64,
    pub video_out: f64,
    pub ref_at: f64,
    pub speed: f64,
}

impl Piece {
    /// Where video second `v` lands in the song.
    pub fn at(&self, v: f64) -> f64 {
        self.ref_at + (v - self.video_in) / self.speed
    }
}

/// What a placement locked to the beats is: its pieces (one for a straight lock), how far the
/// paired beats are from the song's on average (milliseconds, median), and how many of the
/// video's beats found a song beat out of how many it has there.
#[derive(Debug, Clone, PartialEq)]
pub struct Locked {
    pub pieces: Vec<Piece>,
    pub error_ms: f64,
    pub matched: usize,
    pub beats: usize,
}

/// Pairs fewer than this do not lock a placement.
const MIN_PAIRS: usize = 8;
/// The song's beats a piece of the bent lock spans at least (four bars).
const PIECE_BEATS: usize = 16;

fn period(beats: &[f64]) -> f64 {
    let mut gaps: Vec<f64> = beats.windows(2).map(|w| w[1] - w[0]).filter(|g| *g > 0.).collect();
    if gaps.is_empty() {
        return 0.5;
    }
    crate::dsp::median(&mut gaps)
}

/// The song beat nearest `t` and how far it is.
fn nearest(song: &[f64], t: f64) -> Option<(f64, f64)> {
    let i = song.partition_point(|b| *b < t);
    [i.checked_sub(1), Some(i)].into_iter().flatten().filter_map(|j| song.get(j)).map(|&b| (b, (b - t).abs()))
        .min_by(|a, b| a.1.total_cmp(&b.1))
}

/// Each video beat of `video` inside the piece with the song beat it lands near (within `within`).
fn pairs(video: &[f64], song: &[f64], piece: &Piece, within: f64) -> Vec<(f64, f64)> {
    video.iter().filter(|v| **v >= piece.video_in && **v <= piece.video_out)
        .filter_map(|&v| nearest(song, piece.at(v)).filter(|(_, d)| *d <= within).map(|(q, _)| (v, q)))
        .collect()
}

/// The straight line `q = a + (v - v0) * c` through the pairs, least squares: (a, c).
fn fit(pairs: &[(f64, f64)], v0: f64) -> Option<(f64, f64)> {
    let n = pairs.len() as f64;
    if pairs.len() < 2 {
        return None;
    }
    let (mx, my) = pairs.iter().fold((0., 0.), |(x, y), (v, q)| (x + (v - v0) / n, y + q / n));
    let sxx: f64 = pairs.iter().map(|(v, _)| (v - v0 - mx).powi(2)).sum();
    if sxx < 1e-9 {
        return None;
    }
    let sxy: f64 = pairs.iter().map(|(v, q)| (v - v0 - mx) * (q - my)).sum();
    let c = sxy / sxx;
    (c > 0.).then_some((my - c * mx, c))
}

fn error_ms(pairs: &[(f64, f64)], at: impl Fn(f64) -> f64) -> f64 {
    let mut errors: Vec<f64> = pairs.iter().map(|(v, q)| (at(*v) - q).abs() * 1000.).collect();
    if errors.is_empty() {
        return f64::INFINITY;
    }
    crate::dsp::median(&mut errors)
}

/// The placement `guess` locked to the beats in one straight line: its phase found first (the
/// listening match can be off by part of a beat), then speed and start fitted as the pairing
/// tightens. None when too few beats pair up.
pub fn lock(video: &[f64], song: &[f64], guess: &Piece) -> Option<Locked> {
    let beat = period(song);
    if !(0.2..=2.).contains(&beat) || guess.speed <= 0. || guess.video_out <= guess.video_in {
        return None;
    }
    let inside = video.iter().filter(|v| **v >= guess.video_in && **v <= guess.video_out).count();
    // Phase: the shift within half a beat that pairs the most beats closely; the smallest wins a tie.
    let steps = 40;
    let (shift, _) = (-steps / 2..=steps / 2)
        .map(|k| k as f64 * beat / steps as f64)
        .map(|shift| {
            let moved = Piece { ref_at: guess.ref_at + shift, ..*guess };
            (shift, pairs(video, song, &moved, beat * 0.12).len())
        })
        .max_by(|a, b| a.1.cmp(&b.1).then(b.0.abs().total_cmp(&a.0.abs())))?;
    let mut piece = Piece { ref_at: guess.ref_at + shift, ..*guess };
    for within in [0.3, 0.2, 0.12] {
        let found = pairs(video, song, &piece, beat * within);
        if found.len() < MIN_PAIRS {
            return None;
        }
        let (a, c) = fit(&found, piece.video_in)?;
        piece.ref_at = a;
        piece.speed = 1. / c;
        if !(0.25..=4.).contains(&piece.speed) {
            return None;
        }
    }
    let found = pairs(video, song, &piece, beat * 0.12);
    if found.len() < MIN_PAIRS {
        return None;
    }
    Some(Locked { error_ms: error_ms(&found, |v| piece.at(v)), matched: found.len(), beats: inside, pieces: vec![piece] })
}

/// `locked` (one straight line) bent where the beats bend: pieces of PIECE_BEATS of the video's
/// beats, each starting where the one before ends (the video plays on, nothing skipped), each
/// paired from where the piece before was heading and given the speed that best keeps its own
/// beats on the song's. None when bending does not bring more beats onto the song's, or closer.
pub fn bend(video: &[f64], song: &[f64], locked: &Locked) -> Option<Locked> {
    let whole = *locked.pieces.first()?;
    let beat = period(song);
    let inside: Vec<f64> = video.iter().copied().filter(|v| *v >= whole.video_in && *v <= whole.video_out).collect();
    if inside.len() < PIECE_BEATS * 2 {
        return None;
    }
    let mut pieces: Vec<Piece> = vec![];
    let (mut v0, mut q0, mut speed) = (whole.video_in, whole.at(whole.video_in), whole.speed);
    let mut next = 0;
    while next < inside.len() {
        let mut to = next + PIECE_BEATS;
        // A short last piece goes with the one before it.
        if to + PIECE_BEATS / 2 >= inside.len() {
            to = inside.len();
        }
        let end = if to >= inside.len() { whole.video_out } else { inside[to] };
        if end <= v0 {
            break;
        }
        let mut piece = Piece { video_in: v0, video_out: end, ref_at: q0, speed };
        for within in [0.3, 0.15] {
            let found = pairs(video, song, &piece, beat * within);
            // Through its start point: c = Σ dv·dq / Σ dv².
            let (num, den) = found.iter().fold((0., 0.), |(n, d), (v, q)| (n + (v - v0) * (q - q0), d + (v - v0).powi(2)));
            if found.len() >= 4 && den > 1e-9 && num > 0. {
                piece.speed = (den / num).clamp(whole.speed * 0.8, whole.speed * 1.25);
            }
        }
        speed = piece.speed;
        pieces.push(piece);
        q0 = piece.at(end);
        v0 = end;
        next = to;
    }
    // Neighbours within a fifth of a percent of each other are one piece.
    let mut merged: Vec<Piece> = vec![];
    for piece in pieces {
        match merged.last_mut() {
            Some(prev) if (prev.speed / piece.speed - 1.).abs() < 0.002 => {
                let length = piece.video_out - prev.video_in;
                let span = piece.at(piece.video_out) - prev.ref_at;
                prev.video_out = piece.video_out;
                prev.speed = length / span;
            }
            _ => merged.push(piece),
        }
    }
    if merged.len() < 2 {
        return None;
    }
    let at = |v: f64| merged.iter().find(|p| v <= p.video_out).unwrap_or(merged.last().unwrap()).at(v);
    let tight: Vec<(f64, f64)> = inside.iter()
        .filter_map(|&v| nearest(song, at(v)).filter(|(_, d)| *d <= beat * 0.12).map(|(q, _)| (v, q)))
        .collect();
    let error = error_ms(&tight, at);
    // Worth it when clearly more beats land on the song's, or as many land clearly closer.
    let more = tight.len() as f64 > locked.matched as f64 * 1.1;
    let closer = tight.len() >= locked.matched && error < locked.error_ms * 0.7 && locked.error_ms - error > 5.;
    (more || closer).then(|| Locked { pieces: merged, error_ms: error, matched: tight.len(), beats: locked.beats })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Beats of a 160 BPM original from 0.2 s, for `seconds`.
    fn original(seconds: f64) -> Vec<f64> {
        (0..).map(|i| 0.2 + i as f64 * 60. / 160.).take_while(|t| *t < seconds).collect()
    }

    #[test]
    fn a_rough_melody_match_is_locked_onto_the_beats() {
        let video = original(90.);
        // The remix plays it at 145 BPM, the video's 20 s at the song's 37.379 s.
        let speed = 145. / 160.;
        let song: Vec<f64> = video.iter().map(|v| 37.379 + (v - 20.) / speed).filter(|t| *t >= 0.).collect();
        // The listening match: a slightly wrong speed and 90 ms late.
        let guess = Piece { video_in: 20., video_out: 78., ref_at: 37.379 + 0.09, speed: 0.9062 };
        let locked = lock(&video, &song, &guess).unwrap();
        let piece = locked.pieces[0];
        assert!((piece.speed - speed).abs() < 1e-4, "{}", piece.speed);
        assert!((piece.at(20.) - 37.379).abs() < 0.002, "{}", piece.at(20.));
        assert!(locked.error_ms < 2., "{}", locked.error_ms);
        assert_eq!(locked.matched, locked.beats);
    }

    #[test]
    fn a_remix_that_slows_down_is_followed_in_pieces() {
        let video = original(90.);
        // 145 BPM until the video's 50 s, then 140: one straight line cannot hold both.
        let map = |v: f64| if v < 50. { 30. + (v - 20.) * 160. / 145. / 1. } else { 30. + 30. * 160. / 145. + (v - 50.) * 160. / 140. };
        let song: Vec<f64> = video.iter().filter(|v| **v >= 20.).map(|v| map(*v)).collect();
        let guess = Piece { video_in: 20., video_out: 85., ref_at: 30., speed: 145. / 160. };
        let straight = lock(&video, &song, &guess).unwrap();
        let bent = bend(&video, &song, &straight).unwrap();
        assert!(bent.pieces.len() >= 2);
        assert!(bent.error_ms < straight.error_ms);
        assert!(bent.error_ms < 15., "{}", bent.error_ms);
        // The pieces follow each other in the video and in the song.
        for w in bent.pieces.windows(2) {
            assert!((w[0].video_out - w[1].video_in).abs() < 1e-9);
            assert!((w[0].at(w[0].video_out) - w[1].ref_at).abs() < 1e-9);
        }
    }

    #[test]
    fn unrelated_beats_do_not_lock() {
        let video = original(60.);
        let song: Vec<f64> = (0..100).map(|i| i as f64 * 0.37 + (i * 7 % 5) as f64 * 0.05).collect();
        let guess = Piece { video_in: 0., video_out: 60., ref_at: 0., speed: 1. };
        assert!(lock(&video, &song, &guess).is_none_or(|l| l.error_ms > 10.));
    }
}
