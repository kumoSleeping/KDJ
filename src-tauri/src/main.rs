// release 构建不要再挂一个控制台窗口（Windows 专属，其他平台无效）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    kdj_app_lib::run()
}
