//! Editing a `.kdjv` 2 document (docs/kdjv.md, "格式 2"): the operations the editor's keys and
//! the AI's tools both run, one list at a time, on the document's JSON. Pure: the route reads
//! the file, applies the operations here, checks the result as playing it would and writes it.
//!
//! With a song (a VJ) the song is the clock: a clip that grows, shrinks or goes leaves the clips
//! after it where they were, the gap after it taking the difference, so what was put in sync stays
//! in sync. Without one the lane closes up like any edit list. Fields this build does not know are
//! kept as they are.
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Map, Value};

/// Rounding between seconds written by hand and seconds computed: closer than this is the same.
const EPS: f64 = 1e-3;

/// One edit. Times are seconds of the project.
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    /// A new document (replaces what was there): its title and, for a VJ, its song.
    New {
        #[serde(default)]
        title: String,
        #[serde(default)]
        song: Option<Value>,
        #[serde(default)]
        canvas: Option<Value>,
    },
    Title { title: String },
    /// A clip into the main lane: starting at `at` (into the black there, or after the end), else at
    /// `index`, else at the end. Without an `id` it gets one. With `over` (and `at`) it goes in over
    /// what is there: the clips it covers are cut back where it starts and ends.
    Add {
        clip: Map<String, Value>,
        #[serde(default)]
        at: Option<f64>,
        #[serde(default)]
        index: Option<usize>,
        #[serde(default)]
        over: bool,
    },
    /// A clip out of the main lane, with its branches.
    Remove { id: String },
    /// A clip to another place in the order of the main lane.
    Move { id: String, index: usize },
    /// Where in its source a clip starts or ends.
    Trim {
        id: String,
        #[serde(rename = "in", default)]
        from: Option<f64>,
        #[serde(default)]
        out: Option<f64>,
    },
    /// A clip cut in two at `at`; the second half gets a new id and the clip's `out` branch.
    Split { id: String, at: f64 },
    /// A clip's other fields: speed, volume, muted, x, y, scale, opacity, fill.
    Set { id: String, fields: Map<String, Value> },
    /// The black at `main[index]` made `length` long (0 takes it out); before a clip, a new one.
    Gap { index: usize, length: f64 },
    /// A branch of a clip onto the lane above (replacing one on the same side).
    Branch {
        clip: String,
        side: String,
        length: f64,
        #[serde(default)]
        opacity: Option<f64>,
        #[serde(default)]
        fade: Option<bool>,
    },
    Unbranch { clip: String, side: String },
    /// A song into the song lane at `index` (before the song there), else after the last. The songs
    /// play one after another; together they are the VJ's length and clock.
    AddSong {
        song: Map<String, Value>,
        #[serde(default)]
        index: Option<usize>,
    },
    /// The song at `index` out of the song lane.
    RemoveSong { index: usize },
    /// The song at `from` to the place `to` in the order of the song lane.
    MoveSong { from: usize, to: usize },
    /// A song's other fields: volume.
    SetSong { index: usize, fields: Map<String, Value> },
    /// A clip of a VJ to start at `at`, into the black there (with `over`, over what is there, as
    /// `add` does); it keeps its id and branches.
    MoveTo {
        id: String,
        at: f64,
        #[serde(default)]
        over: bool,
    },
    /// The whole document as it was (undo and redo): checked like any other result.
    Restore { document: Value },
    /// The markers of the ruler, all of them: `{"at": seconds, "name"?: text}`.
    Markers { markers: Vec<Value> },
    /// A title (字幕): its text drawn as a picture (`src`) over the project from `at` for `length`.
    AddTitle { title: Map<String, Value> },
    /// A title's other fields: text, src, at, length, size, color, outline, y.
    SetTitle { id: String, fields: Map<String, Value> },
    RemoveTitle { id: String },
}

const TITLE_FIELDS: &[&str] = &["text", "src", "at", "length", "size", "color", "outline", "y"];

fn titles_of(doc: &mut Value) -> Result<&mut Vec<Value>> {
    let object = doc.as_object_mut().context("工程不是 JSON 对象")?;
    object.entry("titles").or_insert_with(|| json!([])).as_array_mut().context("titles 不是数组")
}

/// A title's fields must make sense: some text, a picture of it, a place in the project.
fn check_title(title: &Value) -> Result<()> {
    if title.get("text").and_then(Value::as_str).is_none_or(|text| text.trim().is_empty()) {
        bail!("字幕要有文字")
    }
    if title.get("src").and_then(Value::as_str).is_none() {
        bail!("字幕要有画好的图（src）")
    }
    if !num(title, "at").is_some_and(|at| at >= 0.) || !num(title, "length").is_some_and(|length| length > EPS) {
        bail!("字幕要有 at（≥ 0）和 length（> 0）")
    }
    Ok(())
}

/// The songs of the song lane in order: `songs`, or the one `song` a project of one song has.
pub fn songs_of(doc: &Value) -> Vec<Value> {
    match (doc.get("songs").and_then(Value::as_array), doc.get("song")) {
        (Some(songs), _) => songs.clone(),
        (None, Some(song)) if song.is_object() => vec![song.clone()],
        _ => vec![],
    }
}

/// Writes the song lane back: one song as `song` (as projects of one song have always been
/// written, so builds that know only that keep reading them), several as `songs`.
fn put_songs(doc: &mut Value, songs: Vec<Value>) -> Result<()> {
    let object = doc.as_object_mut().context("工程不是 JSON 对象")?;
    object.remove("song");
    object.remove("songs");
    match songs.len() {
        0 => {}
        1 => { object.insert("song".into(), songs.into_iter().next().unwrap()); }
        _ => { object.insert("songs".into(), Value::Array(songs)); }
    }
    Ok(())
}

/// How long a song of the song lane plays.
fn song_length(song: &Value) -> f64 {
    (num(song, "out").unwrap_or(0.) - num(song, "in").unwrap_or(0.)).max(0.)
}

const SETTABLE: &[&str] = &["speed", "volume", "muted", "x", "y", "scale", "opacity", "fill", "crop"];

/// A crop is the fractions taken off left, top, right and bottom; some picture has to stay.
fn check_crop(value: &Value) -> Result<()> {
    let sides: Vec<f64> = value.as_array().map(|a| a.iter().filter_map(Value::as_f64).collect()).unwrap_or_default();
    if sides.len() != 4 || sides.iter().any(|v| !(0. ..=0.9).contains(v)) || sides[0] + sides[2] > 0.9 || sides[1] + sides[3] > 0.9 {
        bail!("crop 是 [左, 上, 右, 下] 四个 0–0.9 的比例，左右、上下各加起来不超过 0.9")
    }
    Ok(())
}

fn num(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

/// How long a stretch of the main lane lasts.
fn length(item: &Value) -> f64 {
    if let Some(gap) = num(item, "gap") {
        return gap;
    }
    let speed = num(item, "speed").unwrap_or(1.);
    (num(item, "out").unwrap_or(0.) - num(item, "in").unwrap_or(0.)) / speed.max(1e-6)
}

fn is_gap(item: &Value) -> bool {
    item.get("gap").is_some()
}

fn main_of(doc: &mut Value) -> Result<&mut Vec<Value>> {
    let object = doc.as_object_mut().context("工程不是 JSON 对象")?;
    let main = object.entry("main").or_insert_with(|| json!([]));
    main.as_array_mut().context("main 不是数组")
}

fn starts(main: &[Value]) -> Vec<f64> {
    let mut at = 0.;
    main.iter().map(|item| { let start = at; at += length(item); start }).collect()
}

fn index_of(main: &[Value], id: &str) -> Result<usize> {
    main.iter().position(|item| item.get("id").and_then(Value::as_str) == Some(id))
        .with_context(|| format!("主线上没有 id 为「{id}」的片段"))
}

fn fresh_id(main: &[Value], base: &str) -> String {
    let taken = |id: &str| main.iter().any(|item| item.get("id").and_then(Value::as_str) == Some(id));
    (1..).map(|n| if base.is_empty() { format!("c{n}") } else if n == 1 { base.to_string() } else { format!("{base}-{n}") })
        .find(|id| !taken(id))
        .unwrap()
}

/// Black that touches black becomes one stretch; black of no length goes.
fn tidy(main: &mut Vec<Value>) {
    let mut out: Vec<Value> = vec![];
    for item in main.drain(..) {
        if is_gap(&item) {
            let gap = length(&item);
            if gap <= EPS {
                continue;
            }
            if let Some(last) = out.last_mut().filter(|last| is_gap(last)) {
                let sum = length(last) + gap;
                last["gap"] = json!(round(sum));
                continue;
            }
        }
        out.push(item);
    }
    *main = out;
}

fn round(value: f64) -> f64 {
    (value * 1e6).round() / 1e6
}

/// After `main[i]` grew by `delta` seconds: in a VJ the stretch after it takes the difference, so
/// what follows stays where it was; black can give, a clip cannot.
fn hold_after(main: &mut Vec<Value>, i: usize, delta: f64) -> Result<()> {
    if delta.abs() <= EPS || i + 1 >= main.len() {
        return Ok(());
    }
    if is_gap(&main[i + 1]) {
        let rest = length(&main[i + 1]) - delta;
        if rest < -EPS {
            bail!("main[{i}] 变长了 {delta:.3} 秒，会盖住后面对好的片段（后面的空档只有 {:.3} 秒）", length(&main[i + 1]))
        }
        main[i + 1]["gap"] = json!(round(rest.max(0.)));
    } else if delta > 0. {
        bail!("main[{i}] 变长了 {delta:.3} 秒，会盖住紧接着的 main[{}]", i + 1)
    } else {
        main.insert(i + 1, json!({ "gap": round(-delta) }));
    }
    Ok(())
}

/// `item` into the main lane starting at `at`: into the black there, or after the end.
fn place_at(main: &mut Vec<Value>, item: Value, at: f64) -> Result<()> {
    let span = length(&item);
    let begins = starts(main);
    let end = begins.last().map_or(0., |s| s + length(main.last().unwrap()));
    if at >= end - EPS {
        if at - end > EPS {
            main.push(json!({ "gap": round(at - end) }));
        }
        main.push(item);
        return Ok(());
    }
    let k = (0..main.len()).find(|&k| begins[k] <= at + EPS && at < begins[k] + length(&main[k]) - EPS)
        .context("放的位置不在成片里")?;
    if !is_gap(&main[k]) {
        bail!("{at:.3} 秒处是 main[{k}]，只能放进黑的地方")
    }
    let (from, gap) = (begins[k], length(&main[k]));
    // The black at the end runs on as far as the clip needs.
    if k + 1 == main.len() && at + span > from + gap {
        main.truncate(k);
        if at - from > EPS {
            main.push(json!({ "gap": round(at - from) }));
        }
        main.push(item);
        return Ok(());
    }
    if at + span > from + gap + EPS {
        bail!("放在 {at:.3} 秒长 {span:.3} 秒，会盖住 main[{}]（这里的黑只到 {:.3} 秒）", k + 1, from + gap)
    }
    let mut stretch = vec![];
    if at - from > EPS {
        stretch.push(json!({ "gap": round(at - from) }));
    }
    stretch.push(item);
    if from + gap - at - span > EPS {
        stretch.push(json!({ "gap": round(from + gap - at - span) }));
    }
    main.splice(k..k + 1, stretch);
    Ok(())
}

/// Cuts the clip at `main[k]` in two `at` seconds of the project: the second half gets a new id and
/// the clip's `out` branch (the end is now the second half's). Answers the second half's id.
fn cut_clip(doc: &mut Value, k: usize, at: f64) -> Result<String> {
    let main = main_of(doc)?;
    let id = main[k].get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    let start = starts(main)[k];
    let speed = num(&main[k], "speed").unwrap_or(1.);
    let cut = round(num(&main[k], "in").unwrap_or(0.) + (at - start) * speed);
    let mut second = main[k].clone();
    main[k]["out"] = json!(cut);
    second["in"] = json!(cut);
    let next = fresh_id(main, &id);
    second["id"] = json!(next.clone());
    main.insert(k + 1, second);
    if let Some(branches) = doc.get_mut("branches").and_then(Value::as_array_mut) {
        for b in branches.iter_mut() {
            if b["clip"] == json!(id) && b["side"] == json!("out") {
                b["clip"] = json!(next.clone());
            }
        }
    }
    Ok(next)
}

/// Makes the main lane change at `t`: a clip or black running across it is cut in two there. Past
/// the end, black runs up to it. Answers the index of the stretch starting at `t` (the length of the
/// lane, at its end).
fn split_at(doc: &mut Value, t: f64) -> Result<usize> {
    let main = main_of(doc)?;
    let begins = starts(main);
    let end = begins.last().map_or(0., |s| s + length(main.last().unwrap()));
    if t >= end - EPS {
        if t - end > EPS {
            main.push(json!({ "gap": round(t - end) }));
        }
        return Ok(main.len());
    }
    let k = (0..main.len()).rev().find(|&k| begins[k] <= t + EPS).unwrap_or(0);
    if (t - begins[k]).abs() <= EPS {
        return Ok(k);
    }
    if is_gap(&main[k]) {
        let whole = length(&main[k]);
        main[k]["gap"] = json!(round(t - begins[k]));
        main.insert(k + 1, json!({ "gap": round(begins[k] + whole - t) }));
        return Ok(k + 1);
    }
    cut_clip(doc, k, t)?;
    Ok(k + 1)
}

/// The stretch `from`–`to` of the main lane made black: what covers it is cut back to its edges.
fn clear(doc: &mut Value, from: f64, to: f64) -> Result<()> {
    // The far edge first: what is left after it keeps the name the clip's next half has always got.
    let j = split_at(doc, to)?;
    let before = main_of(doc)?.len();
    let i = split_at(doc, from)?;
    let j = j + (main_of(doc)?.len() - before);
    main_of(doc)?.splice(i..j, [json!({ "gap": round(to - from) })]);
    Ok(())
}

/// The main lane cut into the stretches of the songs `bounds` (each song's start, then the end of
/// the last): what plays over each song. What runs past the last song stays with it.
fn song_chunks(doc: &mut Value, bounds: &[f64]) -> Result<Vec<Vec<Value>>> {
    let cuts: Vec<f64> = bounds[1..bounds.len().saturating_sub(1)].to_vec();
    for t in &cuts {
        split_at(doc, *t)?;
    }
    let main = main_of(doc)?.clone();
    let begins = starts(&main);
    let mut chunks = vec![vec![]; bounds.len().saturating_sub(1).max(1)];
    for (item, at) in main.into_iter().zip(begins) {
        let n = cuts.iter().filter(|&&t| at >= t - EPS).count().min(chunks.len() - 1);
        chunks[n].push(item);
    }
    Ok(chunks)
}

/// The song lane's starts, then the end of its last song.
fn song_bounds(songs: &[Value]) -> Vec<f64> {
    let mut at = 0.;
    let mut out = vec![0.];
    for song in songs {
        at += song_length(song);
        out.push(round(at));
    }
    out
}

/// The main lane put back together from the songs' stretches, each padded with black to its song's
/// length (but the last), and the times of titles and markers moved as `place` says: from a time of
/// the old project to the new one, or None for what went.
fn rejoin(doc: &mut Value, chunks: Vec<(Vec<Value>, f64)>, place: impl Fn(f64) -> Option<f64>) -> Result<()> {
    let count = chunks.len();
    let mut main = vec![];
    for (n, (chunk, span)) in chunks.into_iter().enumerate() {
        let filled: f64 = chunk.iter().map(length).sum();
        main.extend(chunk);
        if n + 1 < count && span - filled > EPS {
            main.push(json!({ "gap": round(span - filled) }));
        }
    }
    while main.last().is_some_and(is_gap) {
        main.pop();
    }
    *main_of(doc)? = main;
    for key in ["titles", "markers"] {
        if let Some(list) = doc.get_mut(key).and_then(Value::as_array_mut) {
            list.retain_mut(|item| match num(item, "at").and_then(&place) {
                Some(at) => { item["at"] = json!(round(at)); true }
                None => false,
            });
            list.sort_by(|a, b| num(a, "at").unwrap_or(0.).total_cmp(&num(b, "at").unwrap_or(0.)));
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
        tidy(main_of(&mut doc)?);
        drop_orphans(&mut doc);
    }
    Ok(doc)
}

fn op_name(op: &Op) -> &'static str {
    match op {
        Op::New { .. } => "new",
        Op::Title { .. } => "title",
        Op::Add { .. } => "add",
        Op::Remove { .. } => "remove",
        Op::Move { .. } => "move",
        Op::Trim { .. } => "trim",
        Op::Split { .. } => "split",
        Op::Set { .. } => "set",
        Op::Gap { .. } => "gap",
        Op::Branch { .. } => "branch",
        Op::Unbranch { .. } => "unbranch",
        Op::AddSong { .. } => "add_song",
        Op::RemoveSong { .. } => "remove_song",
        Op::MoveSong { .. } => "move_song",
        Op::SetSong { .. } => "set_song",
        Op::MoveTo { .. } => "move_to",
        Op::Restore { .. } => "restore",
        Op::Markers { .. } => "markers",
        Op::AddTitle { .. } => "add_title",
        Op::SetTitle { .. } => "set_title",
        Op::RemoveTitle { .. } => "remove_title",
    }
}

/// Branches of clips that are gone go with them.
fn drop_orphans(doc: &mut Value) {
    let ids: Vec<String> = doc["main"].as_array().into_iter().flatten()
        .filter_map(|item| item.get("id").and_then(Value::as_str).map(str::to_string)).collect();
    if let Some(branches) = doc.get_mut("branches").and_then(Value::as_array_mut) {
        branches.retain(|b| b.get("clip").and_then(Value::as_str).is_some_and(|clip| ids.iter().any(|id| id == clip)));
    }
}

fn apply_one(doc: &mut Value, op: &Op) -> Result<()> {
    let vj = !songs_of(doc).is_empty();
    match op {
        Op::New { title, song, canvas } => {
            let mut fresh = json!({ "kdjv": 2, "title": title, "main": [], "branches": [] });
            if let Some(song) = song {
                fresh["song"] = song.clone();
            }
            if let Some(canvas) = canvas {
                fresh["canvas"] = canvas.clone();
            }
            *doc = fresh;
        }
        Op::Title { title } => doc["title"] = json!(title),
        Op::Add { clip, at, index, over } => {
            let mut item = Value::Object(clip.clone());
            if item.get("src").and_then(Value::as_str).is_none() || num(&item, "out").is_none() {
                bail!("片段要有 src 和 out")
            }
            let main = main_of(doc)?;
            let wanted = item.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
            if !wanted.is_empty() && main.iter().any(|other| other.get("id").and_then(Value::as_str) == Some(&wanted)) {
                bail!("id「{wanted}」已经有了")
            }
            item["id"] = json!(fresh_id(main, &wanted));
            let span = length(&item);
            if !(span > EPS) {
                bail!("片段长度要大于 0（out 要大于 in）")
            }
            if let (Some(at), true) = (at, over) {
                let at = at.max(0.);
                clear(doc, at, at + span)?;
                let main = main_of(doc)?;
                tidy(main);
                return place_at(main, item, at);
            }
            let main = main_of(doc)?;
            match (at, index) {
                (Some(at), _) => place_at(main, item, *at)?,
                (None, Some(index)) => {
                    if *index > main.len() {
                        bail!("index {index} 超出主线（共 {} 段）", main.len())
                    }
                    main.insert(*index, item);
                }
                (None, None) => main.push(item),
            }
        }
        Op::Remove { id } => {
            let main = main_of(doc)?;
            let i = index_of(main, id)?;
            if vj {
                let span = length(&main[i]);
                main[i] = json!({ "gap": round(span) });
            } else {
                main.remove(i);
            }
        }
        Op::Move { id, index } => {
            let main = main_of(doc)?;
            let i = index_of(main, id)?;
            if *index >= main.len() {
                bail!("index {index} 超出主线（共 {} 段）", main.len())
            }
            let item = main.remove(i);
            main.insert(*index, item);
        }
        Op::Trim { id, from, out } => {
            let main = main_of(doc)?;
            let i = index_of(main, id)?;
            let before = length(&main[i]);
            if let Some(from) = from {
                main[i]["in"] = json!(from);
            }
            if let Some(out) = out {
                main[i]["out"] = json!(out);
            }
            if !(length(&main[i]) > EPS) || num(&main[i], "in").unwrap_or(0.) < 0. {
                bail!("in 要不小于 0、小于 out")
            }
            if vj {
                let delta = length(&main[i]) - before;
                hold_after(main, i, delta)?;
            }
        }
        Op::Split { id, at } => {
            let main = main_of(doc)?;
            let i = index_of(main, id)?;
            let start = starts(main)[i];
            let span = length(&main[i]);
            if !(*at > start + EPS && *at < start + span - EPS) {
                bail!("{at:.3} 秒不在 {id}（{start:.3}–{:.3} 秒）里面", start + span)
            }
            cut_clip(doc, i, *at)?;
        }
        Op::Set { id, fields } => {
            if let Some(key) = fields.keys().find(|key| !SETTABLE.contains(&key.as_str())) {
                bail!("不能这样改「{key}」：可以改的是 {}", SETTABLE.join("、"))
            }
            if let Some(crop) = fields.get("crop") {
                check_crop(crop)?;
            }
            let main = main_of(doc)?;
            let i = index_of(main, id)?;
            let before = length(&main[i]);
            for (key, value) in fields {
                main[i][key] = value.clone();
            }
            if vj {
                let delta = length(&main[i]) - before;
                hold_after(main, i, delta)?;
            }
        }
        Op::Gap { index, length: span } => {
            let main = main_of(doc)?;
            if !(span.is_finite() && *span >= 0.) {
                bail!("length 要不小于 0")
            }
            if *index < main.len() && is_gap(&main[*index]) {
                main[*index]["gap"] = json!(round(*span));
            } else if *index <= main.len() {
                main.insert(*index, json!({ "gap": round(*span) }));
            } else {
                bail!("index {index} 超出主线（共 {} 段）", main.len())
            }
        }
        Op::Branch { clip, side, length: span, opacity, fade } => {
            if side != "out" && side != "in" {
                bail!("side 要是 out 或 in")
            }
            index_of(main_of(doc)?, clip)?;
            let object = doc.as_object_mut().context("工程不是 JSON 对象")?;
            let branches = object.entry("branches").or_insert_with(|| json!([])).as_array_mut().context("branches 不是数组")?;
            branches.retain(|b| !(b["clip"] == json!(clip) && b["side"] == json!(side)));
            let mut branch = json!({ "clip": clip, "side": side, "length": span });
            if let Some(opacity) = opacity {
                branch["opacity"] = json!(opacity);
            }
            if let Some(fade) = fade {
                branch["fade"] = json!(fade);
            }
            branches.push(branch);
        }
        Op::Unbranch { clip, side } => {
            if let Some(branches) = doc.get_mut("branches").and_then(Value::as_array_mut) {
                branches.retain(|b| !(b["clip"] == json!(clip) && b["side"] == json!(side)));
            }
        }
        Op::AddSong { song, index } => {
            let song = Value::Object(song.clone());
            if song.get("src").and_then(Value::as_str).is_none() || num(&song, "out").is_none() {
                bail!("歌要有 src 和 out")
            }
            if !(song_length(&song) > EPS) {
                bail!("歌的长度要大于 0（out 要大于 in）")
            }
            let mut songs = songs_of(doc);
            let at = index.unwrap_or(songs.len());
            if at > songs.len() {
                bail!("index {at} 超出歌曲行（共 {} 首）", songs.len())
            }
            // What plays over the songs after it moves along with them.
            if at < songs.len() {
                let bounds = song_bounds(&songs);
                let (t, span) = (bounds[at], song_length(&song));
                let mut chunks: Vec<(Vec<Value>, f64)> = song_chunks(doc, &bounds)?.into_iter()
                    .zip(songs.iter().map(song_length)).collect();
                chunks.insert(at, (vec![], span));
                rejoin(doc, chunks, |old| Some(if old >= t - EPS { old + span } else { old }))?;
            }
            songs.insert(at, song);
            put_songs(doc, songs)?;
        }
        Op::RemoveSong { index } => {
            let mut songs = songs_of(doc);
            if *index >= songs.len() {
                bail!("歌曲行没有第 {} 首（共 {} 首）", index + 1, songs.len())
            }
            // What played over the song goes with it; what came after moves up. The last song going
            // leaves the picture as it is: a video of its own now.
            if songs.len() > 1 {
                let bounds = song_bounds(&songs);
                let (from, to) = (bounds[*index], bounds[*index + 1]);
                let mut chunks: Vec<(Vec<Value>, f64)> = song_chunks(doc, &bounds)?.into_iter()
                    .zip(songs.iter().map(song_length)).collect();
                chunks.remove(*index);
                rejoin(doc, chunks, |old| if old < from - EPS { Some(old) } else if old >= to - EPS { Some(old - (to - from)) } else { None })?;
            }
            songs.remove(*index);
            put_songs(doc, songs)?;
        }
        Op::MoveSong { from, to } => {
            let mut songs = songs_of(doc);
            if *from >= songs.len() || *to >= songs.len() {
                bail!("歌曲行共 {} 首，没有第 {} 或第 {} 首", songs.len(), from + 1, to + 1)
            }
            // What plays over each song goes where its song goes.
            let bounds = song_bounds(&songs);
            let mut chunks: Vec<(Vec<Value>, f64, usize)> = song_chunks(doc, &bounds)?.into_iter()
                .zip(songs.iter().map(song_length)).enumerate().map(|(n, (chunk, span))| (chunk, span, n)).collect();
            let moved = chunks.remove(*from);
            chunks.insert(*to, moved);
            let mut start = vec![0.; chunks.len()];
            let mut at = 0.;
            for (_, span, old) in &chunks {
                start[*old] = at;
                at += span;
            }
            let place = |old: f64| {
                let n = (0..bounds.len() - 1).rev().find(|&n| old >= bounds[n] - EPS).unwrap_or(0);
                Some(old - bounds[n] + start[n.min(start.len() - 1)])
            };
            rejoin(doc, chunks.into_iter().map(|(chunk, span, _)| (chunk, span)).collect(), place)?;
            let song = songs.remove(*from);
            songs.insert(*to, song);
            put_songs(doc, songs)?;
        }
        Op::SetSong { index, fields } => {
            let mut songs = songs_of(doc);
            let song = songs.get_mut(*index)
                .with_context(|| format!("歌曲行没有第 {} 首", index + 1))?;
            for (key, value) in fields {
                if key != "volume" {
                    bail!("歌只能改 volume，不能改「{key}」")
                }
                if !value.as_f64().is_some_and(|v| (0. ..=2.).contains(&v)) {
                    bail!("volume 要在 0–2 之间")
                }
                song[key] = value.clone();
            }
            put_songs(doc, songs)?;
        }
        Op::MoveTo { id, at, over } => {
            if !vj {
                bail!("没有歌的工程按顺序排，用 move 换位置")
            }
            let main = main_of(doc)?;
            let i = index_of(main, id)?;
            let item = main[i].clone();
            main[i] = json!({ "gap": round(length(&item)) });
            tidy(main);
            let at = at.max(0.);
            if *over {
                clear(doc, at, at + length(&item))?;
                tidy(main_of(doc)?);
            }
            place_at(main_of(doc)?, item, at)?;
        }
        Op::Restore { document } => {
            if document.get("kdjv").and_then(Value::as_u64) != Some(2) || !document["main"].is_array() {
                bail!("要还原的不是格式 2 的工程")
            }
            *doc = document.clone();
        }
        Op::Markers { markers } => {
            let mut list = vec![];
            for marker in markers {
                let at = num(marker, "at").filter(|at| *at >= 0.).context("标记要有 at（≥ 0 秒）")?;
                let mut kept = marker.clone();
                kept["at"] = json!(round(at));
                list.push(kept);
            }
            list.sort_by(|a, b| num(a, "at").unwrap_or(0.).total_cmp(&num(b, "at").unwrap_or(0.)));
            if list.is_empty() {
                if let Some(object) = doc.as_object_mut() { object.remove("markers"); }
            } else {
                doc["markers"] = Value::Array(list);
            }
        }
        Op::AddTitle { title } => {
            let mut title = Value::Object(title.clone());
            check_title(&title)?;
            let titles = titles_of(doc)?;
            let taken = |id: &str| titles.iter().any(|t| t["id"].as_str() == Some(id));
            let id = (1..).map(|n| format!("t{n}")).find(|id| !taken(id)).unwrap();
            title["id"] = json!(id);
            titles.push(title);
        }
        Op::SetTitle { id, fields } => {
            if let Some(key) = fields.keys().find(|key| !TITLE_FIELDS.contains(&key.as_str())) {
                bail!("字幕不能这样改「{key}」：可以改的是 {}", TITLE_FIELDS.join("、"))
            }
            let titles = titles_of(doc)?;
            let title = titles.iter_mut().find(|t| t["id"].as_str() == Some(id.as_str()))
                .with_context(|| format!("没有 id 为「{id}」的字幕"))?;
            for (key, value) in fields {
                title[key] = value.clone();
            }
            check_title(title)?;
        }
        Op::RemoveTitle { id } => {
            let titles = titles_of(doc)?;
            let before = titles.len();
            titles.retain(|t| t["id"].as_str() != Some(id.as_str()));
            if titles.len() == before {
                bail!("没有 id 为「{id}」的字幕")
            }
            if titles.is_empty() {
                if let Some(object) = doc.as_object_mut() { object.remove("titles"); }
            }
        }
    }
    Ok(())
}

/// Where everything is, for whoever edits next: each stretch of the main lane with its start, and
/// each branch with the stretch of the project it covers.
pub fn layout(doc: &Value) -> Value {
    let main: Vec<Value> = doc["main"].as_array().cloned().unwrap_or_default();
    let begins = starts(&main);
    let items: Vec<Value> = main.iter().enumerate().map(|(i, item)| {
        let mut out = json!({ "index": i, "at": round(begins[i]), "length": round(length(item)) });
        if is_gap(item) {
            out["gap"] = json!(true);
        } else {
            out["id"] = item["id"].clone();
            out["src"] = item["src"].clone();
        }
        out
    }).collect();
    let branches: Vec<Value> = doc["branches"].as_array().into_iter().flatten().filter_map(|b| {
        let clip = b["clip"].as_str()?;
        let i = main.iter().position(|item| item["id"].as_str() == Some(clip))?;
        let span = num(b, "length")?;
        let at = if b["side"] == json!("in") { begins[i] - span } else { begins[i] + length(&main[i]) };
        Some(json!({ "clip": clip, "side": b["side"], "at": round(at), "length": span }))
    }).collect();
    let end = begins.last().map_or(0., |s| s + length(main.last().unwrap()));
    let mut at = 0.;
    let songs: Vec<Value> = songs_of(doc).iter().enumerate().map(|(index, song)| {
        let placed = json!({ "index": index, "at": round(at), "length": round(song_length(song)), "src": song["src"], "in": num(song, "in").unwrap_or(0.) });
        at += song_length(song);
        placed
    }).collect();
    // Without songs the project runs as long as anything in it: the main lane, a branch out of its
    // last clip, a title past its end.
    let reach = branches.iter().map(|b| num(b, "at").unwrap_or(0.) + num(b, "length").unwrap_or(0.))
        .chain(doc["titles"].as_array().into_iter().flatten().map(|t| num(t, "at").unwrap_or(0.) + num(t, "length").unwrap_or(0.)))
        .fold(end, f64::max);
    json!({ "duration": round(if at > 0. { at } else { reach }), "main_end": round(end), "main": items, "branches": branches, "songs": songs })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ops(text: &str) -> Vec<Op> {
        serde_json::from_str(text).unwrap()
    }

    fn vj() -> Value {
        apply(&json!({}), &ops(r#"[
            {"op":"new","title":"VJ","song":{"src":"/s.flac","in":0,"out":60}},
            {"op":"add","clip":{"src":"/a.mp4","in":0,"out":10}},
            {"op":"add","clip":{"src":"/b.mp4","in":20,"out":30},"at":20}
        ]"#)).unwrap()
    }

    fn shape(doc: &Value) -> Vec<(String, f64, f64)> {
        layout(doc)["main"].as_array().unwrap().iter()
            .map(|item| (item["id"].as_str().unwrap_or("-").to_string(), item["at"].as_f64().unwrap(), item["length"].as_f64().unwrap()))
            .collect()
    }

    #[test]
    fn clips_go_end_to_end_or_into_the_black_where_they_were_aligned() {
        let doc = vj();
        assert_eq!(shape(&doc), vec![("c1".into(), 0., 10.), ("-".into(), 10., 10.), ("c2".into(), 20., 10.)]);
        let more = apply(&doc, &ops(r#"[{"op":"add","clip":{"src":"/c.mp4","out":4},"at":12}]"#)).unwrap();
        assert_eq!(shape(&more)[1..4], [("-".into(), 10., 2.), ("c3".into(), 12., 4.), ("-".into(), 16., 4.)]);
        let error = apply(&doc, &ops(r#"[{"op":"add","clip":{"src":"/c.mp4","out":12},"at":12}]"#)).unwrap_err();
        assert!(format!("{error:#}").contains("会盖住"), "{error:#}");
        assert_eq!(layout(&doc)["duration"], json!(60.), "a VJ is as long as its song");
    }

    #[test]
    fn in_a_vj_what_follows_an_edit_stays_in_sync() {
        let doc = vj();
        let trimmed = apply(&doc, &ops(r#"[{"op":"trim","id":"c1","out":6}]"#)).unwrap();
        assert_eq!(shape(&trimmed)[2], ("c2".into(), 20., 10.), "the black after c1 took the 4 s");
        let slow = apply(&doc, &ops(r#"[{"op":"set","id":"c1","fields":{"speed":0.5}}]"#)).unwrap();
        assert_eq!(shape(&slow), vec![("c1".into(), 0., 20.), ("c2".into(), 20., 10.)], "c1 grew to 20 s into its black");
        let error = apply(&doc, &ops(r#"[{"op":"set","id":"c1","fields":{"speed":0.4}}]"#)).unwrap_err();
        assert!(format!("{error:#}").contains("盖住"), "{error:#}");
        let removed = apply(&doc, &ops(r#"[{"op":"remove","id":"c1"}]"#)).unwrap();
        assert_eq!(shape(&removed), vec![("-".into(), 0., 20.), ("c2".into(), 20., 10.)], "black in its place, merged");
    }

    #[test]
    fn without_a_song_the_lane_closes_up() {
        let doc = apply(&json!({}), &ops(r#"[
            {"op":"new","title":"cut"},
            {"op":"add","clip":{"id":"a","src":"/a.mp4","out":10}},
            {"op":"add","clip":{"id":"b","src":"/b.mp4","out":5}},
            {"op":"remove","id":"a"}
        ]"#)).unwrap();
        assert_eq!(shape(&doc), vec![("b".into(), 0., 5.)]);
    }

    #[test]
    fn a_split_keeps_both_halves_in_place_and_hands_the_end_branch_on() {
        let doc = apply(&vj(), &ops(r#"[
            {"op":"branch","clip":"c1","side":"out","length":1},
            {"op":"split","id":"c1","at":4}
        ]"#)).unwrap();
        assert_eq!(shape(&doc)[..2], [("c1".into(), 0., 4.), ("c1-2".into(), 4., 6.)]);
        assert_eq!(doc["main"][1]["in"], json!(4.));
        assert_eq!(layout(&doc)["branches"][0]["clip"], json!("c1-2"), "the out branch belongs to the end");
        let gone = apply(&doc, &ops(r#"[{"op":"remove","id":"c1-2"}]"#)).unwrap();
        assert_eq!(gone["branches"], json!([]), "a removed clip takes its branches");
    }

    #[test]
    fn a_failed_step_names_itself_and_keeps_nothing() {
        let doc = vj();
        let error = apply(&doc, &ops(r#"[{"op":"title","title":"x"},{"op":"set","id":"c1","fields":{"src":"/x.mp4"}}]"#)).unwrap_err();
        assert!(format!("{error:#}").contains("第 2 步（set）"), "{error:#}");
        assert_eq!(doc["title"], json!("VJ"));
    }

    #[test]
    fn songs_play_one_after_another_and_a_single_song_stays_written_as_song() {
        let doc = apply(&vj(), &ops(r#"[
            {"op":"add_song","song":{"src":"/t.flac","in":5,"out":45}},
            {"op":"add_song","song":{"src":"/first.flac","out":30},"index":0}
        ]"#)).unwrap();
        assert!(doc.get("song").is_none());
        let order: Vec<&str> = doc["songs"].as_array().unwrap().iter().map(|s| s["src"].as_str().unwrap()).collect();
        assert_eq!(order, ["/first.flac", "/s.flac", "/t.flac"], "inserted before the song at the index");
        let placed = layout(&doc);
        assert_eq!(placed["duration"], json!(130.), "30 + 60 + 40");
        assert_eq!(placed["songs"][2]["at"], json!(90.));
        let moved = apply(&doc, &ops(r#"[{"op":"move_song","from":2,"to":0}]"#)).unwrap();
        assert_eq!(moved["songs"][0]["src"], json!("/t.flac"));
        let louder = apply(&doc, &ops(r#"[{"op":"set_song","index":1,"fields":{"volume":1.5}}]"#)).unwrap();
        assert_eq!(louder["songs"][1]["volume"], json!(1.5));
        assert!(apply(&doc, &ops(r#"[{"op":"set_song","index":1,"fields":{"src":"/x.flac"}}]"#)).is_err());
        let one = apply(&doc, &ops(r#"[{"op":"remove_song","index":0},{"op":"remove_song","index":1}]"#)).unwrap();
        assert!(one.get("songs").is_none(), "{one}");
        assert_eq!(one["song"]["src"], json!("/s.flac"), "one song is written as before");
        let none = apply(&one, &ops(r#"[{"op":"remove_song","index":0}]"#)).unwrap();
        assert!(none.get("song").is_none() && none.get("songs").is_none());
        assert_eq!(layout(&none)["duration"], json!(30.), "without songs the main lane is the length");
    }

    #[test]
    fn a_clip_moves_in_time_keeping_its_branches_and_a_restore_takes_the_whole_document_back() {
        let doc = apply(&vj(), &ops(r#"[{"op":"branch","clip":"c1","side":"out","length":1}]"#)).unwrap();
        let moved = apply(&doc, &ops(r#"[{"op":"move_to","id":"c1","at":40}]"#)).unwrap();
        assert_eq!(shape(&moved)[0], ("-".into(), 0., 20.), "{moved}");
        let placed = layout(&moved);
        let c1 = placed["main"].as_array().unwrap().iter().find(|m| m["id"] == json!("c1")).unwrap();
        assert_eq!(c1["at"], json!(40.));
        assert_eq!(moved["branches"].as_array().unwrap().len(), 1, "the branch went with it");
        assert!(apply(&doc, &ops(r#"[{"op":"move_to","id":"c1","at":15}]"#)).is_err(), "over the next clip");
        let back = apply(&moved, &[Op::Restore { document: doc.clone() }]).unwrap();
        assert_eq!(back, doc);
    }

    #[test]
    fn markers_are_kept_in_order_and_titles_need_text_a_picture_and_a_place() {
        let doc = apply(&vj(), &ops(r#"[{"op":"markers","markers":[{"at":30,"name":"drop"},{"at":5}]}]"#)).unwrap();
        assert_eq!(doc["markers"], json!([{"at":5.0},{"at":30.0,"name":"drop"}]));
        let none = apply(&doc, &ops(r#"[{"op":"markers","markers":[]}]"#)).unwrap();
        assert!(none.get("markers").is_none());
        let titled = apply(&vj(), &ops(r#"[{"op":"add_title","title":{"text":"Hi","src":"/t/1.png","at":2,"length":3}}]"#)).unwrap();
        assert_eq!(titled["titles"][0]["id"], json!("t1"));
        let moved = apply(&titled, &ops(r#"[{"op":"set_title","id":"t1","fields":{"at":10}}]"#)).unwrap();
        assert_eq!(moved["titles"][0]["at"], json!(10));
        assert!(apply(&titled, &ops(r#"[{"op":"set_title","id":"t1","fields":{"text":" "}}]"#)).is_err());
        let gone = apply(&titled, &ops(r#"[{"op":"remove_title","id":"t1"}]"#)).unwrap();
        assert!(gone.get("titles").is_none());
    }

    #[test]
    fn the_last_clip_moves_into_the_black_at_the_end_and_a_drop_can_go_over_what_is_there() {
        let later = apply(&vj(), &ops(r#"[{"op":"move_to","id":"c2","at":25}]"#)).unwrap();
        assert_eq!(shape(&later)[2], ("c2".into(), 25., 10.), "{later}");
        let pulled = apply(&vj(), &ops(r#"[{"op":"trim","id":"c2","in":22},{"op":"move_to","id":"c2","at":22}]"#)).unwrap();
        assert_eq!(shape(&pulled)[2], ("c2".into(), 22., 8.), "the start of the last clip pulled in");
        let over = apply(&vj(), &ops(r#"[{"op":"add","clip":{"src":"/c.mp4","out":12},"at":5,"over":true}]"#)).unwrap();
        assert_eq!(shape(&over), vec![("c1".into(), 0., 5.), ("c3".into(), 5., 12.), ("-".into(), 17., 3.), ("c2".into(), 20., 10.)], "{over}");
        let across = apply(&vj(), &ops(r#"[{"op":"add","clip":{"src":"/c.mp4","out":2},"at":4,"over":true}]"#)).unwrap();
        assert_eq!(shape(&across)[..3], [("c1".into(), 0., 4.), ("c3".into(), 4., 2.), ("c1-2".into(), 6., 4.)]);
        assert_eq!(across["main"][2]["in"], json!(6.), "the rest of c1 plays on from where it was");
        let moved = apply(&vj(), &ops(r#"[{"op":"move_to","id":"c2","at":8,"over":true}]"#)).unwrap();
        assert_eq!(shape(&moved), vec![("c1".into(), 0., 8.), ("c2".into(), 8., 10.), ("-".into(), 18., 12.)], "{moved}");
    }

    #[test]
    fn the_picture_goes_with_its_song_when_songs_are_added_moved_or_removed() {
        let two = apply(&vj(), &ops(r#"[
            {"op":"add_song","song":{"src":"/t.flac","out":40}},
            {"op":"add","clip":{"src":"/d.mp4","out":5},"at":62},
            {"op":"markers","markers":[{"at":21},{"at":63}]}
        ]"#)).unwrap();
        let first = apply(&two, &ops(r#"[{"op":"add_song","song":{"src":"/x.flac","out":30},"index":0}]"#)).unwrap();
        let c2 = |doc: &Value| layout(doc)["main"].as_array().unwrap().iter().find(|m| m["id"] == json!("c2")).unwrap()["at"].clone();
        assert_eq!(c2(&first), json!(50.), "30 s of song in front of it");
        assert_eq!(first["markers"], json!([{"at":51.0},{"at":93.0}]));
        let swapped = apply(&two, &ops(r#"[{"op":"move_song","from":1,"to":0}]"#)).unwrap();
        assert_eq!(c2(&swapped), json!(60.), "after the 40 s song now");
        let c3 = layout(&swapped)["main"].as_array().unwrap().iter().find(|m| m["id"] == json!("c3")).unwrap()["at"].clone();
        assert_eq!(c3, json!(2.), "the clip over the second song came first with it");
        assert_eq!(swapped["markers"], json!([{"at":3.0},{"at":61.0}]));
        let gone = apply(&two, &ops(r#"[{"op":"remove_song","index":0}]"#)).unwrap();
        assert_eq!(shape(&gone), vec![("-".into(), 0., 2.), ("c3".into(), 2., 5.)], "{gone}");
        assert_eq!(gone["markers"], json!([{"at":3.0}]));
    }

    #[test]
    fn a_crop_leaves_some_picture() {
        assert!(apply(&vj(), &ops(r#"[{"op":"set","id":"c1","fields":{"crop":[0.1,0,0.1,0.2]}}]"#)).is_ok());
        assert!(apply(&vj(), &ops(r#"[{"op":"set","id":"c1","fields":{"crop":[0.5,0,0.5,0]}}]"#)).is_err());
    }
}
