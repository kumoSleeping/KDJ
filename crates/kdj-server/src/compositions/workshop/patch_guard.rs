//! PATCH 会用请求整体替换作品的轨道、画布与导出设置。`kdj-core` 的结构体有很多
//! `#[serde(default)]` 字段、也没有 `extra`：只发部分字段的客户端会把缺省的键静默重置
//! （例如 `crop_auto_fit`），不认识的键会被 serde 静默丢掉。这里在类型化之前拦下这两类请求，
//! 并按 `recovery.rs` 的路径写法列出出问题的键；文件级的同类保护见 `recovery::dropped_keys`。
//!
//! 约定：
//! - 已有的轨道按 `layer.id`、片段按 `clip.id`（跨轨道，移轨也能对上）、标记按 `marker.id` 对齐；
//!   `canvas` / `output` 直接对齐。当前作品的序列化结果（与写盘同一个 serde_json 序列化）里有的键，
//!   请求里都必须有；值为 `null` 也算给了，表示显式清空。
//! - 序列化时被 `skip_serializing_if` 省略的键（例如没有字幕时的 `subtitle`）当前就不存在，不要求请求带。
//! - 新增的轨道、片段、标记（id 不在当前作品里）只查未知键，可选键可以省略，由类型默认值补齐。
//! - `markers` 整个省略或为 `null` 表示保留原值（既有约定）。
//! - 顶层只放行 PATCH 会替换的字段，以及前端回传整份作品时附带、但 PATCH 不改的作品字段。
use super::*;
use serde_json::{Map, Value};

/// 被拒绝的修改：列出会被静默重置（缺键）或丢弃（未知键）的路径。
#[derive(Debug)]
pub struct FieldLoss(pub Vec<String>);

impl std::fmt::Display for FieldLoss {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let shown = self.0.iter().take(8).map(String::as_str).collect::<Vec<_>>();
        write!(f, "修改请求缺少当前作品已有的字段或带有当前版本不认识的字段（{}），已拒绝，作品未改动", shown.join("、"))
    }
}

impl std::error::Error for FieldLoss {}

const REPLACED: [&str; 5] = ["name", "layers", "canvas", "output", "markers"];
const PASSIVE: [&str; 4] = ["revision", "id", "sources", "migrated_from"];
const LIMIT: usize = 32;

/// 通过检查才返回类型化的修改；否则返回 `FieldLoss`（或请求格式错误）。
pub(super) fn checked_edit(current: &CompositionProject, body: &Value) -> Result<Edit> {
    let Value::Object(request) = body else { bail!("修改请求必须是 JSON 对象") };
    let mut out = request
        .keys()
        .filter(|key| !REPLACED.contains(&key.as_str()) && !PASSIVE.contains(&key.as_str()))
        .map(|key| format!(".{key}"))
        .collect::<Vec<_>>();
    missing_in_project(&serde_json::to_value(current)?, request, &mut out);
    let edit = match Edit::deserialize(body) {
        Ok(edit) => edit,
        Err(error) if out.is_empty() => return Err(anyhow::Error::new(error).context("修改请求格式错误")),
        Err(_) => return Err(loss(out)),
    };
    // 未知键：请求原样经类型模型再写出来，写不出来的键就是会被丢掉的键。
    let written = serde_json::to_value(&edit)?;
    for key in REPLACED {
        if let (Some(sent), Some(kept)) = (request.get(key), written.get(key)) {
            unknown(sent, kept, &format!(".{key}"), &mut out);
        }
    }
    if out.is_empty() { Ok(edit) } else { Err(loss(out)) }
}

fn loss(mut paths: Vec<String>) -> anyhow::Error {
    paths.truncate(LIMIT);
    FieldLoss(paths).into()
}

fn missing_in_project(saved: &Value, request: &Map<String, Value>, out: &mut Vec<String>) {
    for key in ["name", "canvas", "output", "layers"] {
        if !request.contains_key(key) { out.push(format!(".{key}")) }
    }
    for key in ["canvas", "output"] {
        if let (Some(kept), Some(sent)) = (saved.get(key), request.get(key)) {
            missing(kept, sent, &format!(".{key}"), out);
        }
    }
    if let (Some(Value::Array(kept)), Some(Value::Array(sent))) = (saved.get("markers"), request.get("markers")) {
        let kept = by_id(kept.iter());
        for (index, marker) in sent.iter().enumerate() {
            if let Some(old) = id_of(marker).and_then(|id| kept.get(id)) {
                missing(old, marker, &format!(".markers[{index}]"), out);
            }
        }
    }
    let (Some(Value::Array(kept)), Some(Value::Array(sent))) = (saved.get("layers"), request.get("layers")) else { return };
    let layers = by_id(kept.iter());
    let clips = by_id(kept.iter().filter_map(|layer| layer.get("clips")?.as_array()).flatten());
    for (index, layer) in sent.iter().enumerate() {
        let path = format!(".layers[{index}]");
        if let (Some(Value::Object(old)), Value::Object(new)) = (id_of(layer).and_then(|id| layers.get(id)).copied(), layer) {
            // 片段单独按 clip.id 对齐，这里只比轨道自己的键。
            missing_keys(old, new, &path, Some("clips"), out);
        }
        for (position, clip) in layer.get("clips").and_then(Value::as_array).into_iter().flatten().enumerate() {
            if let Some(old) = id_of(clip).and_then(|id| clips.get(id)) {
                missing(old, clip, &format!("{path}.clips[{position}]"), out);
            }
        }
    }
}

fn id_of(value: &Value) -> Option<&str> { value.get("id")?.as_str() }

fn by_id<'a>(values: impl Iterator<Item = &'a Value>) -> HashMap<&'a str, &'a Value> {
    values.filter_map(|value| Some((id_of(value)?, value))).collect()
}

/// 当前序列化结果里有、请求里没有的键。没有 id 的数组（裁切、节拍网格）按下标对齐。
fn missing(saved: &Value, sent: &Value, path: &str, out: &mut Vec<String>) {
    match (saved, sent) {
        (Value::Object(old), Value::Object(new)) => missing_keys(old, new, path, None, out),
        (Value::Array(old), Value::Array(new)) => {
            for (index, (value, other)) in old.iter().zip(new).enumerate() {
                missing(value, other, &format!("{path}[{index}]"), out);
            }
        }
        _ => {}
    }
}

fn missing_keys(old: &Map<String, Value>, new: &Map<String, Value>, path: &str, skip: Option<&str>, out: &mut Vec<String>) {
    for (key, value) in old {
        if skip == Some(key.as_str()) { continue }
        let child = format!("{path}.{key}");
        match new.get(key) {
            Some(other) => missing(value, other, &child, out),
            None => out.push(child),
        }
    }
}

/// 请求里有、类型模型写不回来的键。显式 `null` 写回时可能因 `Option::is_none` 被省略，
/// 那只是同一个“无”，不算丢失。
fn unknown(sent: &Value, kept: &Value, path: &str, out: &mut Vec<String>) {
    match (sent, kept) {
        (Value::Object(found), Value::Object(written)) => {
            for (key, value) in found {
                let child = format!("{path}.{key}");
                match written.get(key) {
                    Some(other) => unknown(value, other, &child, out),
                    None if value.is_null() => {}
                    None => out.push(child),
                }
            }
        }
        (Value::Array(found), Value::Array(written)) => {
            for (index, (value, other)) in found.iter().zip(written).enumerate() {
                unknown(value, other, &format!("{path}[{index}]"), out);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn clip(id: &str) -> Value {
        json!({
            "id": id, "source_id": "s", "start_ms": 0.0, "source_in_ms": 0.0, "source_out_ms": 1000.0,
            "speed": {"preset": "constant", "start": 1.0, "middle": 1.0, "end": 1.0, "domain_start_ms": 0.0, "domain_end_ms": 1000.0},
            "picture": {"x": 0.5, "y": 0.5, "scale": 1.0, "opacity": 1.0},
            "sound": {"muted": false, "gain": 1.0, "manual": false},
            "fades": {"offset_ms": 0.0, "span_ms": 1000.0, "video_in_ms": 0.0, "video_out_ms": 0.0, "audio_in_ms": 0.0, "audio_out_ms": 0.0}
        })
    }

    fn project() -> CompositionProject {
        let mut p = empty_project("任务 1", "/tmp");
        let mut saved: Clip = serde_json::from_value(clip("c1")).unwrap();
        saved.picture.crop_auto_fit = true;
        p.layers.push(Layer { grid: None, id: "l1".into(), source_id: "s".into(), clips: vec![saved] });
        p
    }

    /// 前端的形状：整份作品加 revision。
    fn full_body(p: &CompositionProject) -> Value {
        let mut body = serde_json::to_value(p).unwrap();
        body["revision"] = json!(p.revision);
        body
    }

    fn rejected(p: &CompositionProject, body: &Value) -> Vec<String> {
        let error = checked_edit(p, body).err().expect("request must be rejected");
        error.downcast_ref::<FieldLoss>().expect("field loss").0.clone()
    }

    #[test]
    fn full_project_body_passes_and_keeps_every_field() {
        let p = project();
        let edit = checked_edit(&p, &full_body(&p)).unwrap();
        assert!(edit.layers[0].clips[0].picture.crop_auto_fit);
        assert_eq!(edit.markers.as_deref(), Some(&p.markers[..]));
    }

    #[test]
    fn omitting_a_defaulted_key_of_an_existing_clip_is_rejected_with_its_path() {
        let p = project();
        let mut body = full_body(&p);
        body["layers"][0]["clips"][0]["picture"].as_object_mut().unwrap().remove("crop_auto_fit");
        body["canvas"].as_object_mut().unwrap().remove("import_picture");
        let paths = rejected(&p, &body);
        assert_eq!(paths, [".canvas.import_picture", ".layers[0].clips[0].picture.crop_auto_fit"]);
        // 同一片段移到新轨道也按 clip.id 对齐。
        let mut moved = full_body(&p);
        let old = moved["layers"][0]["clips"].as_array_mut().unwrap().remove(0);
        let mut layer = json!({"id": "l2", "source_id": "s", "clips": [old]});
        layer["clips"][0]["picture"].as_object_mut().unwrap().remove("crop_auto_fit");
        moved["layers"].as_array_mut().unwrap().push(layer);
        assert_eq!(rejected(&p, &moved), [".layers[1].clips[0].picture.crop_auto_fit"]);
    }

    #[test]
    fn keys_the_typed_model_would_drop_are_rejected() {
        let p = project();
        let mut body = full_body(&p);
        body["layers"][0]["clips"][0]["picture"]["glow"] = json!(0.4);
        body["output"]["bitrate"] = json!(12);
        body["future_field"] = json!(true);
        let mut paths = rejected(&p, &body);
        paths.sort();
        assert_eq!(paths, [".future_field", ".layers[0].clips[0].picture.glow", ".output.bitrate"]);
        // 显式 null 写回时被省略，不算丢失；`markers` 省略表示保留原值。
        let mut cleared = full_body(&p);
        cleared["layers"][0]["clips"][0]["video_transition"] = Value::Null;
        cleared["layers"][0]["grid"] = Value::Null;
        cleared.as_object_mut().unwrap().remove("markers");
        assert!(checked_edit(&p, &cleared).unwrap().markers.is_none());
    }

    #[test]
    fn new_clips_and_layers_may_omit_optional_keys() {
        let p = project();
        let mut body = full_body(&p);
        body["layers"][0]["clips"].as_array_mut().unwrap().push(clip("c2"));
        body["layers"].as_array_mut().unwrap().push(json!({"id": "l2", "source_id": "s", "clips": [clip("c3")]}));
        let edit = checked_edit(&p, &body).unwrap();
        assert!(!edit.layers[0].clips[1].picture.crop_auto_fit);
        assert!(edit.layers[0].clips[1].picture.crop_keep_position, "typed defaults fill new clips");
        let mut odd = clip("c4");
        odd["sparkle"] = json!(1);
        body["layers"][1]["clips"].as_array_mut().unwrap().push(odd);
        assert_eq!(rejected(&p, &body), [".layers[1].clips[1].sparkle"]);
    }
}
