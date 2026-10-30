use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use clap::{CommandFactory, Parser};
use serde_json::{json, Value};

use super::args::{Cli, Commands, LibraryCmd, VisualizerCmd};
use super::http::HttpClient;
use super::{runtime, CliError};

const QR_PLATFORMS: [&str; 3] = ["wyy", "qqm", "bilibili"];
const BROWSER_PLATFORMS: [&str; 3] = ["youtube", "ytm", "soundcloud"];
const POLL: Duration = Duration::from_millis(500);

/// `kdj status` 里唯一的说明文字。命令和参数从 clap 生成，这里只写 clap 表达不了的约定。
const NOTES: [&str; 8] = [
    "输出都是一行 JSON：成功 {\"ok\":true,\"data\":…}；失败 {\"ok\":false,\"error\":{\"code\",\"message\"}}，code 为 usage / not_found / ambiguous / failed。退出码：0 成功，2 usage，其余失败 1。",
    "search 的结果和 status 的 playlists 都带 ref：把 ref 交给 download 下载，或交给 search 展开歌单、专辑、歌手。ref 存在 KDJ 内存里，KDJ 重启后请重新 search；bilibili:BV…[:pN] 与 youtube:<id> 这类视频 ref 随时可用。",
    "download 默认下到 download.default_dir，--to 可以换成曲库根目录（download.library_roots）里任意一个已存在的文件夹。download 和 login 会一直运行到结束才输出。整张歌单或长视频可能要好几分钟，请放到后台运行或调大命令超时；中断命令就会取消。",
    "下载完成后 KDJ 自动入库并分析。移动、改名、删除、整理文件请直接用你自己的文件工具；放进 download.library_roots 下的文件会被 KDJ 自动跟上。",
    "library get 缺少分析时会当场补齐再返回（可能要几十秒）；时间单位都是秒，grid.downbeats 是小节线。",
    "peek 把截图存成 JPEG 文件并返回路径（多张时另有一张按时间顺序拼好的 sheet），用你看图片的工具打开即可；截图只用来核对画面内容，判断不了音画是否同步。",
    "扫码登录会在用户屏幕上打开二维码图片，请让用户用对应 App 扫码；youtube / ytm / soundcloud 从本机浏览器导入登录状态，需要用户先在该浏览器里登录。",
    "除了 KDJ，也可以结合你自己的网络搜索或浏览器工具寻找素材，再把链接交给 search 或 download。",
];

pub fn run() -> i32 {
    attach_windows_console();
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(err) if err.exit_code() == 0 => {
            // --help / --version
            let _ = err.print();
            return 0;
        }
        Err(err) => {
            // clap 的报错：说明行之后是缺了哪些参数，到 Usage 为止。
            let rendered = err.render().to_string();
            let message = rendered
                .lines()
                .take_while(|line| !line.starts_with("Usage:") && !line.starts_with("For more"))
                .map(str::trim)
                .filter(|line| !line.is_empty() && !line.starts_with("tip:"))
                .collect::<Vec<_>>()
                .join(" ");
            let message = message.trim_start_matches("error: ");
            return emit_err(&CliError::new("usage", message), Some("运行 kdj status 查看用法"));
        }
    };
    match run_inner(cli) {
        Ok(()) => 0,
        Err(err) => match err.downcast_ref::<CliError>() {
            Some(coded) => emit_err(coded, None),
            None => emit_err(&CliError::new("failed", format!("{err:#}")), None),
        },
    }
}

fn run_inner(cli: Cli) -> Result<()> {
    if let Commands::Status = cli.command {
        emit_ok(status(cli.data_dir.as_deref(), cli.url.as_deref()));
        return Ok(());
    }
    let runtime = runtime::ensure_running(cli.data_dir.as_deref(), cli.url.as_deref())?;
    let http = HttpClient::new(&runtime.base_url, &runtime.auth_token)?;
    let data = match cli.command {
        Commands::Status => unreachable!(),
        Commands::Search {
            text,
            kind,
            platform,
            limit,
        } => http.post_json(
            "/api/cli/search",
            &json!({ "text": text, "kind": kind, "platforms": platform, "limit": limit }),
        )?,
        Commands::Download {
            refs,
            to,
            quality,
            as_kind,
            height,
        } => download(&http, refs, to, quality, as_kind, height)?,
        Commands::Login {
            platform,
            browser,
            profile,
        } => login(&http, &platform, browser, profile)?,
        Commands::Peek {
            source,
            at,
            every,
            width,
        } => {
            let at = at.iter().map(|t| parse_time(t)).collect::<Result<Vec<_>>>()?;
            http.post_json_long(
                "/api/cli/peek",
                &json!({ "source": media_arg(&source), "at": at, "every": every, "width": width }),
            )?
        }
        Commands::Library { command } => library(&http, command)?,
        Commands::Visualizer { command } => match command {
            VisualizerCmd::Render { id, out, width, height } => http.post_json_long(
                "/api/visualizer/render",
                &json!({ "track_id": id, "output_path": absolute(&out), "width": width, "height": height }),
            )?,
        },
    };
    emit_ok(data);
    Ok(())
}

// ---------------------------------------------------------------- status

fn status(data_dir: Option<&Path>, url: Option<&str>) -> Value {
    let invocation = std::env::current_exe()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|_| "kdj".into());
    let mut doc = json!({
        "cli": { "version": kdj_core::VERSION, "path": invocation },
        "commands": usage(),
        "notes": NOTES,
    });
    let running = runtime::find_running(data_dir, url);
    let Some(info) = running else {
        doc["running"] = json!(false);
        doc["hint"] = json!("KDJ 没在运行；除 status 外的命令会自动在后台启动它。");
        return doc;
    };
    doc["running"] = json!(true);
    let live = HttpClient::new(&info.base_url, &info.auth_token)
        .and_then(|http| Ok((http.get_value("/api/health")?, http.get_value("/api/cli/status")?)));
    match live {
        Ok((health, live)) => {
            let version = health["version"].as_str().unwrap_or_default().to_string();
            doc["kdj"] = json!({ "version": version, "matches_cli": version == kdj_core::VERSION });
            if let Value::Object(fields) = live {
                for (key, value) in fields {
                    doc[key] = value;
                }
            }
        }
        Err(err) => doc["error"] = json!(format!("{err:#}")),
    }
    doc
}

/// 从 clap 定义生成命令清单，说明永远和实际参数一致。
fn usage() -> Vec<Value> {
    let root = Cli::command();
    let mut out = Vec::new();
    for command in root.get_subcommands() {
        collect_usage(command, "kdj", &mut out);
    }
    out
}

fn collect_usage(command: &clap::Command, prefix: &str, out: &mut Vec<Value>) {
    let name = format!("{prefix} {}", command.get_name());
    if command.has_subcommands() {
        for sub in command.get_subcommands() {
            collect_usage(sub, &name, out);
        }
        return;
    }
    let mut line = name;
    let mut options = serde_json::Map::new();
    for arg in command.get_arguments() {
        if arg.is_hide_set() || matches!(arg.get_id().as_str(), "help" | "version") {
            continue;
        }
        let help = arg.get_help().map(|h| h.to_string()).unwrap_or_default();
        let values: Vec<String> = arg
            .get_possible_values()
            .iter()
            .map(|value| value.get_name().to_string())
            .collect();
        let value_name = arg
            .get_value_names()
            .and_then(|names| names.first())
            .map(|name| name.to_string())
            .unwrap_or_else(|| arg.get_id().as_str().to_ascii_uppercase());
        if arg.is_positional() {
            let many = matches!(arg.get_action(), clap::ArgAction::Append);
            line.push_str(&format!(" <{value_name}>{}", if many { "..." } else { "" }));
            options.insert(format!("<{value_name}>"), json!(help));
            continue;
        }
        let long = arg.get_long().unwrap_or_default();
        let takes_value = arg.get_action().takes_values();
        let flag = match (takes_value, values.is_empty()) {
            (false, _) => format!("--{long}"),
            (true, true) => format!("--{long} <{value_name}>"),
            (true, false) => format!("--{long} {}", values.join("|")),
        };
        let default = arg
            .get_default_values()
            .first()
            .map(|value| format!("（默认 {}）", value.to_string_lossy()))
            .unwrap_or_default();
        options.insert(flag, json!(format!("{help}{default}")));
    }
    let mut entry = json!({
        "usage": line,
        "about": command.get_about().map(|a| a.to_string()).unwrap_or_default(),
    });
    if !options.is_empty() {
        entry["options"] = Value::Object(options);
    }
    out.push(entry);
}

// ---------------------------------------------------------------- download

fn download(
    http: &HttpClient,
    refs: Vec<String>,
    to: Option<String>,
    quality: Option<String>,
    as_kind: Option<String>,
    height: Option<i64>,
) -> Result<Value> {
    let to = to.map(|dir| absolute(&dir)).unwrap_or_default();
    let result = http.post_ndjson(
        "/api/cli/download",
        &json!({ "refs": refs, "to": to, "quality": quality, "as": as_kind, "height": height }),
    )?;
    if result["event"] != "result" {
        return Err(CliError::new("failed", "KDJ 在下载结束前断开了连接").into());
    }
    Ok(json!({ "complete": result["complete"], "items": result["items"] }))
}

/// 曲库 id 和引用原样交给 KDJ；本地存在的相对路径换成绝对路径。
fn media_arg(source: &str) -> String {
    if source.parse::<i64>().is_err() && Path::new(source).exists() {
        absolute(source)
    } else {
        source.to_string()
    }
}

/// 秒、分:秒 或 时:分:秒。
fn parse_time(text: &str) -> Result<f64> {
    let usage = || anyhow::Error::from(CliError::new("usage", format!("时间无效：{text}")));
    text.trim()
        .split(':')
        .try_fold(0.0, |total, part| {
            part.trim().parse::<f64>().map(|value| total * 60.0 + value)
        })
        .ok()
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or_else(usage)
}

fn absolute(path: &str) -> String {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        return path.display().to_string();
    }
    std::env::current_dir()
        .map(|dir| dir.join(&path))
        .unwrap_or(path)
        .display()
        .to_string()
}

// ---------------------------------------------------------------- login

fn login(
    http: &HttpClient,
    platform: &str,
    browser: Option<String>,
    profile: Option<String>,
) -> Result<Value> {
    // 指定了 --browser 就从浏览器导入，哪个平台支持由 KDJ 判断；否则扫码平台扫码。
    if browser.is_none() && QR_PLATFORMS.contains(&platform) {
        return qr_login(http, platform);
    }
    if browser.is_some() || BROWSER_PLATFORMS.contains(&platform) {
        let browser = match browser {
            Some(browser) => browser,
            None => only_browser(http, platform)?,
        };
        let request_id = format!("cli-{:016x}", rand::random::<u64>());
        let account = http.post_json(
            &format!("/api/accounts/{platform}/login/browser"),
            &json!({ "browser": browser, "profile": profile, "request_id": request_id }),
        )?;
        return Ok(json!({ "platform": platform, "state": "done", "account": brief_account(&account) }));
    }
    Err(CliError::new(
        "usage",
        format!("不支持的平台：{platform}；可用 {} / {}", QR_PLATFORMS.join(" "), BROWSER_PLATFORMS.join(" ")),
    )
    .into())
}

/// 没指定 --browser 时，本机只有一个浏览器才替用户选；否则列出候选。
fn only_browser(http: &HttpClient, platform: &str) -> Result<String> {
    let catalog = http.get_value(&format!("/api/accounts/{platform}/login/browsers"))?;
    let browsers: Vec<Value> = catalog["browsers"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|browser| browser["profiles"].as_array().is_some_and(|p| !p.is_empty()))
        .collect();
    if let [only] = browsers.as_slice() {
        if let Some(id) = only["id"].as_str() {
            return Ok(id.to_string());
        }
    }
    let mut error = CliError::new("usage", "请用 --browser 指定从哪个浏览器导入登录状态");
    error.candidates = Some(json!(browsers
        .iter()
        .map(|b| json!({ "browser": b["id"], "label": b["label"], "profiles": b["profiles"] }))
        .collect::<Vec<_>>()));
    Err(error.into())
}

fn qr_login(http: &HttpClient, platform: &str) -> Result<Value> {
    let session = http.post_json(&format!("/api/accounts/{platform}/login/qr"), &json!({}))?;
    let session_id = session["session_id"].as_str().context("扫码会话缺少 id")?.to_string();
    let mut images: Vec<(String, String)> = session["variants"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| Some((v["label"].as_str()?.to_string(), v["image"].as_str()?.to_string())))
        .collect();
    if images.is_empty() {
        images.push((platform.to_string(), session["image"].as_str().unwrap_or_default().to_string()));
    }
    let files: Vec<PathBuf> = images
        .iter()
        .filter_map(|(label, image)| write_qr(platform, label, image).ok())
        .collect();
    let Some(first) = files.first() else {
        return Err(CliError::new("failed", "没有拿到二维码图片").into());
    };
    open_file(first);
    eprintln!("二维码已在屏幕上打开：{}", first.display());
    let path = format!("/api/accounts/{platform}/login/qr/{session_id}");
    let state = loop {
        let state = http.get_value(&path)?;
        if matches!(state["state"].as_str(), Some("done" | "expired" | "refused" | "error")) {
            break state;
        }
        std::thread::sleep(Duration::from_secs(1));
    };
    for file in &files {
        let _ = std::fs::remove_file(file);
    }
    let value = state["state"].as_str().unwrap_or_default();
    if value != "done" {
        let message = state["message"].as_str().filter(|m| !m.is_empty()).unwrap_or(value);
        return Err(CliError::new("failed", format!("扫码登录未完成：{message}")).into());
    }
    Ok(json!({ "platform": platform, "state": "done", "account": brief_account(&state["account"]) }))
}

fn write_qr(platform: &str, label: &str, data_url: &str) -> Result<PathBuf> {
    use base64::Engine as _;
    let encoded = data_url.split_once(',').map(|(_, b)| b).unwrap_or(data_url);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .context("二维码图片无效")?;
    let safe: String = label
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    let path = std::env::temp_dir().join(format!("kdj-login-{platform}-{safe}.png"));
    std::fs::write(&path, bytes).context("写二维码图片失败")?;
    Ok(path)
}

/// 用系统默认看图程序打开，用户才能在屏幕上扫码；失败不影响等待。
fn open_file(path: &Path) {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(path).spawn();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", ""])
            .arg(path)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = std::process::Command::new("xdg-open").arg(path).spawn();
}

fn brief_account(account: &Value) -> Value {
    json!({
        "platform": account.get("platform"),
        "state": account.get("state"),
        "nickname": account.get("nickname"),
    })
}

// ---------------------------------------------------------------- library

fn library(http: &HttpClient, command: LibraryCmd) -> Result<Value> {
    match command {
        LibraryCmd::List {
            q,
            key,
            bpm,
            energy,
            folder,
            limit,
            offset,
        } => {
            let (bpm_min, bpm_max) = parse_bpm(bpm.as_deref())?;
            let mut pairs: Vec<(String, String)> = vec![
                ("limit".into(), limit.to_string()),
                ("offset".into(), offset.to_string()),
            ];
            let mut push = |name: &str, value: Option<String>| {
                if let Some(value) = value {
                    pairs.push((name.into(), value));
                }
            };
            push("q", q);
            push("key", key);
            push("bpm_min", bpm_min.map(|v| v.to_string()));
            push("bpm_max", bpm_max.map(|v| v.to_string()));
            push("energy_min", energy.map(|v| v.to_string()));
            if let Some(folder) = folder {
                push("folder", Some(absolute(&folder)));
                push("folder_deep", Some("true".into()));
            }
            let page = http.get_query("/api/library/tracks", &pairs)?;
            Ok(json!({
                "items": page["items"].as_array().into_iter().flatten().map(brief_track).collect::<Vec<_>>(),
                "total": page.get("total"),
                "offset": page.get("offset"),
                "limit": page.get("limit"),
            }))
        }
        LibraryCmd::Get { id, path, q, beats } => {
            let ids = if !id.is_empty() {
                id
            } else if let Some(path) = path {
                vec![track_by_path(http, &absolute(&path))?]
            } else if let Some(q) = q {
                vec![track_by_text(http, &q)?]
            } else {
                return Err(CliError::new("usage", "需要 --id、--path 或 --q").into());
            };
            let tracks = analyzed_tracks(http, &ids)?;
            let items: Vec<Value> = tracks
                .iter()
                .map(|(track, rhythm)| full_track(track, rhythm, beats))
                .collect();
            Ok(if items.len() == 1 {
                items.into_iter().next().unwrap()
            } else {
                json!({ "items": items })
            })
        }
        LibraryCmd::Add { path } => {
            let folder = absolute(&path);
            if !Path::new(&folder).is_dir() {
                return Err(CliError::new("not_found", format!("不是文件夹：{folder}")).into());
            }
            // The same import as 添加文件夹: the songs come in, and the folder becomes a root
            // once the import has gone through.
            let scan = http.post_json("/api/library/scan", &json!({ "paths": [folder], "recursive": true }))?;
            Ok(json!({ "folder": folder, "job_id": scan.get("job_id") }))
        }
    }
}

/// 精确路径：用文件名缩小范围，再按完整路径比对。曲库的文本搜索不匹配目录部分。
fn track_by_path(http: &HttpClient, path: &str) -> Result<i64> {
    let name = Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let page = http.get_query(
        "/api/library/tracks",
        &[("q".to_string(), name), ("limit".to_string(), "200".to_string())],
    )?;
    page["items"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|item| item["path"].as_str() == Some(path))
        .and_then(|item| item["id"].as_i64())
        .ok_or_else(|| CliError::new("not_found", format!("曲库里没有这个文件：{path}")).into())
}

fn track_by_text(http: &HttpClient, q: &str) -> Result<i64> {
    let page = http.get_query(
        "/api/library/tracks",
        &[("q".to_string(), q.to_string()), ("limit".to_string(), "8".to_string())],
    )?;
    let items = page["items"].as_array().cloned().unwrap_or_default();
    match items.as_slice() {
        [] => Err(CliError::new("not_found", format!("没有匹配：{q}")).into()),
        [only] => only["id"].as_i64().context("曲目没有 id"),
        many => {
            let mut error = CliError::new("ambiguous", format!("匹配不唯一（{} 首），请改用 --id", many.len()));
            error.candidates = Some(json!(many
                .iter()
                .map(|item| json!({ "id": item["id"], "title": item["title"], "artist": item["artist"], "path": item["path"] }))
                .collect::<Vec<_>>()));
            Err(error.into())
        }
    }
}

/// 缺分析的曲目当场插队分析（基础分析 + 节拍网格），全部有结果或失败后返回。
/// 中断命令只是不再等待；已经开始的分析照常在 KDJ 里跑完。
fn analyzed_tracks(http: &HttpClient, ids: &[i64]) -> Result<Vec<(Value, Value)>> {
    let mut pending_basic = Vec::new();
    let mut pending_grid = Vec::new();
    for &id in ids {
        let track = http.get_value(&format!("/api/library/tracks/{id}"))?;
        // A `.kdjv` project an earlier build put in the library is not sound to analyse.
        if track["format"].as_str().is_some_and(|f| f.eq_ignore_ascii_case("kdjv")) {
            continue;
        }
        if !analyzed(&track) {
            let queued = http.post_json(
                "/api/library/analyze",
                &json!({ "track_ids": [id], "priority": true, "version": "v1" }),
            )?;
            if queued["queued"].as_u64().unwrap_or(0) > 0 {
                pending_basic.push(id);
            }
        }
        let rhythm = http.get_value(&format!("/api/library/rhythm/{id}"))?;
        if rhythm["analysis"].is_null() {
            let started = http.post_json(&format!("/api/library/rhythm/{id}"), &json!({}))?;
            if started["queued"].as_u64().unwrap_or(0) > 0 || !started["job_id"].is_null() {
                pending_grid.push(id);
            }
        }
    }
    while !pending_basic.is_empty() || !pending_grid.is_empty() {
        std::thread::sleep(POLL);
        let mut still = Vec::new();
        for id in pending_basic {
            if !analyzed(&http.get_value(&format!("/api/library/tracks/{id}"))?) {
                still.push(id);
            }
        }
        pending_basic = still;
        let mut still = Vec::new();
        for id in pending_grid {
            let rhythm = http.get_value(&format!("/api/library/rhythm/{id}"))?;
            let phase = rhythm["status"]["phase"].as_str().unwrap_or_default();
            if rhythm["analysis"].is_null() && matches!(phase, "queued" | "analyzing") {
                still.push(id);
            }
        }
        pending_grid = still;
    }
    ids.iter()
        .map(|&id| {
            Ok((
                http.get_value(&format!("/api/library/tracks/{id}"))?,
                http.get_value(&format!("/api/library/rhythm/{id}"))?,
            ))
        })
        .collect()
}

fn analyzed(track: &Value) -> bool {
    track["analyzed_at"].as_str().is_some_and(|s| !s.is_empty())
        || track["analysis_error"].as_str().is_some_and(|s| !s.is_empty())
}

fn seconds(values: &Value) -> Vec<f64> {
    values
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_f64)
        .map(|t| (t * 1000.0).round() / 1000.0)
        .collect()
}

fn full_track(track: &Value, rhythm: &Value, beats: bool) -> Value {
    let mut item = brief_track(track);
    for field in ["album", "music_key", "comment", "tags", "cue_points"] {
        item[field] = track[field].clone();
    }
    if let Some(platform) = track["source_platform"].as_str().filter(|p| !p.is_empty()) {
        item["source"] = json!({ "platform": platform, "key": track["source_key"] });
    }
    if let Some(error) = track["analysis_error"].as_str().filter(|e| !e.is_empty()) {
        item["analysis_error"] = json!(error);
    }
    let analysis = &rhythm["analysis"];
    item["grid"] = if analysis.is_null() {
        if let Some(error) = rhythm["status"]["error"].as_str().filter(|e| !e.is_empty()) {
            item["grid_error"] = json!(error);
        }
        Value::Null
    } else {
        let mut grid = json!({
            "bpm": analysis["bpm"],
            "confidence": analysis["confidence"],
            "downbeat_confidence": analysis["downbeat_confidence"],
            "downbeats": seconds(&analysis["downbeats"]),
            "segments": analysis["segments"].as_array().into_iter().flatten().map(|s| json!({
                "start": s["start_seconds"], "end": s["end_seconds"], "bpm": s["bpm"],
            })).collect::<Vec<_>>(),
        });
        if beats {
            grid["beats"] = json!(seconds(&analysis["beats"]));
        }
        grid
    };
    item
}

fn brief_track(track: &Value) -> Value {
    json!({
        "id": track.get("id"),
        "title": track.get("title"),
        "artist": track.get("artist"),
        "duration": track.get("duration"),
        "bpm": track.get("bpm"),
        "key": track.get("camelot"),
        "energy": track.get("energy"),
        "rating": track.get("rating"),
        "path": track.get("path"),
        "folder": track.get("folder"),
        "analyzed": track.get("analyzed_at").and_then(Value::as_str).is_some_and(|s| !s.is_empty()),
    })
}

fn parse_bpm(raw: Option<&str>) -> Result<(Option<f64>, Option<f64>)> {
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok((None, None));
    };
    let parse = |text: &str| {
        text.trim()
            .parse::<f64>()
            .map_err(|_| anyhow::Error::from(CliError::new("usage", format!("--bpm 无效：{raw}"))))
    };
    if let Some((lo, hi)) = raw.split_once("..") {
        return Ok((Some(parse(lo)?), Some(parse(hi)?)));
    }
    let value = parse(raw)?;
    Ok((Some(value), Some(value)))
}

// ---------------------------------------------------------------- output

fn emit_ok(data: Value) {
    println!("{}", json!({ "ok": true, "data": data }));
}

fn emit_err(error: &CliError, hint: Option<&str>) -> i32 {
    let mut body = json!({ "code": error.code, "message": error.message });
    if let Some(hint) = hint {
        body["hint"] = json!(hint);
    }
    if let Some(candidates) = &error.candidates {
        body["candidates"] = candidates.clone();
    }
    println!("{}", json!({ "ok": false, "error": body }));
    if error.code == "usage" {
        2
    } else {
        1
    }
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
    fn usage_lists_every_command_with_its_options() {
        let commands = usage();
        let lines: Vec<&str> = commands.iter().filter_map(|c| c["usage"].as_str()).collect();
        assert_eq!(
            lines,
            vec![
                "kdj status",
                "kdj search <TEXT>",
                "kdj download <REF>...",
                "kdj login <PLATFORM>",
                "kdj peek <SOURCE>",
                "kdj library list",
                "kdj library get",
                "kdj library add <PATH>",
                "kdj visualizer render <ID>",
            ]
        );
        let download = &commands[2]["options"];
        assert!(download.get("--as audio|video").is_some(), "{download}");
        assert!(download.get("--to <DIR>").is_some(), "{download}");
        assert!(commands[1]["options"]["--kind song|playlist|album|artist|radio"]
            .as_str()
            .unwrap()
            .contains("默认 song"));
        // 隐藏的调试参数不进说明
        assert!(!commands.iter().any(|c| c.to_string().contains("--data-dir")));
    }

    #[test]
    fn full_track_keeps_downbeats_and_beats_only_on_request() {
        let track = json!({ "id": 1, "title": "t", "analyzed_at": "now", "source_platform": "" });
        let rhythm = json!({ "analysis": {
            "bpm": 128.0, "confidence": 0.9, "downbeat_confidence": 0.8,
            "beats": [0.1234, 0.5921], "downbeats": [0.1234],
            "segments": [{ "start_seconds": 0.0, "end_seconds": 1.0, "bpm": 128.0, "confidence": 1.0 }],
        }});
        let item = full_track(&track, &rhythm, false);
        assert_eq!(item["grid"]["downbeats"], json!([0.123]));
        assert!(item["grid"].get("beats").is_none());
        assert!(item.get("source").is_none());
        assert_eq!(full_track(&track, &rhythm, true)["grid"]["beats"], json!([0.123, 0.592]));
    }

    #[test]
    fn times_accept_seconds_and_clock_forms() {
        assert_eq!(parse_time("75.5").unwrap(), 75.5);
        assert_eq!(parse_time("1:30").unwrap(), 90.0);
        assert_eq!(parse_time("1:02:03").unwrap(), 3723.0);
        assert_eq!(parse_time("soon").unwrap_err().downcast_ref::<CliError>().unwrap().code, "usage");
    }

    #[test]
    fn bpm_ranges_parse_or_fail_as_usage() {
        assert_eq!(parse_bpm(Some("124..130")).unwrap(), (Some(124.0), Some(130.0)));
        let err = parse_bpm(Some("fast")).unwrap_err();
        assert_eq!(err.downcast_ref::<CliError>().unwrap().code, "usage");
    }
}
