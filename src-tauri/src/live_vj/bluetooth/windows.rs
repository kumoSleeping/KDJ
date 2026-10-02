//! Windows' classic BR/EDR socket API; no virtual COM port or BLE peripheral role.
use super::*;
use std::{
    mem::{size_of, zeroed},
    ptr::null_mut,
    sync::OnceLock,
};
use windows_sys::{
    core::GUID,
    Win32::{
        Devices::Bluetooth::*,
        Foundation::{CloseHandle, GetLastError, ERROR_NO_MORE_ITEMS},
        Networking::WinSock::*,
    },
};
const SERVICE: GUID = GUID::from_u128(0x7c45d810_4e7b_4ac6_9b8f_8532744b444a);
fn initialize() -> Result<()> {
    static INIT: OnceLock<i32> = OnceLock::new();
    let result = *INIT.get_or_init(|| unsafe {
        let mut data = zeroed();
        WSAStartup(0x0202, &mut data)
    });
    anyhow::ensure!(result == 0, "初始化蓝牙 Socket 失败：{result}");
    Ok(())
}
fn check(result: i32) -> Result<()> {
    anyhow::ensure!(
        result != SOCKET_ERROR,
        "蓝牙操作失败（Windows {}）",
        unsafe { WSAGetLastError() }
    );
    Ok(())
}
fn address(value: u64) -> String {
    (0..6)
        .rev()
        .map(|i| format!("{:02X}", (value >> (i * 8)) & 255))
        .collect::<Vec<_>>()
        .join(":")
}
fn parse_address(value: &str) -> Result<u64> {
    let compact = value.replace([':', '-'], "");
    anyhow::ensure!(
        compact.len() == 12 && compact.bytes().all(|b| b.is_ascii_hexdigit()),
        "蓝牙设备地址无效"
    );
    Ok(u64::from_str_radix(&compact, 16)?)
}
pub fn scan(inquiry: bool) -> Result<Vec<Device>> {
    // All structures are initialized with the ABI-required size; returned handles
    // are closed on every path. Inquiry runs off the UI thread and is bounded.
    unsafe {
        let params = BLUETOOTH_FIND_RADIO_PARAMS {
            dwSize: size_of::<BLUETOOTH_FIND_RADIO_PARAMS>() as u32,
        };
        let mut radio = null_mut();
        let radios = BluetoothFindFirstRadio(&params, &mut radio);
        anyhow::ensure!(!radios.is_null(), "蓝牙未开启或没有可用适配器");
        CloseHandle(radio);
        BluetoothFindRadioClose(radios);
        let params = BLUETOOTH_DEVICE_SEARCH_PARAMS {
            dwSize: size_of::<BLUETOOTH_DEVICE_SEARCH_PARAMS>() as u32,
            fReturnAuthenticated: 1,
            fReturnRemembered: 1,
            fReturnUnknown: i32::from(inquiry),
            fReturnConnected: 1,
            fIssueInquiry: i32::from(inquiry),
            cTimeoutMultiplier: 5,
            hRadio: null_mut(),
        };
        let mut info: BLUETOOTH_DEVICE_INFO = zeroed();
        info.dwSize = size_of::<BLUETOOTH_DEVICE_INFO>() as u32;
        let find = BluetoothFindFirstDevice(&params, &mut info);
        if find.is_null() {
            let error = GetLastError();
            anyhow::ensure!(
                error == ERROR_NO_MORE_ITEMS,
                "蓝牙扫描失败（Windows {error}）"
            );
            return Ok(Vec::new());
        }
        let mut devices = Vec::new();
        loop {
            let id = address(info.Address.Anonymous.ullLong);
            let end = info
                .szName
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(info.szName.len());
            let name = String::from_utf16_lossy(&info.szName[..end]);
            devices.push(Device {
                name: if name.is_empty() { id.clone() } else { name },
                id,
                paired: info.fAuthenticated != 0,
            });
            if BluetoothFindNextDevice(find, &mut info) == 0 {
                break;
            }
        }
        let error = GetLastError();
        BluetoothFindDeviceClose(find);
        anyhow::ensure!(
            error == ERROR_NO_MORE_ITEMS,
            "蓝牙扫描中断（Windows {error}）"
        );
        Ok(devices)
    }
}
pub struct Native {
    socket: SOCKET,
    published: bool,
}
impl Native {
    fn create() -> Result<Self> {
        initialize()?;
        unsafe {
            let socket = socket(AF_BTH as i32, SOCK_STREAM, BTHPROTO_RFCOMM as i32);
            anyhow::ensure!(
                socket != INVALID_SOCKET,
                "无法创建 RFCOMM Socket，请检查蓝牙适配器和驱动"
            );
            let native = Self {
                socket,
                published: false,
            };
            let enabled: u32 = 1;
            for option in [SO_BTH_AUTHENTICATE, SO_BTH_ENCRYPT] {
                check(setsockopt(
                    socket,
                    SOL_RFCOMM as i32,
                    option as i32,
                    (&enabled as *const u32).cast(),
                    4,
                ))?;
            }
            let mut nonblocking = 1;
            check(ioctlsocket(socket, FIONBIO, &mut nonblocking))?;
            Ok(native)
        }
    }
    fn registration(&self, operation: WSAESETSERVICEOP) -> Result<()> {
        unsafe {
            let mut local: SOCKADDR_BTH = zeroed();
            let mut length = size_of::<SOCKADDR_BTH>() as i32;
            check(getsockname(
                self.socket,
                (&mut local as *mut SOCKADDR_BTH).cast(),
                &mut length,
            ))?;
            let mut addresses: CSADDR_INFO = zeroed();
            addresses.LocalAddr = SOCKET_ADDRESS {
                lpSockaddr: (&mut local as *mut SOCKADDR_BTH).cast(),
                iSockaddrLength: length,
            };
            addresses.RemoteAddr = addresses.LocalAddr;
            addresses.iSocketType = SOCK_STREAM;
            addresses.iProtocol = BTHPROTO_RFCOMM as i32;
            let mut uuid = SERVICE;
            let mut name: Vec<u16> = "KDJ Audio Features\0".encode_utf16().collect();
            let mut query: WSAQUERYSETW = zeroed();
            query.dwSize = size_of::<WSAQUERYSETW>() as u32;
            query.lpszServiceInstanceName = name.as_mut_ptr();
            query.lpServiceClassId = &mut uuid;
            query.dwNameSpace = NS_BTH;
            query.dwNumberOfCsAddrs = 1;
            query.lpcsaBuffer = &mut addresses;
            check(WSASetServiceW(&query, operation, 0))
        }
    }
    pub fn listen() -> Result<Self> {
        let mut native = Self::create()?;
        unsafe {
            let mut local: SOCKADDR_BTH = zeroed();
            local.addressFamily = AF_BTH;
            local.port = u32::MAX;
            check(bind(
                native.socket,
                (&local as *const SOCKADDR_BTH).cast(),
                size_of::<SOCKADDR_BTH>() as i32,
            ))?;
            check(listen(native.socket, 1))?;
        }
        native.registration(RNRSERVICE_REGISTER)?;
        native.published = true;
        Ok(native)
    }
    pub fn connect(id: &str, cancel: &AtomicBool) -> Result<Self> {
        let remote = parse_address(id)?;
        let native = Self::create()?;
        unsafe {
            let mut info: BLUETOOTH_DEVICE_INFO = zeroed();
            info.dwSize = size_of::<BLUETOOTH_DEVICE_INFO>() as u32;
            info.Address.Anonymous.ullLong = remote;
            anyhow::ensure!(
                BluetoothGetDeviceInfo(null_mut(), &mut info) == 0 && info.fAuthenticated != 0,
                "请先在系统蓝牙设置中配对这两台电脑，再开始发送"
            );
            let target = SOCKADDR_BTH {
                addressFamily: AF_BTH,
                btAddr: remote,
                serviceClassId: SERVICE,
                port: 0,
            };
            if connect(
                native.socket,
                (&target as *const SOCKADDR_BTH).cast(),
                size_of::<SOCKADDR_BTH>() as i32,
            ) == 0
            {
                return Ok(native);
            }
            let error = WSAGetLastError();
            anyhow::ensure!(
                error == WSAEWOULDBLOCK || error == WSAEINPROGRESS,
                "蓝牙连接失败（Windows {error}），请确认对方已启动实时 VJ"
            );
        }
        let start = Instant::now();
        loop {
            canceled(cancel)?;
            anyhow::ensure!(start.elapsed() < Duration::from_secs(15), "蓝牙连接超时");
            // select is supported by the Bluetooth Winsock provider; unlike
            // WSAPoll it also reports a failed nonblocking connect explicitly.
            unsafe {
                let mut write: FD_SET = zeroed();
                write.fd_count = 1;
                write.fd_array[0] = native.socket;
                let mut errors = write;
                let timeout = TIMEVAL {
                    tv_sec: 0,
                    tv_usec: 20_000,
                };
                let count = select(0, null_mut(), &mut write, &mut errors, &timeout);
                check(count)?;
                if count > 0 {
                    anyhow::ensure!(
                        errors.fd_count == 0 && write.fd_count > 0,
                        "蓝牙连接被拒绝，请确认对方已启动实时 VJ"
                    );
                    return Ok(native);
                }
            }
        }
    }
    pub fn accept(&mut self) -> Result<Option<(Self, String)>> {
        unsafe {
            let mut remote: SOCKADDR_BTH = zeroed();
            let mut len = size_of::<SOCKADDR_BTH>() as i32;
            let socket = accept(
                self.socket,
                (&mut remote as *mut SOCKADDR_BTH).cast(),
                &mut len,
            );
            if socket == INVALID_SOCKET {
                let error = WSAGetLastError();
                if error == WSAEWOULDBLOCK {
                    return Ok(None);
                }
                bail!("蓝牙接收失败（Windows {error}）");
            }
            let native = Self {
                socket,
                published: false,
            };
            let mut nonblocking = 1;
            check(ioctlsocket(socket, FIONBIO, &mut nonblocking))?;
            Ok(Some((native, address(remote.btAddr))))
        }
    }
    pub fn read(&mut self, bytes: &mut [u8]) -> Result<usize> {
        unsafe {
            let count = recv(self.socket, bytes.as_mut_ptr(), bytes.len() as i32, 0);
            if count == SOCKET_ERROR && WSAGetLastError() == WSAEWOULDBLOCK {
                return Ok(0);
            }
            check(count)?;
            anyhow::ensure!(count != 0, "蓝牙连接已断开");
            Ok(count as usize)
        }
    }
    pub fn write(&mut self, mut bytes: &[u8], cancel: &AtomicBool) -> Result<()> {
        let start = Instant::now();
        while !bytes.is_empty() {
            canceled(cancel)?;
            anyhow::ensure!(
                start.elapsed() < Duration::from_millis(750),
                "蓝牙发送积压，连接已停止"
            );
            unsafe {
                let count = send(self.socket, bytes.as_ptr(), bytes.len() as i32, 0);
                if count == SOCKET_ERROR && WSAGetLastError() == WSAEWOULDBLOCK {
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                }
                check(count)?;
                anyhow::ensure!(count > 0, "蓝牙连接已断开");
                bytes = &bytes[count as usize..];
            }
        }
        Ok(())
    }
}
impl Drop for Native {
    fn drop(&mut self) {
        if self.published {
            if let Err(error) = self.registration(RNRSERVICE_DELETE) {
                tracing::warn!(%error, "移除蓝牙服务失败");
            }
        }
        unsafe {
            closesocket(self.socket);
        }
    }
}
