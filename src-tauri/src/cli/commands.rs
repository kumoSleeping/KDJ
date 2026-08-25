use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use clap::Parser;
use serde_json::{json, Value};

use super::args::{
    AccountCmd, AccountPlaylistCmd, Cli, CollectionCmd, Commands, DownloadCmd, FolderCmd,
    LibraryCmd, MixCmd, SettingsCmd, SkillCmd,
};
use super::http::HttpClient;
use super::runtime;
use super::skill::{export_skill_preset, export_skill_to, SkillPreset};

pub fn run() -> i32 {
    attach_windows_console();
    match run_inner() {
        Ok(code) => code,
        Err(err) => {
            emit_err(1, "failed", &format!("{err:#}"), None);
            1
        }
    }
}

fn run_inner() -> Result<i32> {
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(err) => {
            let _ = err.print();
            return Ok(if err.exit_code() == 0 { 0 } else { 2 });
        }
    };
    match cli.command {
        Commands::Spec => Ok(emit_ok(spec_doc())),
        Commands::Skill { command } => match command {
            SkillCmd::Export { to } => Ok(emit_ok(serde_json::to_value(export_skill(&to)?)?)),
        },
        other => {
            let base = runtime::ensure_running(cli.data_dir.as_deref(), cli.url.as_deref())?;
            let http = HttpClient::new(&base);
            dispatch(&http, other)
        }
    }
}

fn dispatch(http: &HttpClient, command: Commands) -> Result<i32> {
    match command {
        Commands::Status => Ok(emit_ok(status_payload(http)?)),
        Commands::Ui => {
            http.post_json("/api/control/show", &json!({}))?;
            Ok(emit_ok(json!({ "shown": true })))
        }
        Commands::Quit => {
            let _ = http.post_json("/api/control/quit", &json!({}));
            Ok(emit_ok(json!({ "quit": true })))
        }
        Commands::Library { command } => library(http, command),
        Commands::Search {
            query,
            kind,
            platform,
            no_merge,
            limit,
            capabilities,
        } => {
            if capabilities || query.as_deref() == Some("capabilities") {
                return Ok(emit_ok(http.get_value("/api/search/capabilities")?));
            }
            let query = query.context("search 需要关键词")?;
            let platforms = parse_platforms(platform.as_deref());
            let body = json!({
                "query": query,
                "kind": kind,
                "merge": !no_merge,
                "limit": limit,
                "platforms": platforms,
            });
            Ok(emit_ok(project_search(
                http.post_json("/api/search", &body)?,
            )))
        }
        Commands::Collection { command } => collection(http, command),
        Commands::Resolve { url, to, download } => {
            let resolved = http.post_json("/api/resolve", &json!({ "url": url, "limit": 0 }))?;
            if download {
                let dest = resolve_dest(http, to.as_deref())?;
                let sources = resolved
                    .get("sources")
                    .cloned()
                    .unwrap_or(Value::Array(vec![]));
                let tasks = enqueue(http, sources, dest, None, None)?;
                return Ok(emit_ok(json!({ "resolved": resolved, "tasks": tasks })));
            }
            Ok(emit_ok(resolved))
        }
        Commands::Download { command } => download_cmd(http, command),
        Commands::Mix { command } => mix(http, command),
        Commands::Folder { command } => folder(http, command),
        Commands::Settings { command } => settings(http, command),
        Commands::Account { command } => account(http, command),
        Commands::Spec | Commands::Skill { .. } => unreachable!(),
    }
}

fn library(http: &HttpClient, command: LibraryCmd) -> Result<i32> {
    match command {
        LibraryCmd::List {
            q,
            key,
            bpm,
            energy,
            folder,
            analyzed,
            limit,
            offset,
        } => {
            let (bpm_min, bpm_max) = parse_bpm(bpm.as_deref())?;
            let mut pairs: Vec<(String, String)> = vec![
                ("limit".into(), limit.to_string()),
                ("offset".into(), offset.to_string()),
            ];
            if let Some(q) = q {
                pairs.push(("q".into(), q));
            }
            if let Some(key) = key {
                pairs.push(("key".into(), key));
            }
            if let Some(min) = bpm_min {
                pairs.push(("bpm_min".into(), min.to_string()));
            }
            if let Some(max) = bpm_max {
                pairs.push(("bpm_max".into(), max.to_string()));
            }
            if let Some(energy) = energy {
                pairs.push(("energy_min".into(), energy.to_string()));
            }
            if let Some(folder) = folder {
                pairs.push(("folder".into(), folder));
                pairs.push(("folder_deep".into(), "true".into()));
            }
            if let Some(analyzed) = analyzed {
                pairs.push(("analyzed".into(), analyzed.to_string()));
            }
            let page = http.get_query("/api/library/tracks", &pairs)?;
            Ok(emit_ok(project_track_page(page)))
        }
        LibraryCmd::Get { id, path, q } => {
            let track = resolve_track(http, id, path.as_deref(), q.as_deref())?;
            Ok(emit_ok(brief_track(&track)))
        }
        LibraryCmd::Stats => Ok(emit_ok(http.get_value("/api/library/stats")?)),
        LibraryCmd::Move {
            id,
            path,
            q,
            to,
            dry_run,
        } => {
            let ids = resolve_ids(http, id, path.as_deref(), q.as_deref())?;
            let dest = resolve_dest(http, Some(&to))?;
            if dry_run {
                return Ok(emit_ok(
                    json!({ "dry_run": true, "track_ids": ids, "to": dest }),
                ));
            }
            Ok(emit_ok(http.post_json(
                "/api/library/folders/apply",
                &json!({ "track_ids": ids, "dest": dest, "op": "move" }),
            )?))
        }
        LibraryCmd::Forget {
            id,
            path,
            q,
            folder,
            dry_run,
        } => {
            if let Some(folder) = folder {
                if dry_run {
                    return Ok(emit_ok(json!({ "dry_run": true, "folder": folder })));
                }
                return Ok(emit_ok(http.post_json(
                    "/api/library/folders/forget",
                    &json!({ "path": folder }),
                )?));
            }
            let ids = resolve_ids(http, id, path.as_deref(), q.as_deref())?;
            if dry_run {
                return Ok(emit_ok(
                    json!({ "dry_run": true, "track_ids": ids, "file": "keep" }),
                ));
            }
            Ok(emit_ok(http.post_json(
                "/api/library/tracks/delete",
                &json!({ "track_ids": ids, "file": "keep" }),
            )?))
        }
        LibraryCmd::Delete {
            id,
            path,
            q,
            yes,
            dry_run,
        } => {
            if !yes && !dry_run {
                emit_err(
                    2,
                    "usage",
                    "彻底删除必须加 --yes",
                    Some("先 --dry-run 看名单，确认后加 --yes"),
                );
                return Ok(2);
            }
            let ids = resolve_ids(http, id, path.as_deref(), q.as_deref())?;
            if dry_run {
                return Ok(emit_ok(
                    json!({ "dry_run": true, "track_ids": ids, "file": "remove" }),
                ));
            }
            Ok(emit_ok(http.post_json(
                "/api/library/tracks/delete",
                &json!({ "track_ids": ids, "file": "remove" }),
            )?))
        }
        LibraryCmd::Undo => Ok(emit_ok(
            http.post_json("/api/library/folders/undo", &json!({}))?,
        )),
        LibraryCmd::Scan { paths, analyze } => {
            if paths.is_empty() {
                bail!("scan 需要至少一个路径");
            }
            Ok(emit_ok(http.post_json(
                "/api/library/scan",
                &json!({ "paths": paths, "recursive": true, "analyze": analyze }),
            )?))
        }
        LibraryCmd::Analyze { id, pending, force } => {
            let track_ids = if pending || id.is_empty() {
                Value::Null
            } else {
                json!(id)
            };
            Ok(emit_ok(http.post_json(
                "/api/library/analyze",
                &json!({ "track_ids": track_ids, "force": force, "version": "v2" }),
            )?))
        }
    }
}

fn collection(http: &HttpClient, command: CollectionCmd) -> Result<i32> {
    match command {
        CollectionCmd::Get {
            platform,
            kind,
            key,
        } => Ok(emit_ok(http.post_json(
            "/api/search/collection",
            &json!({ "platform": platform, "kind": kind, "key": key, "limit": 0 }),
        )?)),
        CollectionCmd::Download {
            platform,
            kind,
            key,
            to,
            quality,
            no_analyze,
        } => {
            let resolved = http.post_json(
                "/api/search/collection",
                &json!({ "platform": platform, "kind": kind, "key": key, "limit": 0 }),
            )?;
            let dest = resolve_dest(http, to.as_deref())?;
            let sources = filter_new_sources(&resolved);
            let tasks = enqueue(http, sources, dest, quality.as_deref(), Some(!no_analyze))?;
            Ok(emit_ok(
                json!({ "collection": project_collection(&resolved), "tasks": tasks }),
            ))
        }
    }
}

fn download_cmd(http: &HttpClient, command: DownloadCmd) -> Result<i32> {
    match command {
        DownloadCmd::Dests => Ok(emit_ok(download_dests(http)?)),
        DownloadCmd::Ls => Ok(emit_ok(http.get_value("/api/downloads")?)),
        DownloadCmd::Enqueue {
            platform,
            key,
            to,
            quality,
        } => {
            let search = http.post_json(
                "/api/search",
                &json!({
                    "query": key,
                    "platforms": [platform],
                    "limit": 20,
                    "merge": true,
                    "kind": "song",
                }),
            )?;
            let Some(source) = find_source_by_key(&search, &platform, &key) else {
                bail!("找不到 {platform}:{key}，请改用 collection download 或先 search");
            };
            let dest = resolve_dest(http, to.as_deref())?;
            Ok(emit_ok(enqueue(
                http,
                Value::Array(vec![source]),
                dest,
                quality.as_deref(),
                None,
            )?))
        }
        DownloadCmd::Start => Ok(emit_ok(http.post_json("/api/downloads/start", &json!({}))?)),
        DownloadCmd::Cancel { id } => Ok(emit_ok(
            http.post_json(&format!("/api/downloads/{id}/cancel"), &json!({}))?,
        )),
        DownloadCmd::Retry { id } => Ok(emit_ok(
            http.post_json(&format!("/api/downloads/{id}/retry"), &json!({}))?,
        )),
    }
}

fn mix(http: &HttpClient, command: MixCmd) -> Result<i32> {
    match command {
        MixCmd::Next {
            id,
            path,
            q,
            bpm_tolerance,
            limit,
            folder,
        } => {
            let track = resolve_track(http, id, path.as_deref(), q.as_deref())?;
            let id = track["id"].as_i64().context("曲目没有 id")?;
            let mut pairs: Vec<(String, String)> = vec![
                ("bpm_tolerance".into(), bpm_tolerance.to_string()),
                ("limit".into(), limit.to_string()),
            ];
            if let Some(folder) = folder {
                pairs.push(("folder".into(), folder));
            }
            let matches = http.get_query(&format!("/api/library/harmonic/{id}"), &pairs)?;
            Ok(emit_ok(project_harmonic(matches)))
        }
        MixCmd::Query {
            bpm,
            key,
            energy,
            folder,
            limit,
        } => library(
            http,
            LibraryCmd::List {
                q: None,
                key,
                bpm,
                energy,
                folder,
                analyzed: Some(true),
                limit,
                offset: 0,
            },
        ),
    }
}

fn folder(http: &HttpClient, command: FolderCmd) -> Result<i32> {
    match command {
        FolderCmd::Tree => Ok(emit_ok(http.get_value("/api/library/folders")?)),
        FolderCmd::Mkdir { parent, name } => Ok(emit_ok(http.post_json(
            "/api/library/folders/create",
            &json!({ "parent": parent, "name": name }),
        )?)),
        FolderCmd::Rename { path, name } => Ok(emit_ok(http.post_json(
            "/api/library/folders/rename",
            &json!({ "path": path, "name": name }),
        )?)),
        FolderCmd::Mv { path, to } => Ok(emit_ok(http.post_json(
            "/api/library/folders/move",
            &json!({ "path": path, "dest_parent": to }),
        )?)),
        FolderCmd::Rmdir { path } => Ok(emit_ok(
            http.post_json("/api/library/folders/delete", &json!({ "path": path }))?,
        )),
    }
}

fn settings(http: &HttpClient, command: SettingsCmd) -> Result<i32> {
    match command {
        SettingsCmd::Get => Ok(emit_ok(http.get_value("/api/settings")?)),
        SettingsCmd::Set {
            download_dir,
            filename_template,
        } => {
            let mut current = http.get_value("/api/settings")?;
            if let Some(dir) = download_dir {
                current["download_dir"] = json!(dir);
            }
            if let Some(template) = filename_template {
                current["filename_template"] = json!(template);
            }
            Ok(emit_ok(http.send_json(
                reqwest::Method::PUT,
                "/api/settings",
                &current,
            )?))
        }
    }
}

fn account(http: &HttpClient, command: AccountCmd) -> Result<i32> {
    match command {
        AccountCmd::Ls => Ok(emit_ok(http.get_value("/api/accounts")?)),
        AccountCmd::Playlists { platform } => Ok(emit_ok(
            http.get_value(&format!("/api/stream/playlists/{platform}"))?,
        )),
        AccountCmd::Playlist { command } => match command {
            AccountPlaylistCmd::Get { platform, key } => Ok(emit_ok(http.post_json(
                "/api/stream/playlist",
                &json!({ "platform": platform, "key": key, "limit": 0 }),
            )?)),
            AccountPlaylistCmd::Download { platform, key, to } => {
                let resolved = http.post_json(
                    "/api/stream/playlist",
                    &json!({ "platform": platform, "key": key, "limit": 0 }),
                )?;
                let dest = resolve_dest(http, to.as_deref())?;
                let sources = resolved
                    .get("sources")
                    .cloned()
                    .unwrap_or(Value::Array(vec![]));
                let tasks = enqueue(http, sources, dest, None, None)?;
                Ok(emit_ok(
                    json!({ "playlist": resolved.get("title"), "tasks": tasks }),
                ))
            }
        },
    }
}

fn export_skill(to: &str) -> Result<super::skill::SkillExportResult> {
    if let Some(preset) = SkillPreset::parse(to) {
        return export_skill_preset(preset);
    }
    export_skill_to(&PathBuf::from(to))
}

fn status_payload(http: &HttpClient) -> Result<Value> {
    let health = http.get_value("/api/health")?;
    Ok(json!({
        "health": health,
        "cli": { "version": kdj_core::VERSION },
    }))
}

fn spec_doc() -> Value {
    json!({
        "version": kdj_core::VERSION,
        "binary": "KDJ / kdj",
        "handbook": "设置 → CLI → 导出到 Claude Code / Codex / PI / Cursor；导出整目录覆盖",
        "highlights": [
            "同一份已安装的 KDJ 二进制：有子命令当客户端，没有则驻留；未就绪拉起 --no-gui",
            "关窗不等于退出；kdj ui 唤回，kdj quit 真退出",
            "下载 --to = 侧栏文件夹；先 download dests 再下",
            "曲库写操作只有 move / forget / delete --yes；forget 不删磁盘",
            "搜索 --kind song|playlist|album|artist|radio；集合 key 先 collection get/download",
        ],
        "commands": [
            "status", "ui", "quit", "spec",
            "library list|get|stats|move|forget|delete|undo|scan|analyze",
            "search", "collection get|download", "resolve",
            "download dests|ls|enqueue|start|cancel|retry",
            "mix next|query", "folder tree|mkdir|rename|mv|rmdir",
            "settings get|set", "account ls|playlists|playlist",
            "skill export --to cursor|claude|codex|pi|<dir>"
        ],
    })
}

fn resolve_track(
    http: &HttpClient,
    id: Option<i64>,
    path: Option<&str>,
    q: Option<&str>,
) -> Result<Value> {
    if let Some(id) = id {
        return http.get_value(&format!("/api/library/tracks/{id}"));
    }
    let mut pairs: Vec<(String, String)> = vec![("limit".into(), "8".into())];
    if let Some(path) = path {
        pairs.push(("q".into(), path.to_string()));
    } else if let Some(q) = q {
        pairs.push(("q".into(), q.to_string()));
    } else {
        bail!("需要 --id / --path / --q");
    }
    let page = http.get_query("/api/library/tracks", &pairs)?;
    let items = page["items"].as_array().cloned().unwrap_or_default();
    if let Some(path) = path {
        let exact: Vec<_> = items
            .iter()
            .filter(|item| item["path"].as_str() == Some(path))
            .cloned()
            .collect();
        return unique_track(exact, path);
    }
    unique_track(items, q.unwrap_or(""))
}

fn resolve_ids(
    http: &HttpClient,
    ids: Vec<i64>,
    path: Option<&str>,
    q: Option<&str>,
) -> Result<Vec<i64>> {
    if !ids.is_empty() {
        return Ok(ids);
    }
    let track = resolve_track(http, None, path, q)?;
    Ok(vec![track["id"].as_i64().context("曲目没有 id")?])
}

fn unique_track(items: Vec<Value>, label: &str) -> Result<Value> {
    match items.len() {
        0 => bail!("没有匹配：{label}"),
        1 => Ok(items.into_iter().next().unwrap()),
        _ => {
            let names: Vec<_> = items
                .iter()
                .filter_map(|item| {
                    Some(json!({
                        "id": item.get("id"),
                        "title": item.get("title"),
                        "path": item.get("path"),
                    }))
                })
                .collect();
            bail!(
                "匹配不唯一（{} 首），请改用 --id：{}",
                names.len(),
                serde_json::Value::Array(names)
            );
        }
    }
}

fn parse_bpm(raw: Option<&str>) -> Result<(Option<f64>, Option<f64>)> {
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok((None, None));
    };
    if let Some((lo, hi)) = raw.split_once("..") {
        return Ok((Some(lo.trim().parse()?), Some(hi.trim().parse()?)));
    }
    let value: f64 = raw.parse()?;
    Ok((Some(value), Some(value)))
}

fn parse_platforms(raw: Option<&str>) -> Value {
    match raw {
        None => json!(["wyy", "qqm"]),
        Some(text) => json!(text
            .split(',')
            .map(|part| part.trim())
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()),
    }
}

fn resolve_dest(http: &HttpClient, to: Option<&str>) -> Result<String> {
    let Some(to) = to.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(String::new());
    };
    if to.eq_ignore_ascii_case("default") {
        let settings = http.get_value("/api/settings")?;
        return Ok(settings["download_dir"].as_str().unwrap_or("").to_string());
    }
    let dests = download_dests(http)?;
    let items = dests["items"].as_array().cloned().unwrap_or_default();
    if let Some(hit) = items.iter().find(|item| item["path"].as_str() == Some(to)) {
        return Ok(hit["path"].as_str().unwrap_or(to).to_string());
    }
    let named: Vec<_> = items
        .iter()
        .filter(|item| item["name"].as_str() == Some(to))
        .cloned()
        .collect();
    match named.len() {
        1 => Ok(named[0]["path"].as_str().unwrap_or(to).to_string()),
        0 => Ok(to.to_string()),
        _ => bail!("文件夹名 {to} 不唯一，请改用 download dests 里的绝对路径"),
    }
}

fn download_dests(http: &HttpClient) -> Result<Value> {
    let settings = http.get_value("/api/settings")?;
    let tree = http.get_value("/api/library/folders")?;
    let mut items = vec![json!({
        "id": "default",
        "name": "默认下载文件夹",
        "path": settings["download_dir"],
    })];
    flatten_folders(tree.get("roots").and_then(Value::as_array), &mut items);
    Ok(json!({ "items": items }))
}

fn flatten_folders(nodes: Option<&Vec<Value>>, out: &mut Vec<Value>) {
    let Some(nodes) = nodes else {
        return;
    };
    for node in nodes {
        out.push(json!({
            "name": node.get("name"),
            "path": node.get("path"),
            "track_count": node.get("track_count"),
            "parent": node.get("parent"),
        }));
        flatten_folders(node.get("children").and_then(Value::as_array), out);
    }
}

fn enqueue(
    http: &HttpClient,
    sources: Value,
    dest: String,
    quality: Option<&str>,
    analyze: Option<bool>,
) -> Result<Value> {
    let mut body = json!({
        "sources": sources,
        "dest_dir": dest,
    });
    if let Some(quality) = quality {
        body["quality"] = json!(quality);
    }
    if let Some(analyze) = analyze {
        body["analyze"] = json!(analyze);
    }
    http.post_json("/api/downloads", &body)
}

fn filter_new_sources(resolved: &Value) -> Value {
    let known = resolved
        .get("in_library_source_keys")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let known: Vec<String> = known
        .iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect();
    let sources = resolved
        .get("sources")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Value::Array(
        sources
            .into_iter()
            .filter(|source| {
                let token = format!(
                    "{}:{}",
                    source["platform"].as_str().unwrap_or(""),
                    source["key"].as_str().unwrap_or("")
                );
                !known.contains(&token)
            })
            .collect(),
    )
}

fn find_source_by_key(search: &Value, platform: &str, key: &str) -> Option<Value> {
    let groups = search.get("groups")?.as_array()?;
    for group in groups {
        let sources = group.get("sources")?.as_array()?;
        if let Some(source) = sources.iter().find(|source| {
            source["platform"].as_str() == Some(platform) && source["key"].as_str() == Some(key)
        }) {
            return Some(source.clone());
        }
    }
    None
}

fn project_search(value: Value) -> Value {
    let groups = value
        .get("groups")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|group| {
            json!({
                "group_id": group.get("group_id"),
                "title": group.get("title"),
                "artists": group.get("artists"),
                "duration": group.get("duration"),
                "in_library": group.get("in_library"),
                "best_source": group.get("sources")
                    .and_then(Value::as_array)
                    .and_then(|sources| {
                        let index = group["best_source_index"].as_u64().unwrap_or(0) as usize;
                        sources.get(index).cloned()
                    })
                    .map(|source| json!({
                        "platform": source.get("platform"),
                        "key": source.get("key"),
                        "max_quality": source.get("max_quality"),
                    })),
            })
        })
        .collect::<Vec<_>>();
    let collections = value
        .get("collections")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|item| {
            json!({
                "kind": item.get("kind"),
                "platform": item.get("platform"),
                "key": item.get("key"),
                "title": item.get("title"),
                "count": item.get("count"),
            })
        })
        .collect::<Vec<_>>();
    json!({
        "query": value.get("query"),
        "groups": groups,
        "collections": collections,
        "errors": value.get("errors"),
        "elapsed_ms": value.get("elapsed_ms"),
    })
}

fn project_collection(value: &Value) -> Value {
    json!({
        "kind": value.get("kind"),
        "platform": value.get("platform"),
        "title": value.get("title"),
        "count": value.get("sources").and_then(Value::as_array).map(Vec::len),
    })
}

fn project_track_page(page: Value) -> Value {
    let items = page
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(brief_track)
        .collect::<Vec<_>>();
    json!({
        "items": items,
        "total": page.get("total"),
        "offset": page.get("offset"),
        "limit": page.get("limit"),
    })
}

fn project_harmonic(matches: Value) -> Value {
    let items = matches
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|item| {
            json!({
                "relation": item.get("relation"),
                "relation_label": item.get("relation_label"),
                "bpm_delta": item.get("bpm_delta"),
                "score": item.get("score"),
                "track": brief_track(item.get("track").unwrap_or(&Value::Null)),
            })
        })
        .collect::<Vec<_>>();
    json!(items)
}

fn brief_track(track: &Value) -> Value {
    json!({
        "id": track.get("id"),
        "title": track.get("title"),
        "artist": track.get("artist"),
        "bpm": track.get("bpm"),
        "camelot": track.get("camelot"),
        "energy": track.get("energy"),
        "rating": track.get("rating"),
        "path": track.get("path"),
        "folder": track.get("folder"),
        "analyzed": track.get("analyzed_at").and_then(Value::as_str).is_some_and(|s| !s.is_empty()),
    })
}

fn emit_ok(data: Value) -> i32 {
    emit(&json!({ "ok": true, "data": data }));
    0
}

fn emit_err(code: i32, err: &str, message: &str, hint: Option<&str>) -> i32 {
    emit(&json!({
        "ok": false,
        "error": { "code": err, "message": message, "hint": hint },
    }));
    code
}

fn emit(value: &Value) {
    println!("{value}");
}

fn attach_windows_console() {
    #[cfg(windows)]
    unsafe {
        windows_sys::Win32::System::Console::AttachConsole(u32::MAX);
    }
}
