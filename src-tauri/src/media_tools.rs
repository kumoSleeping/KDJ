//! Native installation entry points: local imports always originate in a file picker.
use kdj_providers::ffmpeg::managed::{self, InstallProgress, InstallSource};
use serde::Deserialize;
use tauri_plugin_dialog::DialogExt;

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallAction {
    Download,
    #[serde(alias = "zip")]
    Archive,
    Folder,
}

#[tauri::command]
pub fn media_tools_progress() -> InstallProgress {
    managed::progress()
}

#[tauri::command]
pub async fn install_media_tools(
    app: tauri::AppHandle,
    action: InstallAction,
) -> Result<bool, String> {
    if !cfg!(any(windows, target_os = "macos")) {
        return Err("当前平台不支持此安装方式".into());
    }
    let source = match action {
        InstallAction::Download => InstallSource::Download,
        InstallAction::Archive => {
            let (tx, rx) = tokio::sync::oneshot::channel();
            app.dialog()
                .file()
                .set_title("选择 FFmpeg 工具包（可多选）")
                .add_filter("FFmpeg 压缩包", &["zip", "7z"])
                .pick_files(move |picked| {
                    let _ = tx.send(picked);
                });
            let picked = rx.await.map_err(|_| "无法打开文件选择窗口".to_string())?;
            let Some(picked) = picked else {
                return Ok(false);
            };
            if picked.is_empty() {
                return Ok(false);
            }
            let paths = picked
                .into_iter()
                .map(|file| file.into_path().map_err(|error| error.to_string()))
                .collect::<Result<Vec<_>, _>>()?;
            InstallSource::Archive(paths)
        }
        InstallAction::Folder => {
            let (tx, rx) = tokio::sync::oneshot::channel();
            app.dialog()
                .file()
                .set_title("选择 FFmpeg 工具文件夹")
                .pick_folder(move |picked| {
                    let _ = tx.send(picked);
                });
            let picked = rx.await.map_err(|_| "无法打开文件选择窗口".to_string())?;
            let Some(picked) = picked else {
                return Ok(false);
            };
            InstallSource::Folder(picked.into_path().map_err(|error| error.to_string())?)
        }
    };
    managed::start(source).map_err(|error| format!("{error:#}"))?;
    Ok(true)
}
