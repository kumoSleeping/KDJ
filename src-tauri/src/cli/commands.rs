use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use clap::Parser;
use serde_json::{json, Value};

use super::args::{
    AccountCmd, Cli, Commands, DownloadCmd, DownloadFlowArgs, FolderCmd, LibraryCmd, MixCmd,
    SettingsCmd,
};
use super::http::HttpClient;
use super::runtime;

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
        other => {
            let runtime = runtime::ensure_running(cli.data_dir.as_deref(), cli.url.as_deref())?;
            let http = HttpClient::new(&runtime.base_url, &runtime.auth_token);
            dispatch(&http, other)
        }
    }
}

fn dispatch(http: &HttpClient, command: Commands) -> Result<i32> {
    match command {
        Commands::Status => Ok(emit_ok(status_payload(http)?)),
        Commands::Show => {
            http.post_json("/api/control/show", &json!({}))?;
            Ok(emit_ok(json!({ "shown": true })))
        }
        Commands::Quit => {
            http.post_json("/api/control/quit", &json!({}))?;
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
            download,
            pick,
            transfer,
        } => {
            if capabilities {
                if query.is_some()
                    || download
                    || !pick.is_empty()
                    || has_download_options(&transfer)
                {
                    bail!("search --capabilities 不和搜索或下载参数一起使用");
                }
                return Ok(emit_ok(http.get_value("/api/search/capabilities")?));
            }
            if !download && (!pick.is_empty() || has_download_options(&transfer)) {
                bail!("search 的 --pick 和下载参数必须和 --download 一起使用");
            }
            if download && kind != "song" {
                bail!("搜索集合请先取得 key，再用 collection --download");
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
            let searched = http.post_json("/api/search", &body)?;
            if !download {
                return Ok(emit_ok(project_search(searched)));
            }
            let sources = pick_search_sources(&searched, &pick)?;
            let dest = resolve_dest(http, transfer.to.as_deref())?;
            let tasks = enqueue(
                http,
                sources,
                dest,
                transfer.quality.as_deref(),
                transfer.no_analyze.then_some(false),
            )?;
            let mut result = run_download_flow(http, tasks, &transfer)?;
            result["search"] = project_search(searched);
            Ok(emit_ok(result))
        }
        Commands::Collection {
            platform,
            kind,
            key,
            download,
            transfer,
        } => collection(http, platform, kind, key, download, transfer),
        Commands::Resolve {
            input,
            download,
            transfer,
        } => {
            if !download && has_download_options(&transfer) {
                bail!("resolve 的下载参数必须和 --download 一起使用");
            }
            let resolved = http.post_json("/api/resolve", &json!({ "url": input, "limit": 0 }))?;
            if download {
                let dest = resolve_dest(http, transfer.to.as_deref())?;
                let sources = resolved
                    .get("sources")
                    .cloned()
                    .unwrap_or(Value::Array(vec![]));
                let tasks = enqueue(
                    http,
                    sources,
                    dest,
                    transfer.quality.as_deref(),
                    transfer.no_analyze.then_some(false),
                )?;
                let mut result = run_download_flow(http, tasks, &transfer)?;
                result["resolved"] = resolved;
                return Ok(emit_ok(result));
            }
            Ok(emit_ok(resolved))
        }
        Commands::Download { command } => download_cmd(http, command),
        Commands::Mix { command } => mix(http, command),
        Commands::Folder { command } => folder(http, command),
        Commands::Settings { command } => settings(http, command),
        Commands::Account { command } => account(http, command),
        Commands::Spec => unreachable!(),
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
        LibraryCmd::Analyze { id, force, version } => {
            let track_ids = if id.is_empty() {
                Value::Null
            } else {
                json!(id)
            };
            Ok(emit_ok(http.post_json(
                "/api/library/analyze",
                &json!({ "track_ids": track_ids, "force": force, "version": version }),
            )?))
        }
    }
}

fn collection(
    http: &HttpClient,
    platform: String,
    kind: String,
    key: String,
    download: bool,
    transfer: DownloadFlowArgs,
) -> Result<i32> {
    if !download && has_download_options(&transfer) {
        bail!("collection 的下载参数必须和 --download 一起使用");
    }
    let resolved = http.post_json(
        "/api/search/collection",
        &json!({ "platform": platform, "kind": kind, "key": key, "limit": 0 }),
    )?;
    if !download {
        return Ok(emit_ok(resolved));
    }
    let dest = resolve_dest(http, transfer.to.as_deref())?;
    let sources = filter_new_sources(&resolved);
    let tasks = enqueue(
        http,
        sources,
        dest,
        transfer.quality.as_deref(),
        transfer.no_analyze.then_some(false),
    )?;
    let mut result = run_download_flow(http, tasks, &transfer)?;
    result["collection"] = project_collection(&resolved);
    Ok(emit_ok(result))
}

fn download_cmd(http: &HttpClient, command: DownloadCmd) -> Result<i32> {
    match command {
        DownloadCmd::Destinations => Ok(emit_ok(download_dests(http)?)),
        DownloadCmd::List => Ok(emit_ok(http.get_value("/api/downloads")?)),
        DownloadCmd::Start { wait, timeout } => {
            let current = http.get_value("/api/downloads")?;
            let ids = start_download_ids(&current);
            http.post_json("/api/downloads/start", &json!({}))?;
            let tasks = if wait {
                wait_for_downloads(http, &ids, timeout)?
            } else {
                select_downloads(&http.get_value("/api/downloads")?, &ids)?
            };
            Ok(emit_ok(download_summary(tasks, true, wait)))
        }
        DownloadCmd::Wait { id, timeout } => {
            let ids = if id.is_empty() {
                active_download_ids(&http.get_value("/api/downloads")?)
            } else {
                id
            };
            let tasks = wait_for_downloads(http, &ids, timeout)?;
            Ok(emit_ok(download_summary(tasks, false, true)))
        }
        DownloadCmd::Cancel { id } => Ok(emit_ok(
            http.post_json(&format!("/api/downloads/{id}/cancel"), &json!({}))?,
        )),
        DownloadCmd::CancelAll => Ok(emit_ok(
            http.post_json("/api/downloads/cancel-all", &json!({}))?,
        )),
        DownloadCmd::Retry { id, wait, timeout } => {
            let task = http.post_json(&format!("/api/downloads/{id}/retry"), &json!({}))?;
            let tasks = if wait {
                wait_for_downloads(http, std::slice::from_ref(&id), timeout)?
            } else {
                Value::Array(vec![task])
            };
            Ok(emit_ok(download_summary(tasks, true, wait)))
        }
        DownloadCmd::Remove { id } => Ok(emit_ok(
            http.delete_query(&format!("/api/downloads/{id}"), &[] as &[(String, String)])?,
        )),
        DownloadCmd::Clear => Ok(emit_ok(http.post_json("/api/downloads/clear", &json!({}))?)),
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
    }
}

fn folder(http: &HttpClient, command: FolderCmd) -> Result<i32> {
    match command {
        FolderCmd::Tree => Ok(emit_ok(http.get_value("/api/library/folders")?)),
        FolderCmd::Create { parent, name } => Ok(emit_ok(http.post_json(
            "/api/library/folders/create",
            &json!({ "parent": parent, "name": name }),
        )?)),
        FolderCmd::Rename { path, name } => Ok(emit_ok(http.post_json(
            "/api/library/folders/rename",
            &json!({ "path": path, "name": name }),
        )?)),
        FolderCmd::Move { path, to } => Ok(emit_ok(http.post_json(
            "/api/library/folders/move",
            &json!({ "path": path, "dest_parent": to }),
        )?)),
        FolderCmd::Remove { path } => Ok(emit_ok(
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
        AccountCmd::List => Ok(emit_ok(http.get_value("/api/accounts")?)),
        AccountCmd::Login { platform } => Ok(emit_ok(
            http.post_json(&format!("/api/accounts/{platform}/login/qr"), &json!({}))?,
        )),
        AccountCmd::LoginStatus {
            platform,
            session,
            wait,
            timeout,
        } => {
            let state = if wait {
                wait_for_login(http, &platform, &session, timeout)?
            } else {
                http.get_value(&format!("/api/accounts/{platform}/login/qr/{session}"))?
            };
            Ok(emit_ok(state))
        }
        AccountCmd::Logout { platform } => Ok(emit_ok(
            http.post_json(&format!("/api/accounts/{platform}/logout"), &json!({}))?,
        )),
        AccountCmd::Playlists { platform } => Ok(emit_ok(
            http.get_value(&format!("/api/stream/playlists/{platform}"))?,
        )),
        AccountCmd::Playlist {
            platform,
            key,
            download,
            transfer,
        } => {
            if !download && has_download_options(&transfer) {
                bail!("account playlist 的下载参数必须和 --download 一起使用");
            }
            let resolved = http.post_json(
                "/api/stream/playlist",
                &json!({ "platform": platform, "key": key, "limit": 0 }),
            )?;
            if !download {
                return Ok(emit_ok(resolved));
            }
            let dest = resolve_dest(http, transfer.to.as_deref())?;
            let sources = resolved
                .get("sources")
                .cloned()
                .unwrap_or(Value::Array(vec![]));
            let tasks = enqueue(
                http,
                sources,
                dest,
                transfer.quality.as_deref(),
                transfer.no_analyze.then_some(false),
            )?;
            let mut result = run_download_flow(http, tasks, &transfer)?;
            result["playlist"] = resolved.get("title").cloned().unwrap_or(Value::Null);
            Ok(emit_ok(result))
        }
    }
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
        "binary": "kdj-app（应用包）/ kdj（设置页安装的 CLI 入口）",
        "handbook": "设置 → 让 AI 操作 KDJ → 复制 Prompt",
        "highlights": [
            "同一份已安装的 KDJ 二进制：有子命令当客户端，没有则驻留；未就绪拉起 --no-gui",
            "关窗不等于退出；kdj show 唤回主窗，kdj quit 真退出",
            "二维码登录：account login 返回 URL / PNG data URL；account login-status 可等待结果",
            "所有下载入口共享 --to / --quality / --no-analyze / --start / --wait / --timeout",
            "不加 --start/--wait 只返回待下载清单；--wait 自动开始并返回最终 paths",
            "下载 --to = 侧栏文件夹；先 download destinations 再下",
            "曲库写操作只有 move / forget / delete --yes；forget 不删磁盘",
            "搜索 --kind song|playlist|album|artist|radio；集合用同一条 collection，加 --download 才下载",
        ],
        "qr_login": {
            "platforms": ["wyy", "qqm", "bilibili"],
            "create": "account login --platform <PLATFORM>",
            "poll": "account login-status --platform <PLATFORM> --session <ID> [--wait]",
            "result": "wyy/bilibili 返回 url + image；qqm 返回 image + variants"
        },
        "download_flow": {
            "producers": ["search --download", "collection --download", "resolve --download", "account playlist --download"],
            "shared_options": ["--to", "--quality", "--no-analyze", "--start", "--wait", "--timeout"],
            "planned": "默认只入队；data.tasks 包含 title/platform/output_dir",
            "completed": "--wait 自动开始；data.paths 是最终本地绝对路径"
        },
        "commands": [
            "status", "show", "quit", "spec",
            "library list|get|stats|move|forget|delete|undo|scan|analyze",
            "search [--download --pick N]", "collection [--download]", "resolve [--download]",
            "download destinations|list|start|wait|cancel|cancel-all|retry|remove|clear",
            "mix next", "folder tree|create|rename|move|remove",
            "settings get|set",
            "account list|login|login-status|logout|playlists|playlist [--download]"
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
        // 空 dest_dir 是后端“使用任务入队时的默认下载目录”的稳定契约。
        // 把设置里的绝对路径重新传回去会被当成显式曲库目标；全新安装还没有
        // library root 时反而会拒绝默认目录。
        return Ok(String::new());
    }
    let dests = download_dests(http)?;
    let items = dests["items"].as_array().cloned().unwrap_or_default();
    if let Some(hit) = items.iter().find(|item| item["path"].as_str() == Some(to)) {
        if hit["id"].as_str() == Some("default") {
            return Ok(String::new());
        }
        return Ok(hit["path"].as_str().unwrap_or(to).to_string());
    }
    let named: Vec<_> = items
        .iter()
        .filter(|item| item["name"].as_str() == Some(to))
        .cloned()
        .collect();
    match named.len() {
        1 if named[0]["id"].as_str() == Some("default") => Ok(String::new()),
        1 => Ok(named[0]["path"].as_str().unwrap_or(to).to_string()),
        0 => Ok(to.to_string()),
        _ => bail!("文件夹名 {to} 不唯一，请改用 download destinations 里的绝对路径"),
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
        // CLI 的默认语义是“返回计划后等待显式开始”。即使界面
        // 设置里开了自动下载，这批任务也不能在 JSON 返回前抢跑。
        "hold": true,
    });
    if let Some(quality) = quality {
        body["quality"] = json!(quality);
    }
    if let Some(analyze) = analyze {
        body["analyze"] = json!(analyze);
    }
    http.post_json("/api/downloads", &body)
}

fn has_download_options(options: &DownloadFlowArgs) -> bool {
    options.to.is_some()
        || options.quality.is_some()
        || options.no_analyze
        || options.start
        || options.wait
        || options.timeout.is_some()
}

fn run_download_flow(http: &HttpClient, tasks: Value, options: &DownloadFlowArgs) -> Result<Value> {
    let ids = download_ids(&tasks)?;
    if ids.is_empty() {
        bail!("没有生成下载任务");
    }
    let started = options.start || options.wait;
    if started {
        http.post_json("/api/downloads/start", &json!({}))?;
    }
    let latest = if options.wait {
        wait_for_downloads(http, &ids, options.timeout.unwrap_or(3600))?
    } else if started {
        select_downloads(&http.get_value("/api/downloads")?, &ids)?
    } else {
        tasks
    };
    Ok(download_summary(latest, started, options.wait))
}

fn download_ids(tasks: &Value) -> Result<Vec<String>> {
    let items = tasks.as_array().context("下载接口没有返回任务数组")?;
    items
        .iter()
        .map(|task| {
            task["id"]
                .as_str()
                .map(str::to_string)
                .context("下载任务缺少 id")
        })
        .collect()
}

fn active_download_ids(tasks: &Value) -> Vec<String> {
    tasks
        .as_array()
        .into_iter()
        .flatten()
        .filter(|task| !download_terminal(task))
        .filter_map(|task| task["id"].as_str().map(str::to_string))
        .collect()
}

fn start_download_ids(tasks: &Value) -> Vec<String> {
    tasks
        .as_array()
        .into_iter()
        .flatten()
        // start 会同时放行 queued 任务并重试 failed 音频任务。
        // done/canceled 才是这次操作明确不会触及的记录。
        .filter(|task| !matches!(task["state"].as_str(), Some("done" | "canceled")))
        .filter_map(|task| task["id"].as_str().map(str::to_string))
        .collect()
}

fn select_downloads(tasks: &Value, ids: &[String]) -> Result<Value> {
    let items = tasks.as_array().context("下载列表不是数组")?;
    let selected = ids
        .iter()
        .filter_map(|id| {
            items
                .iter()
                .find(|task| task["id"].as_str() == Some(id.as_str()))
                .cloned()
        })
        .collect::<Vec<_>>();
    if selected.len() != ids.len() {
        let found = selected
            .iter()
            .filter_map(|task| task["id"].as_str())
            .collect::<Vec<_>>();
        bail!("部分下载任务已不在队列中；找到：{}", json!(found));
    }
    Ok(Value::Array(selected))
}

fn download_terminal(task: &Value) -> bool {
    matches!(
        task["state"].as_str(),
        Some("paused" | "done" | "failed" | "canceled")
    )
}

fn wait_for_downloads(http: &HttpClient, ids: &[String], timeout: u64) -> Result<Value> {
    if ids.is_empty() {
        return Ok(Value::Array(Vec::new()));
    }
    let deadline = Instant::now() + Duration::from_secs(timeout.max(1));
    loop {
        let selected = select_downloads(&http.get_value("/api/downloads")?, ids)?;
        if selected
            .as_array()
            .is_some_and(|items| items.iter().all(download_terminal))
        {
            return Ok(selected);
        }
        if Instant::now() >= deadline {
            bail!("等待下载超时；当前任务：{selected}");
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

fn download_summary(tasks: Value, started: bool, waited: bool) -> Value {
    let items = tasks.as_array().cloned().unwrap_or_default();
    let paths = items
        .iter()
        .filter_map(|task| task["path"].as_str())
        .filter(|path| !path.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    let failures = items
        .iter()
        .filter(|task| matches!(task["state"].as_str(), Some("failed" | "canceled")))
        .map(|task| {
            json!({
                "id": task.get("id"),
                "title": task.get("title"),
                "state": task.get("state"),
                "error": task.get("error"),
                "path": task.get("path"),
            })
        })
        .collect::<Vec<_>>();
    json!({
        "started": started,
        "waited": waited,
        "complete": items.iter().all(download_terminal),
        "tasks": items,
        "paths": paths,
        "failures": failures,
    })
}

fn wait_for_login(http: &HttpClient, platform: &str, session: &str, timeout: u64) -> Result<Value> {
    let path = format!("/api/accounts/{platform}/login/qr/{session}");
    let deadline = Instant::now() + Duration::from_secs(timeout.max(1));
    loop {
        let state = http.get_value(&path)?;
        if matches!(
            state["state"].as_str(),
            Some("done" | "expired" | "refused" | "error")
        ) {
            return Ok(state);
        }
        if Instant::now() >= deadline {
            bail!("等待扫码登录超时；当前状态：{state}");
        }
        std::thread::sleep(Duration::from_secs(1));
    }
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

fn pick_search_sources(search: &Value, picks: &[usize]) -> Result<Value> {
    let groups = search["groups"]
        .as_array()
        .context("搜索没有返回结果列表")?;
    if groups.is_empty() {
        bail!("没有可下载的搜索结果");
    }
    let picks = if picks.is_empty() { &[1][..] } else { picks };
    let mut seen = Vec::new();
    let mut sources = Vec::with_capacity(picks.len());
    for &pick in picks {
        if pick == 0 {
            bail!("--pick 从 1 开始");
        }
        if seen.contains(&pick) {
            bail!("--pick {pick} 重复");
        }
        seen.push(pick);
        let group = groups
            .get(pick - 1)
            .with_context(|| format!("--pick {pick} 超出搜索结果数 {}", groups.len()))?;
        let group_sources = group["sources"]
            .as_array()
            .with_context(|| format!("第 {pick} 条结果没有可用来源"))?;
        let best = group["best_source_index"].as_u64().unwrap_or(0) as usize;
        let source = group_sources
            .get(best)
            .with_context(|| format!("第 {pick} 条结果的最佳来源不存在"))?;
        sources.push(source.clone());
    }
    Ok(Value::Array(sources))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_summary_returns_final_paths_and_failures() {
        let summary = download_summary(
            json!([
                {
                    "id": "done-1",
                    "title": "Finished",
                    "state": "done",
                    "path": "/music/Finished.flac"
                },
                {
                    "id": "failed-1",
                    "title": "Broken",
                    "state": "failed",
                    "error": "upstream failed",
                    "path": ""
                }
            ]),
            true,
            true,
        );
        assert_eq!(summary["complete"], true);
        assert_eq!(summary["paths"], json!(["/music/Finished.flac"]));
        assert_eq!(summary["failures"][0]["id"], "failed-1");
    }

    #[test]
    fn start_tracks_queued_running_and_retryable_failed_tasks() {
        let ids = start_download_ids(&json!([
            {"id": "queued", "state": "queued"},
            {"id": "running", "state": "running"},
            {"id": "failed", "state": "failed"},
            {"id": "done", "state": "done"},
            {"id": "canceled", "state": "canceled"}
        ]));
        assert_eq!(ids, vec!["queued", "running", "failed"]);
    }

    #[test]
    fn search_download_uses_the_selected_groups_best_sources() {
        let search = json!({
            "groups": [
                {
                    "best_source_index": 1,
                    "sources": [
                        {"platform": "qqm", "key": "q1"},
                        {"platform": "wyy", "key": "w1"}
                    ]
                },
                {
                    "best_source_index": 0,
                    "sources": [{"platform": "wyy", "key": "w2"}]
                }
            ]
        });
        assert_eq!(
            pick_search_sources(&search, &[]).unwrap(),
            json!([{"platform": "wyy", "key": "w1"}])
        );
        assert_eq!(
            pick_search_sources(&search, &[2]).unwrap(),
            json!([{"platform": "wyy", "key": "w2"}])
        );
        assert!(pick_search_sources(&search, &[1, 1]).is_err());
    }
}
