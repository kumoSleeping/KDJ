//! Editing a `.kdjv` 3 document (docs/kdjv.md, "格式 3"): free tracks. Each track is a picture
//! track or a sound track holding clips at times of their own; the first track is on top, and a
//! picture track covers the ones below it; every sound track is heard. Tracks can be added,
//! removed, moved and folded: a fold shows several tracks as one row and changes nothing in them,
//! so whatever is covered stays whole and comes back when the fold is opened.
//!
//! Within a track clips never overlap: one put, moved, lengthened or sped up over another cuts the
//! other back where it lands (a clip it covers whole goes, one it lands inside of is cut in two).
//! The editor's keys and the AI's tools run the same operations, one list at a time, on the JSON.
//! Format 2 (the lanes) and format 1 projects are read into this one before they are edited.
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Map, Value};

/// Rounding between seconds written by hand and seconds computed: closer than this is the same.
const EPS: f64 = 1e-3;
pub const FORMAT: u64 = 3;

/// One edit. Times are seconds of the project; `track` names a track by its id.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    /// A new document (replaces what was there).
    New {
        #[serde(default)]
        title: String,
        #[serde(default)]
        canvas: Option<Value>,
    },
    Title { title: String },
    /// A track of `kind` (`picture` or `sound`) at `index` (0 is the top), else below the last
    /// track of its kind (a picture track above the sound tracks).
    AddTrack {
        kind: String,
        #[serde(default)]
        index: Option<usize>,
        #[serde(default)]
        name: Option<String>,
    },
    /// A track and its clips out of the project.
    RemoveTrack { id: String },
    /// A track to another place in the order (0 is the top).
    MoveTrack { id: String, index: usize },
    /// A track's other fields: name, hidden (a picture track not shown), muted (not heard).
    SetTrack { id: String, fields: Map<String, Value> },
    /// A clip into `track`, else into a new track made at `new_track` (an index, as `add_track`),
    /// else into the first track of `kind` (one is made when there is none), starting at `at`, else
    /// after the last clip there. A video in a sound track is heard and not seen; a still has no
    /// sound and only goes into a picture track.
    Add {
        clip: Map<String, Value>,
        #[serde(default)]
        track: Option<String>,
        #[serde(default)]
        new_track: Option<usize>,
        #[serde(default)]
        kind: Option<String>,
        #[serde(default)]
        at: Option<f64>,
    },
    /// A clip to start at `at`, in its own track, in `track`, or in a new track made at
    /// `new_track`; it stays a clip of its kind of track (a picture clip never goes into a sound
    /// track, nor the other way).
    Move {
        id: String,
        at: f64,
        #[serde(default)]
        track: Option<String>,
        #[serde(default)]
        new_track: Option<usize>,
    },
    /// A clip out of its track; with `ripple`, what comes after it in that track closes up.
    Remove {
        id: String,
        #[serde(default)]
        ripple: bool,
    },
    /// Where in its source a clip starts (its end stays where it is in the project) or ends.
    Trim {
        id: String,
        #[serde(rename = "in", default)]
        from: Option<f64>,
        #[serde(default)]
        out: Option<f64>,
    },
    /// A clip cut in two at `at`; the second half gets a new id.
    Split { id: String, at: f64 },
    /// A clip's other fields: speed, volume, muted, x, y, scale, opacity, fill, crop, fade_in,
    /// fade_out (seconds of the project it fades in and out over).
    Set { id: String, fields: Map<String, Value> },
    /// Tracks next to each other, of one kind, shown as one row (`folds`); nothing in them changes.
    Fold { tracks: Vec<String> },
    /// A fold opened for good: its tracks are rows of their own again.
    Unfold { id: String },
    /// The whole document as it was (undo and redo): checked like any other result.
    Restore { document: Value },
    /// The markers of the ruler, all of them: `{"at": seconds, "name"?: text}`.
    Markers { markers: Vec<Value> },
    /// A title (字幕): its text drawn as a picture (`src`) over the project from `at` for `length`.
    AddTitle { title: Map<String, Value> },
    SetTitle { id: String, fields: Map<String, Value> },
    RemoveTitle { id: String },
}

const SETTABLE: &[&str] = &["speed", "volume", "muted", "x", "y", "scale", "opacity", "fill", "crop", "fade_in", "fade_out"];
const TRACK_FIELDS: &[&str] = &["name", "hidden", "muted"];
const STILLS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif", "bmp", "heic", "avif", "tif", "tiff"];

fn num(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn round(value: f64) -> f64 {
    (value * 1e6).round() / 1e6
}

fn id_of(value: &Value) -> &str {
    value.get("id").and_then(Value::as_str).unwrap_or_default()
}

fn is_still(src: &str) -> bool {
    let ext = std::path::Path::new(src).extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
    STILLS.contains(&ext.as_str())
}

/// How long a clip lasts in the project.
pub fn clip_length(clip: &Value) -> f64 {
    let speed = num(clip, "speed").unwrap_or(1.).max(1e-6);
    (num(clip, "out").unwrap_or(0.) - num(clip, "in").unwrap_or(0.)) / speed
}

fn clip_at(clip: &Value) -> f64 {
    num(clip, "at").unwrap_or(0.)
}

fn clip_end(clip: &Value) -> f64 {
    clip_at(clip) + clip_length(clip)
}

fn tracks_of(doc: &mut Value) -> Result<&mut Vec<Value>> {
    let object = doc.as_object_mut().context("工程不是 JSON 对象")?;
    object.entry("tracks").or_insert_with(|| json!([])).as_array_mut().context("tracks 不是数组")
}

fn clips_of(track: &mut Value) -> Result<&mut Vec<Value>> {
    let object = track.as_object_mut().context("轨道不是 JSON 对象")?;
    object.entry("clips").or_insert_with(|| json!([])).as_array_mut().context("clips 不是数组")
}

fn kind_of(track: &Value) -> &str {
    track.get("kind").and_then(Value::as_str).unwrap_or("picture")
}

fn check_kind(kind: &str) -> Result<()> {
    if kind != "picture" && kind != "sound" {
        bail!("轨道要是 picture（画面）或 sound（声音），不是「{kind}」")
    }
    Ok(())
}

fn track_index(doc: &mut Value, id: &str) -> Result<usize> {
    tracks_of(doc)?.iter().position(|t| id_of(t) == id).with_context(|| format!("没有 id 为「{id}」的轨道"))
}

/// Where the clip `id` is: its track and its place in that track.
fn find_clip(doc: &mut Value, id: &str) -> Result<(usize, usize)> {
    for (t, track) in tracks_of(doc)?.iter_mut().enumerate() {
        if let Some(c) = clips_of(track)?.iter().position(|c| id_of(c) == id) {
            return Ok((t, c));
        }
    }
    bail!("没有 id 为「{id}」的片段")
}

/// A clip id no clip of the document has: `base`, else `c1`, `c2`…
fn fresh_clip_id(doc: &Value, base: &str) -> String {
    let taken = |id: &str| doc["tracks"].as_array().into_iter().flatten()
        .flat_map(|t| t["clips"].as_array().into_iter().flatten())
        .any(|c| id_of(c) == id);
    if !base.is_empty() && !taken(base) {
        return base.to_string();
    }
    (1..).map(|n| format!("c{n}")).find(|id| !taken(id)).unwrap()
}

/// A new track: `v1`, `v2`… for pictures, `a1`, `a2`… for sound.
fn fresh_track(doc: &Value, kind: &str, name: Option<&str>) -> Value {
    let prefix = if kind == "sound" { "a" } else { "v" };
    let taken = |id: &str| doc["tracks"].as_array().into_iter().flatten().any(|t| id_of(t) == id);
    let id = (1..).map(|n| format!("{prefix}{n}")).find(|id| !taken(id)).unwrap();
    let mut track = json!({ "id": id, "kind": kind, "clips": [] });
    if let Some(name) = name.filter(|n| !n.trim().is_empty()) {
        track["name"] = json!(name.trim());
    }
    track
}

/// Where a new track of `kind` goes without an index: below the last track of its kind; the first
/// picture track at the top, the first sound track at the bottom.
fn default_index(doc: &mut Value, kind: &str) -> Result<usize> {
    let tracks = tracks_of(doc)?;
    Ok(match tracks.iter().rposition(|t| kind_of(t) == kind) {
        Some(last) => last + 1,
        None if kind == "picture" => 0,
        None => tracks.len(),
    })
}

/// Makes a track of `kind` at `index` (or the default place) and answers its place.
fn insert_track(doc: &mut Value, kind: &str, index: Option<usize>, name: Option<&str>) -> Result<usize> {
    check_kind(kind)?;
    let at = match index {
        Some(index) => index.min(tracks_of(doc)?.len()),
        None => default_index(doc, kind)?,
    };
    let track = fresh_track(doc, kind, name);
    tracks_of(doc)?.insert(at, track);
    Ok(at)
}

/// The part `from`–`to` of track `t` made free: the clips there are cut back to its edges, and
/// those inside it go. `keep` is left alone (the clip being placed).
fn clear(doc: &mut Value, t: usize, from: f64, to: f64, keep: Option<&str>) -> Result<()> {
    let mut halves = vec![];
    let clips = clips_of(&mut tracks_of(doc)?[t])?;
    let mut out = vec![];
    for clip in clips.drain(..) {
        let (start, end) = (clip_at(&clip), clip_end(&clip));
        if keep == Some(id_of(&clip)) || end <= from + EPS || start >= to - EPS {
            out.push(clip);
            continue;
        }
        let speed = num(&clip, "speed").unwrap_or(1.);
        let source = |at: f64| round(num(&clip, "in").unwrap_or(0.) + (at - start) * speed);
        if start >= from - EPS && end <= to + EPS {
            continue;
        }
        if start < from {
            let mut head = clip.clone();
            head["out"] = json!(source(from));
            if let Some(fade) = num(&head, "fade_out") {
                head["fade_out"] = json!(round(fade.min(from - start)));
            }
            out.push(head);
        }
        if end > to {
            let mut tail = clip.clone();
            tail["in"] = json!(source(to));
            tail["at"] = json!(round(to));
            if let Some(fade) = num(&tail, "fade_in") {
                tail["fade_in"] = json!(round(fade.min(end - to)));
            }
            // A clip cut in two keeps its id on the first half.
            if start < from {
                halves.push(out.len());
            }
            out.push(tail);
        }
    }
    *clips = out;
    for n in halves {
        let id = fresh_clip_id(doc, "");
        clips_of(&mut tracks_of(doc)?[t])?[n]["id"] = json!(id);
    }
    Ok(())
}

/// `clip` into track `t` where it says it starts, over what is there.
fn place(doc: &mut Value, t: usize, clip: Value) -> Result<()> {
    let (from, to) = (clip_at(&clip), clip_end(&clip));
    clear(doc, t, from, to, None)?;
    clips_of(&mut tracks_of(doc)?[t])?.push(clip);
    Ok(())
}

/// After each operation: clips in time order, fades no longer than their clips, folds only of
/// tracks that are still there and still more than one.
fn tidy(doc: &mut Value) -> Result<()> {
    for track in tracks_of(doc)?.iter_mut() {
        let clips = clips_of(track)?;
        for clip in clips.iter_mut() {
            let length = clip_length(clip);
            for key in ["fade_in", "fade_out"] {
                if let Some(fade) = num(clip, key) {
                    if fade <= EPS {
                        clip.as_object_mut().map(|o| o.remove(key));
                    } else if fade > length {
                        clip[key] = json!(round(length));
                    }
                }
            }
        }
        clips.sort_by(|a, b| clip_at(a).total_cmp(&clip_at(b)));
    }
    let ids: Vec<String> = tracks_of(doc)?.iter().map(|t| id_of(t).to_string()).collect();
    if let Some(folds) = doc.get_mut("folds").and_then(Value::as_array_mut) {
        for fold in folds.iter_mut() {
            if let Some(members) = fold.get_mut("tracks").and_then(Value::as_array_mut) {
                members.retain(|m| m.as_str().is_some_and(|m| ids.iter().any(|id| id == m)));
            }
        }
        folds.retain(|f| f["tracks"].as_array().is_some_and(|m| m.len() > 1));
        if folds.is_empty() {
            doc.as_object_mut().map(|o| o.remove("folds"));
        }
    }
    Ok(())
}

/// The document with `ops` applied in order; the first that cannot apply says why, and nothing of
/// the list is kept.
pub fn apply(document: &Value, ops: &[Op]) -> Result<Value> {
    let mut doc = document.clone();
    for (n, op) in ops.iter().enumerate() {
        apply_one(&mut doc, op).with_context(|| format!("第 {} 步（{}）", n + 1, op_name(op)))?;
        tidy(&mut doc)?;
    }
    Ok(doc)
}

fn op_name(op: &Op) -> &'static str {
    match op {
        Op::New { .. } => "new",
        Op::Title { .. } => "title",
        Op::AddTrack { .. } => "add_track",
        Op::RemoveTrack { .. } => "remove_track",
        Op::MoveTrack { .. } => "move_track",
        Op::SetTrack { .. } => "set_track",
        Op::Add { .. } => "add",
        Op::Move { .. } => "move",
        Op::Remove { .. } => "remove",
        Op::Trim { .. } => "trim",
        Op::Split { .. } => "split",
        Op::Set { .. } => "set",
        Op::Fold { .. } => "fold",
        Op::Unfold { .. } => "unfold",
        Op::Restore { .. } => "restore",
        Op::Markers { .. } => "markers",
        Op::AddTitle { .. } => "add_title",
        Op::SetTitle { .. } => "set_title",
        Op::RemoveTitle { .. } => "remove_title",
    }
}

/// The track a clip that is put or moved goes into.
fn target(doc: &mut Value, track: &Option<String>, new_track: Option<usize>, kind: &str) -> Result<usize> {
    match (track, new_track) {
        (Some(id), _) => track_index(doc, id),
        (None, Some(index)) => insert_track(doc, kind, Some(index), None),
        (None, None) => match tracks_of(doc)?.iter().position(|t| kind_of(t) == kind) {
            Some(t) => Ok(t),
            None => insert_track(doc, kind, None, None),
        },
    }
}

fn apply_one(doc: &mut Value, op: &Op) -> Result<()> {
    match op {
        Op::New { title, canvas } => {
            let mut fresh = json!({ "kdjv": FORMAT, "title": title, "tracks": [] });
            if let Some(canvas) = canvas {
                fresh["canvas"] = canvas.clone();
            }
            *doc = fresh;
        }
        Op::Title { title } => doc["title"] = json!(title),
        Op::AddTrack { kind, index, name } => {
            insert_track(doc, kind, *index, name.as_deref())?;
        }
        Op::RemoveTrack { id } => {
            let t = track_index(doc, id)?;
            tracks_of(doc)?.remove(t);
        }
        Op::MoveTrack { id, index } => {
            let t = track_index(doc, id)?;
            let tracks = tracks_of(doc)?;
            let track = tracks.remove(t);
            let to = (*index).min(tracks.len());
            tracks.insert(to, track);
        }
        Op::SetTrack { id, fields } => {
            if let Some(key) = fields.keys().find(|key| !TRACK_FIELDS.contains(&key.as_str())) {
                bail!("轨道不能这样改「{key}」：可以改的是 {}", TRACK_FIELDS.join("、"))
            }
            let t = track_index(doc, id)?;
            let track = &mut tracks_of(doc)?[t];
            for (key, value) in fields {
                if value.is_null() || value == &json!(false) || value == &json!("") {
                    track.as_object_mut().map(|o| o.remove(key));
                } else {
                    track[key] = value.clone();
                }
            }
        }
        Op::Add { clip, track, new_track, kind, at } => {
            let mut item = Value::Object(clip.clone());
            let src = item.get("src").and_then(Value::as_str).context("片段要有 src")?.to_string();
            if num(&item, "out").is_none() {
                bail!("片段要有 out")
            }
            if clip_length(&item) <= EPS || num(&item, "in").unwrap_or(0.) < 0. {
                bail!("片段长度要大于 0（out 要大于 in，in 不小于 0）")
            }
            let kind = match (track, kind) {
                (Some(id), _) => {
                    let t = track_index(doc, id)?;
                    kind_of(&tracks_of(doc)?[t]).to_string()
                }
                (None, Some(kind)) => kind.clone(),
                (None, None) => "picture".to_string(),
            };
            check_kind(&kind)?;
            if kind == "sound" && is_still(&src) {
                bail!("图片没有声音，只能放进画面轨")
            }
            let t = target(doc, track, *new_track, &kind)?;
            let wanted = id_of(&item).to_string();
            item["id"] = json!(fresh_clip_id(doc, &wanted));
            let start = match at {
                Some(at) => at.max(0.),
                None => tracks_of(doc)?[t]["clips"].as_array().into_iter().flatten().map(clip_end).fold(0., f64::max),
            };
            item["at"] = json!(round(start));
            place(doc, t, item)?;
        }
        Op::Move { id, at, track, new_track } => {
            let (from, c) = find_clip(doc, id)?;
            let kind = kind_of(&tracks_of(doc)?[from]).to_string();
            if let Some(other) = track {
                let to = track_index(doc, other)?;
                if kind_of(&tracks_of(doc)?[to]) != kind {
                    bail!("{}", if kind == "picture" { "画面片段不能放进声音轨" } else { "声音片段不能放进画面轨" })
                }
            }
            let mut clip = clips_of(&mut tracks_of(doc)?[from])?.remove(c);
            clip["at"] = json!(round(at.max(0.)));
            let t = match (track, new_track) {
                (None, None) => from,
                _ => target(doc, track, *new_track, &kind)?,
            };
            place(doc, t, clip)?;
        }
        Op::Remove { id, ripple } => {
            let (t, c) = find_clip(doc, id)?;
            let clips = clips_of(&mut tracks_of(doc)?[t])?;
            let gone = clips.remove(c);
            if *ripple {
                let (start, length) = (clip_at(&gone), clip_length(&gone));
                for clip in clips.iter_mut().filter(|clip| clip_at(clip) >= start - EPS) {
                    clip["at"] = json!(round((clip_at(clip) - length).max(0.)));
                }
            }
        }
        Op::Trim { id, from, out } => {
            let (t, c) = find_clip(doc, id)?;
            let clip = &mut clips_of(&mut tracks_of(doc)?[t])?[c];
            let end = clip_end(clip);
            if let Some(out) = out {
                clip["out"] = json!(round(*out));
            }
            if let Some(from) = from {
                clip["in"] = json!(round(*from));
                // The start moves with it: the end stays where it is in the project.
                let length = clip_length(clip);
                if end - length < -EPS {
                    bail!("这样剪，片段会开始在成片开头之前")
                }
                clip["at"] = json!(round((end - length).max(0.)));
            }
            if !(clip_length(clip) > EPS) || num(clip, "in").unwrap_or(0.) < 0. {
                bail!("in 要不小于 0、小于 out")
            }
            let (start, stop) = (clip_at(clip), clip_end(clip));
            clear(doc, t, start, stop, Some(id))?;
        }
        Op::Split { id, at } => {
            let (t, c) = find_clip(doc, id)?;
            let clip = clips_of(&mut tracks_of(doc)?[t])?[c].clone();
            let (start, end) = (clip_at(&clip), clip_end(&clip));
            if !(*at > start + EPS && *at < end - EPS) {
                bail!("{at:.3} 秒不在 {id}（{start:.3}–{end:.3} 秒）里面")
            }
            let speed = num(&clip, "speed").unwrap_or(1.);
            let cut = round(num(&clip, "in").unwrap_or(0.) + (at - start) * speed);
            let mut second = clip.clone();
            second["id"] = json!(fresh_clip_id(doc, ""));
            second["in"] = json!(cut);
            second["at"] = json!(round(*at));
            second.as_object_mut().map(|o| o.remove("fade_in"));
            let clips = clips_of(&mut tracks_of(doc)?[t])?;
            clips[c]["out"] = json!(cut);
            clips[c].as_object_mut().map(|o| o.remove("fade_out"));
            clips.push(second);
        }
        Op::Set { id, fields } => {
            if let Some(key) = fields.keys().find(|key| !SETTABLE.contains(&key.as_str())) {
                bail!("不能这样改「{key}」：可以改的是 {}", SETTABLE.join("、"))
            }
            if let Some(crop) = fields.get("crop") {
                super::lanes::check_crop(crop)?;
            }
            if let Some(speed) = fields.get("speed").and_then(Value::as_f64) {
                if !(0.5..=2.).contains(&speed) {
                    bail!("speed 要在 0.5–2 之间")
                }
            }
            let (t, c) = find_clip(doc, id)?;
            let clip = &mut clips_of(&mut tracks_of(doc)?[t])?[c];
            for (key, value) in fields {
                clip[key] = value.clone();
            }
            let (start, stop) = (clip_at(clip), clip_end(clip));
            clear(doc, t, start, stop, Some(id))?;
        }
        Op::Fold { tracks } => {
            if tracks.len() < 2 {
                bail!("合并要两条或更多轨道")
            }
            let mut places = vec![];
            for id in tracks {
                places.push(track_index(doc, id)?);
            }
            places.sort_unstable();
            places.dedup();
            if places.windows(2).any(|w| w[1] != w[0] + 1) {
                bail!("合并的轨道要挨在一起")
            }
            let all = tracks_of(doc)?;
            let kind = kind_of(&all[places[0]]).to_string();
            if places.iter().any(|&t| kind_of(&all[t]) != kind) {
                bail!("画面轨和声音轨不能合并在一起")
            }
            let members: Vec<Value> = places.iter().map(|&t| json!(id_of(&all[t]))).collect();
            let object = doc.as_object_mut().context("工程不是 JSON 对象")?;
            let folds = object.entry("folds").or_insert_with(|| json!([])).as_array_mut().context("folds 不是数组")?;
            // A track is in one fold at most: folding again takes it out of the one it was in.
            for fold in folds.iter_mut() {
                if let Some(old) = fold.get_mut("tracks").and_then(Value::as_array_mut) {
                    old.retain(|m| !members.contains(m));
                }
            }
            let taken = |id: &str| folds.iter().any(|f| id_of(f) == id);
            let id = (1..).map(|n| format!("f{n}")).find(|id| !taken(id)).unwrap();
            folds.push(json!({ "id": id, "tracks": members }));
        }
        Op::Unfold { id } => {
            let folds = doc.get_mut("folds").and_then(Value::as_array_mut).context("没有合并的轨道")?;
            let before = folds.len();
            folds.retain(|f| id_of(f) != id);
            if folds.len() == before {
                bail!("没有 id 为「{id}」的合并")
            }
        }
        Op::Restore { document } => {
            if document.get("kdjv").and_then(Value::as_u64) != Some(FORMAT) || !document["tracks"].is_array() {
                bail!("要还原的不是格式 3 的工程")
            }
            *doc = document.clone();
        }
        Op::Markers { markers } => super::lanes::apply_shared(doc, &super::lanes::Op::Markers { markers: markers.clone() })?,
        Op::AddTitle { title } => super::lanes::apply_shared(doc, &super::lanes::Op::AddTitle { title: title.clone() })?,
        Op::SetTitle { id, fields } => super::lanes::apply_shared(doc, &super::lanes::Op::SetTitle { id: id.clone(), fields: fields.clone() })?,
        Op::RemoveTitle { id } => super::lanes::apply_shared(doc, &super::lanes::Op::RemoveTitle { id: id.clone() })?,
    }
    Ok(())
}

/// Every clip brought within its file: an `out` past the end of what the file holds ends there
/// instead (the library's length is often the sound's, a tenth of a second longer than the
/// picture, or a guess from an MP3's bitrate). `length_of` answers a file's length by its name in
/// the document; None leaves the clip as it is. Answers whether anything changed.
pub fn fit_sources(doc: &mut Value, length_of: impl Fn(&str) -> Option<f64>) -> Result<bool> {
    let mut changed = false;
    for track in tracks_of(doc)?.iter_mut() {
        for clip in clips_of(track)?.iter_mut() {
            let Some(len) = clip["src"].as_str().and_then(&length_of) else { continue };
            let Some(out) = num(clip, "out") else { continue };
            if out > len + EPS && len > num(clip, "in").unwrap_or(0.) + EPS {
                clip["out"] = json!((len * 1000.).floor() / 1000.);
                changed = true;
            }
        }
    }
    if changed {
        tidy(doc)?;
    }
    Ok(changed)
}

/// Every file the document's clips name, once each.
pub fn sources(doc: &Value) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for clip in doc["tracks"].as_array().into_iter().flatten().flat_map(|t| t["clips"].as_array().into_iter().flatten()) {
        if let Some(src) = clip["src"].as_str() {
            if !out.iter().any(|s| s == src) {
                out.push(src.to_string());
            }
        }
    }
    out
}

/// Whether the document has no clip at all.
pub fn is_empty(doc: &Value) -> bool {
    sources(doc).is_empty()
}

/// The clips of the first sound track that has any: the songs whose bar lines the editor draws.
pub fn song_clips(doc: &Value) -> Vec<Value> {
    doc["tracks"].as_array().into_iter().flatten()
        .filter(|t| kind_of(t) == "sound")
        .map(|t| t["clips"].as_array().cloned().unwrap_or_default())
        .find(|clips| !clips.is_empty())
        .unwrap_or_default()
}

/// Where everything is, for whoever edits next: each track with its clips' places and lengths,
/// the folds, and the songs the bar lines come from.
pub fn layout(doc: &Value) -> Value {
    let tracks: Vec<Value> = doc["tracks"].as_array().into_iter().flatten().enumerate().map(|(index, track)| {
        let clips: Vec<Value> = track["clips"].as_array().into_iter().flatten().map(|clip| json!({
            "id": clip["id"], "src": clip["src"], "at": round(clip_at(clip)), "length": round(clip_length(clip)),
            "in": num(clip, "in").unwrap_or(0.), "out": num(clip, "out").unwrap_or(0.),
        })).collect();
        json!({ "index": index, "id": track["id"], "kind": kind_of(track), "clips": clips })
    }).collect();
    let end = doc["tracks"].as_array().into_iter().flatten()
        .flat_map(|t| t["clips"].as_array().into_iter().flatten())
        .map(clip_end)
        .chain(doc["titles"].as_array().into_iter().flatten().map(|t| num(t, "at").unwrap_or(0.) + num(t, "length").unwrap_or(0.)))
        .fold(0., f64::max);
    let songs: Vec<Value> = song_clips(doc).iter().enumerate().map(|(index, clip)| json!({
        "index": index, "at": round(clip_at(clip)), "length": round(clip_length(clip)), "src": clip["src"],
        "in": num(clip, "in").unwrap_or(0.), "speed": num(clip, "speed").unwrap_or(1.),
    })).collect();
    json!({ "duration": round(end), "tracks": tracks, "folds": doc.get("folds").cloned().unwrap_or(json!([])), "songs": songs })
}

/// A document of an earlier format as one of this format, keeping everything it says. Format 2:
/// the main lane is the first picture track (its black left out), the branches a picture track
/// above it with their fades, the songs a sound track, one after another. Format 1: its tracks,
/// each a picture track unless all it plays is sound. Anything else answers None.
pub fn from_earlier(doc: &Value) -> Option<Value> {
    let version = doc.get("kdjv").and_then(Value::as_u64)?;
    let mut out = Map::new();
    let known: &[&str] = match version {
        2 => &["kdjv", "main", "branches", "song", "songs"],
        1 => &["kdjv", "tracks"],
        _ => return None,
    };
    for (key, value) in doc.as_object()? {
        if !known.contains(&key.as_str()) {
            out.insert(key.clone(), value.clone());
        }
    }
    out.insert("kdjv".into(), json!(FORMAT));
    let mut fresh = Value::Object(out);
    let mut next = 0;
    let mut id = || { next += 1; format!("c{next}") };
    let mut tracks = vec![];
    if version == 2 {
        let mut main = vec![];
        let mut placed: Vec<(String, Value)> = vec![];
        let mut at = 0.;
        for item in doc["main"].as_array().into_iter().flatten() {
            if let Some(gap) = num(item, "gap") {
                at += gap;
                continue;
            }
            let mut clip = item.clone();
            if id_of(&clip).is_empty() {
                clip["id"] = json!(id());
            }
            clip["at"] = json!(round(at));
            at += clip_length(&clip);
            placed.push((id_of(&clip).to_string(), clip.clone()));
            main.push(clip);
        }
        let mut above = vec![];
        for b in doc["branches"].as_array().into_iter().flatten() {
            let Some((_, c)) = placed.iter().find(|(cid, _)| b["clip"].as_str() == Some(cid.as_str())) else { continue };
            let length = num(b, "length").unwrap_or(0.);
            let speed = num(c, "speed").unwrap_or(1.);
            let span = length * speed;
            let mut clip = c.clone();
            clip["id"] = json!(format!("b{}", above.len() + 1));
            let fade = b.get("fade").and_then(Value::as_bool).unwrap_or(true);
            if b["side"] == json!("in") {
                let from = num(c, "in").unwrap_or(0.);
                if from < span - EPS || clip_at(c) < length - EPS {
                    continue;
                }
                clip["at"] = json!(round(clip_at(c) - length));
                clip["in"] = json!(round(from - span));
                clip["out"] = json!(round(from));
                if fade { clip["fade_in"] = json!(length); }
            } else {
                let out = num(c, "out").unwrap_or(0.);
                clip["at"] = json!(round(clip_end(c)));
                clip["in"] = json!(round(out));
                clip["out"] = json!(round(out + span));
                if fade { clip["fade_out"] = json!(length); }
            }
            clip["muted"] = json!(true);
            clip["opacity"] = json!(num(b, "opacity").unwrap_or(1.));
            above.push(clip);
        }
        if !above.is_empty() {
            tracks.push(json!({ "id": "v2", "kind": "picture", "clips": above }));
        }
        tracks.push(json!({ "id": "v1", "kind": "picture", "clips": main }));
        let songs = super::lanes::songs_of(doc);
        if !songs.is_empty() {
            let mut at = 0.;
            let mut clips = vec![];
            for (n, song) in songs.into_iter().enumerate() {
                let mut clip = song.clone();
                clip["id"] = json!(format!("s{}", n + 1));
                clip["at"] = json!(round(at));
                at += clip_length(&clip);
                clips.push(clip);
            }
            tracks.push(json!({ "id": "a1", "kind": "sound", "clips": clips }));
        }
    } else {
        let (mut pictures, mut sounds) = (0, 0);
        for track in doc["tracks"].as_array().into_iter().flatten() {
            let clips: Vec<Value> = track["clips"].as_array().into_iter().flatten().map(|clip| {
                let mut clip = clip.clone();
                clip["id"] = json!(id());
                clip
            }).collect();
            // A track that is only sound files is a sound track.
            let sound = !clips.is_empty() && clips.iter().all(|c| {
                let ext = std::path::Path::new(c["src"].as_str().unwrap_or_default()).extension()
                    .and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
                kdj_providers::tags::AUDIO_EXTENSIONS.contains(&ext.as_str())
            });
            let track_id = if sound { sounds += 1; format!("a{sounds}") } else { pictures += 1; format!("v{pictures}") };
            let kind = if sound { "sound" } else { "picture" };
            tracks.push(json!({ "id": track_id, "kind": kind, "clips": clips }));
        }
    }
    fresh["tracks"] = Value::Array(tracks);
    tidy(&mut fresh).ok()?;
    Some(fresh)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ops(text: &str) -> Vec<Op> {
        serde_json::from_str(text).unwrap()
    }

    /// Each track as its id and its clips as (id, at, length).
    fn shape(doc: &Value) -> Vec<(String, Vec<(String, f64, f64)>)> {
        layout(doc)["tracks"].as_array().unwrap().iter().map(|t| (
            t["id"].as_str().unwrap().to_string(),
            t["clips"].as_array().unwrap().iter()
                .map(|c| (c["id"].as_str().unwrap().to_string(), c["at"].as_f64().unwrap(), c["length"].as_f64().unwrap()))
                .collect(),
        )).collect()
    }

    fn two() -> Value {
        apply(&json!({}), &ops(r#"[
            {"op":"new","title":"t"},
            {"op":"add","clip":{"src":"/a.mp4","in":0,"out":10}},
            {"op":"add","clip":{"src":"/b.mp4","in":0,"out":5}},
            {"op":"add","clip":{"src":"/s.m4a","in":0,"out":60},"kind":"sound"}
        ]"#)).unwrap()
    }

    #[test]
    fn clips_go_after_the_last_in_their_track_and_sound_goes_below() {
        assert_eq!(shape(&two()), vec![
            ("v1".into(), vec![("c1".into(), 0., 10.), ("c2".into(), 10., 5.)]),
            ("a1".into(), vec![("c3".into(), 0., 60.)]),
        ]);
        assert_eq!(layout(&two())["duration"], json!(60.));
        assert_eq!(layout(&two())["songs"][0]["src"], json!("/s.m4a"));
    }

    #[test]
    fn a_clip_dragged_past_its_track_makes_a_new_one_above_or_below() {
        let below = apply(&two(), &ops(r#"[{"op":"move","id":"c2","at":3,"new_track":1}]"#)).unwrap();
        assert_eq!(shape(&below)[..2], [
            ("v1".into(), vec![("c1".into(), 0., 10.)]),
            ("v2".into(), vec![("c2".into(), 3., 5.)]),
        ]);
        let above = apply(&two(), &ops(r#"[{"op":"move","id":"c2","at":0,"new_track":0}]"#)).unwrap();
        assert_eq!(shape(&above)[0], ("v2".into(), vec![("c2".into(), 0., 5.)]));
        let error = apply(&two(), &ops(r#"[{"op":"move","id":"c2","at":0,"track":"a1"}]"#)).unwrap_err();
        assert!(format!("{error:#}").contains("画面片段不能放进声音轨"), "{error:#}");
    }

    #[test]
    fn what_lands_on_a_clip_cuts_it_back_and_one_inside_it_cuts_it_in_two() {
        let over = apply(&two(), &ops(r#"[{"op":"add","clip":{"src":"/c.mp4","out":2},"track":"v1","at":4}]"#)).unwrap();
        let v1 = &shape(&over)[0].1;
        assert_eq!(v1[0], ("c1".into(), 0., 4.));
        assert_eq!(v1[1], ("c4".into(), 4., 2.));
        assert_eq!((v1[2].1, v1[2].2), (6., 4.), "the rest of c1 under a new id");
        assert_eq!(over["tracks"][0]["clips"][2]["in"], json!(6.0));
        let longer = apply(&two(), &ops(r#"[{"op":"set","id":"c1","fields":{"speed":0.5}}]"#)).unwrap();
        assert_eq!(shape(&longer)[0].1, vec![("c1".into(), 0., 20.)], "c2 covered whole goes");
    }

    #[test]
    fn a_trim_at_the_start_keeps_the_end_and_a_ripple_closes_up() {
        let trimmed = apply(&two(), &ops(r#"[{"op":"trim","id":"c1","in":4}]"#)).unwrap();
        assert_eq!(shape(&trimmed)[0].1[0], ("c1".into(), 4., 6.));
        let rippled = apply(&two(), &ops(r#"[{"op":"remove","id":"c1","ripple":true}]"#)).unwrap();
        assert_eq!(shape(&rippled)[0].1, vec![("c2".into(), 0., 5.)]);
        let split = apply(&two(), &ops(r#"[{"op":"split","id":"c1","at":3}]"#)).unwrap();
        assert_eq!(shape(&split)[0].1[..2], [("c1".into(), 0., 3.), ("c4".into(), 3., 7.)]);
    }

    #[test]
    fn folds_are_of_tracks_side_by_side_of_one_kind_and_change_nothing_in_them() {
        let doc = apply(&two(), &ops(r#"[{"op":"add_track","kind":"picture"}]"#)).unwrap();
        let folded = apply(&doc, &ops(r#"[{"op":"fold","tracks":["v1","v2"]}]"#)).unwrap();
        assert_eq!(folded["folds"], json!([{ "id": "f1", "tracks": ["v1", "v2"] }]));
        assert_eq!(folded["tracks"], doc["tracks"]);
        assert!(apply(&doc, &ops(r#"[{"op":"fold","tracks":["v1","a1"]}]"#)).is_err());
        let open = apply(&folded, &ops(r#"[{"op":"unfold","id":"f1"}]"#)).unwrap();
        assert!(open.get("folds").is_none());
        let gone = apply(&folded, &ops(r#"[{"op":"remove_track","id":"v2"}]"#)).unwrap();
        assert!(gone.get("folds").is_none(), "a fold of one track is no fold");
    }

    #[test]
    fn a_lane_document_becomes_tracks_keeping_its_branches_songs_and_titles() {
        let lanes = json!({
            "kdjv": 2, "title": "VJ", "x-keep": 1,
            "main": [{ "id": "a", "src": "/a.mp4", "in": 10, "out": 20 }, { "gap": 2 }, { "id": "b", "src": "/b.mp4", "in": 5, "out": 9 }],
            "branches": [{ "clip": "a", "side": "out", "length": 1 }, { "clip": "b", "side": "in", "length": 1, "fade": false, "opacity": 0.5 }],
            "song": { "src": "/s.m4a", "in": 0, "out": 30 },
            "titles": [{ "id": "t1", "text": "x", "src": "/t.png", "at": 1, "length": 2 }],
        });
        let doc = from_earlier(&lanes).unwrap();
        assert_eq!(doc["kdjv"], json!(3));
        assert_eq!(doc["x-keep"], json!(1));
        assert_eq!(doc["titles"], lanes["titles"]);
        assert_eq!(shape(&doc), vec![
            ("v2".into(), vec![("b1".into(), 10., 1.), ("b2".into(), 11., 1.)]),
            ("v1".into(), vec![("a".into(), 0., 10.), ("b".into(), 12., 4.)]),
            ("a1".into(), vec![("s1".into(), 0., 30.)]),
        ]);
        assert_eq!(doc["tracks"][0]["clips"][0]["fade_out"], json!(1.0));
        assert_eq!(doc["tracks"][0]["clips"][1]["opacity"], json!(0.5));
        assert!(doc["tracks"][0]["clips"][1].get("fade_in").is_none());
    }

    #[test]
    fn an_out_past_the_end_of_its_file_ends_there() {
        let mut doc = two();
        assert!(fit_sources(&mut doc, |src| (src == "/a.mp4").then_some(9.89)).unwrap());
        assert_eq!(shape(&doc)[0].1[0], ("c1".into(), 0., 9.89));
        assert!(!fit_sources(&mut doc, |src| (src == "/a.mp4").then_some(9.89)).unwrap());
    }
}
