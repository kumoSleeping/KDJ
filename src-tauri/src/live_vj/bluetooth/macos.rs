//! Small FFI boundary. Native handles never leave their creating worker/thread.
use super::*;
use std::{
    ffi::{c_char, c_void, CStr, CString},
    marker::PhantomData,
    rc::Rc,
};
unsafe extern "C" {
    fn kdj_bt_scan(inquiry: i32, error: *mut c_char, cap: usize) -> *mut c_char;
    fn kdj_bt_free_string(text: *mut c_char);
    fn kdj_bt_listen(error: *mut c_char, cap: usize) -> *mut c_void;
    fn kdj_bt_connect(address: *const c_char, error: *mut c_char, cap: usize) -> *mut c_void;
    fn kdj_bt_connect_poll(handle: *mut c_void, error: *mut c_char, cap: usize) -> i32;
    fn kdj_bt_listening(handle: *mut c_void) -> i32;
    fn kdj_bt_accept(handle: *mut c_void, peer: *mut c_char, cap: usize) -> *mut c_void;
    fn kdj_bt_read(handle: *mut c_void, bytes: *mut u8, cap: usize) -> i32;
    fn kdj_bt_write(handle: *mut c_void, bytes: *const u8, len: usize) -> i32;
    fn kdj_bt_flushed(handle: *mut c_void) -> i32;
    fn kdj_bt_close(handle: *mut c_void);
}
fn message(buffer: &[c_char]) -> String {
    // Native functions always terminate within the zero-initialized buffer.
    unsafe {
        CStr::from_ptr(buffer.as_ptr())
            .to_string_lossy()
            .into_owned()
    }
}
pub fn scan(inquiry: bool) -> Result<Vec<Device>> {
    let mut error = [0; 512];
    // Returned string is owned by this call; copy/parse then free even on failure.
    unsafe {
        let text = kdj_bt_scan(i32::from(inquiry), error.as_mut_ptr(), error.len());
        anyhow::ensure!(!text.is_null(), "{}", message(&error));
        let result = serde_json::from_slice(CStr::from_ptr(text).to_bytes());
        kdj_bt_free_string(text);
        Ok(result?)
    }
}
pub struct Native {
    handle: *mut c_void,
    _thread: PhantomData<Rc<()>>,
}
impl Drop for Native {
    fn drop(&mut self) {
        unsafe {
            kdj_bt_close(self.handle);
        }
    }
}
impl Native {
    fn wrap(handle: *mut c_void) -> Self {
        Self {
            handle,
            _thread: PhantomData,
        }
    }
    pub fn listen() -> Result<Self> {
        let mut error = [0; 512];
        let handle = unsafe { kdj_bt_listen(error.as_mut_ptr(), error.len()) };
        anyhow::ensure!(!handle.is_null(), "{}", message(&error));
        Ok(Self::wrap(handle))
    }
    pub fn connect(address: &str, cancel: &AtomicBool) -> Result<Self> {
        let address = CString::new(address)?;
        let mut error = [0; 512];
        let handle = unsafe { kdj_bt_connect(address.as_ptr(), error.as_mut_ptr(), error.len()) };
        anyhow::ensure!(!handle.is_null(), "{}", message(&error));
        let native = Self::wrap(handle);
        let started = Instant::now();
        loop {
            canceled(cancel)?;
            anyhow::ensure!(
                started.elapsed() < Duration::from_secs(15),
                "蓝牙连接超时，请确认对方已启动实时 VJ"
            );
            match unsafe { kdj_bt_connect_poll(handle, error.as_mut_ptr(), error.len()) } {
                1 => return Ok(native),
                -1 => bail!("{}", message(&error)),
                _ => (),
            }
        }
    }
    pub fn accept(&mut self) -> Result<Option<(Self, String)>> {
        anyhow::ensure!(
            unsafe { kdj_bt_listening(self.handle) } == 1,
            "蓝牙监听不可用，请检查蓝牙开关"
        );
        let mut peer = [0; 256];
        let handle = unsafe { kdj_bt_accept(self.handle, peer.as_mut_ptr(), peer.len()) };
        Ok((!handle.is_null()).then(|| (Self::wrap(handle), message(&peer))))
    }
    pub fn read(&mut self, bytes: &mut [u8]) -> Result<usize> {
        let count = unsafe { kdj_bt_read(self.handle, bytes.as_mut_ptr(), bytes.len()) };
        anyhow::ensure!(count >= 0, "蓝牙连接已断开");
        Ok(count as usize)
    }
    pub fn write(&mut self, mut bytes: &[u8], cancel: &AtomicBool) -> Result<()> {
        let started = Instant::now();
        loop {
            canceled(cancel)?;
            anyhow::ensure!(
                started.elapsed() < Duration::from_millis(750),
                "蓝牙发送积压，连接已停止"
            );
            let result = if bytes.is_empty() {
                unsafe { kdj_bt_flushed(self.handle) }
            } else {
                unsafe { kdj_bt_write(self.handle, bytes.as_ptr(), bytes.len()) }
            };
            anyhow::ensure!(result >= 0, "蓝牙发送失败或连接已断开");
            if bytes.is_empty() && result == 1 {
                return Ok(());
            }
            if !bytes.is_empty() {
                bytes = &bytes[result as usize..];
            }
        }
    }
}
