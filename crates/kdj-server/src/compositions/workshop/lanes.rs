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
    /// `index`, else at the end. Without an `id` it gets one.
    Add {
        clip: Map<String, Value>,
        #[serde(default)]
        at: Option<f64>,
        #[serde(default)]
        index: Option<usize>,
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

const SETTABLE: &[&str] = &["speed", "volume", "muted", "x", "y", "scale", "opacity", "fill"];

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
        Op::Add { clip, at, index } => {
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
            match (at, index) {
                (Some(at), _) => {
                    let at = *at;
                    let begins = starts(main);
                    let end = begins.last().map_or(0., |s| s + length(main.last().unwrap()));
                    if at >= end - EPS {
                        if at - end > EPS {
                            main.push(json!({ "gap": round(at - end) }));
                        }
                        main.push(item);
                    } else {
                        let k = (0..main.len()).find(|&k| begins[k] <= at + EPS && at < begins[k] + length(&main[k]) - EPS)
                            .context("放的位置不在成片里")?;
                        if !is_gap(&main[k]) {
                            bail!("{at:.3} 秒处是 main[{k}]，只能放进黑的地方")
                        }
                        let (from, gap) = (begins[k], length(&main[k]));
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
                    }
                }
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
            let speed = num(&main[i], "speed").unwrap_or(1.);
            let cut = round(num(&main[i], "in").unwrap_or(0.) + (at - start) * speed);
            let mut second = main[i].clone();
            main[i]["out"] = json!(cut);
            second["in"] = json!(cut);
            let next = fresh_id(main, id);
            second["id"] = json!(next.clone());
            main.insert(i + 1, second);
            // The end of the clip is now the second half's: so is a branch from it.
            if let Some(branches) = doc.get_mut("branches").and_then(Value::as_array_mut) {
                for b in branches.iter_mut() {
                    if b["clip"] == json!(id) && b["side"] == json!("out") {
                        b["clip"] = json!(next.clone());
                    }
                }
            }
        }
        Op::Set { id, fields } => {
            if let Some(key) = fields.keys().find(|key| !SETTABLE.contains(&key.as_str())) {
                bail!("不能这样改「{key}」：可以改的是 {}", SETTABLE.join("、"))
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
            songs.insert(at, song);
            put_songs(doc, songs)?;
        }
        Op::RemoveSong { index } => {
            let mut songs = songs_of(doc);
            if *index >= songs.len() {
                bail!("歌曲行没有第 {} 首（共 {} 首）", index + 1, songs.len())
            }
            songs.remove(*index);
            put_songs(doc, songs)?;
        }
        Op::MoveSong { from, to } => {
            let mut songs = songs_of(doc);
            if *from >= songs.len() || *to >= songs.len() {
                bail!("歌曲行共 {} 首，没有第 {} 或第 {} 首", songs.len(), from + 1, to + 1)
            }
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
    json!({ "duration": round(if at > 0. { at } else { end }), "main_end": round(end), "main": items, "branches": branches, "songs": songs })
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
}
