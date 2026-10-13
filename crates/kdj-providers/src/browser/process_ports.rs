//! Loopback TCP listener ownership, shared by browser authorization protocols.
use anyhow::Result;

#[cfg(target_os = "macos")]
pub(super) async fn listeners() -> Result<Vec<(u32, u16)>> {
    let output = tokio::process::Command::new("/usr/sbin/lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"])
        .output()
        .await?;
    let mut pid = None;
    let mut result = Vec::new();
    for line in std::str::from_utf8(&output.stdout)?.lines() {
        if let Some(value) = line.strip_prefix('p') {
            pid = value.parse::<u32>().ok();
        } else if let Some(port) = line
            .strip_prefix("n127.0.0.1:")
            .and_then(|value| value.parse::<u16>().ok())
        {
            if let Some(pid) = pid {
                result.push((pid, port));
            }
        }
    }
    Ok(result)
}

#[cfg(target_os = "windows")]
pub(super) async fn listeners() -> Result<Vec<(u32, u16)>> {
    #[link(name = "iphlpapi")]
    unsafe extern "system" {
        fn GetExtendedTcpTable(
            table: *mut std::ffi::c_void,
            size: *mut u32,
            order: i32,
            family: u32,
            class: u32,
            reserved: u32,
        ) -> u32;
    }
    // TCP_TABLE_OWNER_PID_LISTENER, AF_INET; DWORD header followed by 6-DWORD rows.
    let mut size = 0;
    unsafe {
        GetExtendedTcpTable(std::ptr::null_mut(), &mut size, 0, 2, 3, 0);
    }
    for _ in 0..4 {
        anyhow::ensure!(
            (4..=16 * 1024 * 1024).contains(&size),
            "无法读取浏览器授权端口"
        );
        let mut table = vec![0u32; (size as usize).div_ceil(4)];
        let status =
            unsafe { GetExtendedTcpTable(table.as_mut_ptr().cast(), &mut size, 0, 2, 3, 0) };
        if status == 122 {
            continue;
        } // Table grew between size query and read.
        anyhow::ensure!(status == 0, "无法读取浏览器授权端口");
        return windows_listeners(&table, size as usize);
    }
    anyhow::bail!("浏览器授权端口正在变化，请重试")
}

#[cfg(any(windows, test))]
fn windows_listeners(table: &[u32], bytes: usize) -> Result<Vec<(u32, u16)>> {
    anyhow::ensure!(
        bytes >= 4 && bytes / 4 <= table.len(),
        "浏览器授权端口表无效"
    );
    let count = table[0] as usize;
    anyhow::ensure!(count <= (bytes / 4 - 1) / 6, "浏览器授权端口表无效");
    Ok(table[1..1 + count * 6]
        .chunks_exact(6)
        .filter_map(|row| {
            let port = u16::from_be(row[2] as u16);
            (row[0] == 2 && row[1].to_ne_bytes() == [127, 0, 0, 1] && port != 0 && row[5] != 0)
                .then_some((row[5], port))
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[tokio::test]
    async fn native_listener_table_identifies_real_loopback_owner() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(listeners().await.unwrap().contains(&(std::process::id(), port)));
    }

    #[test]
    fn windows_table_accepts_only_bounded_loopback_listener_rows() {
        let row = [
            2,
            u32::from_ne_bytes([127, 0, 0, 1]),
            43210u16.to_be() as u32,
            0,
            0,
            123,
        ];
        let mut table = vec![1];
        table.extend(row);
        assert_eq!(windows_listeners(&table, 28).unwrap(), vec![(123, 43210)]);
        assert!(windows_listeners(&table, 24).is_err());
        table[2] = 0;
        assert!(windows_listeners(&table, 28).unwrap().is_empty());
        assert!(windows_listeners(&[], 0).is_err());
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(super) async fn listeners() -> Result<Vec<(u32, u16)>> {
    anyhow::bail!("当前系统尚不支持此浏览器授权")
}
