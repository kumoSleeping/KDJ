// release 构建不要再挂一个控制台窗口（Windows 专属，其他平台无效）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        match kdj_app_lib::cli::launch_mode() {
            kdj_app_lib::Launch::Client => std::process::exit(kdj_app_lib::cli::run_client()),
            kdj_app_lib::Launch::App { no_gui } => kdj_app_lib::set_no_gui(no_gui),
        }
    }
    kdj_app_lib::run();
}
