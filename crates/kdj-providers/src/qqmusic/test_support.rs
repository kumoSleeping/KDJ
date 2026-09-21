//! Loopback-only fault injection; never reads a user's session or contacts QQ.
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

pub struct TempRoot(pub std::path::PathBuf);
impl TempRoot {
    pub fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("kdj-qq-fault-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
#[derive(Clone)]
pub struct Request {
    pub body: Value,
    pub cookie: String,
}
pub struct Reply {
    pub status: u16,
    pub body: Value,
    pub delay: Duration,
}
impl Reply {
    pub fn data(data: Value) -> Self {
        Self::raw(200, json!({"code":0,"req_0":{"code":0,"data":data}}))
    }
    pub fn raw(status: u16, body: Value) -> Self {
        Self {
            status,
            body,
            delay: Duration::ZERO,
        }
    }
    pub fn delayed(mut self, millis: u64) -> Self {
        self.delay = Duration::from_millis(millis);
        self
    }
}
pub struct MockHttp {
    pub url: String,
    pub requests: Arc<Mutex<Vec<Request>>>,
    stopped: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl MockHttp {
    pub fn new(reply: impl Fn(&Request, usize) -> Reply + Send + 'static) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!(
            "http://{}/cgi-bin/musicu.fcg",
            listener.local_addr().unwrap()
        );
        let requests = Arc::new(Mutex::new(Vec::new()));
        let saved = requests.clone();
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = stopped.clone();
        let thread = std::thread::spawn(move || {
            while !stop.load(Ordering::Acquire) {
                let (mut socket, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(_) => break,
                };
                // BSD/macOS may inherit O_NONBLOCK from the listening socket. The fixture
                // intentionally uses blocking read_exact; WouldBlock must not masquerade as a CDN fault.
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                socket
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut headers = Vec::new();
                let mut byte = [0u8; 1];
                while headers.len() < 32 * 1024 && !headers.ends_with(b"\r\n\r\n") {
                    if socket.read_exact(&mut byte).is_err() {
                        break;
                    }
                    headers.push(byte[0]);
                }
                let headers = String::from_utf8_lossy(&headers);
                let field = |name: &str| {
                    headers.lines().find_map(|line| {
                        line.split_once(':')
                            .filter(|(key, _)| key.eq_ignore_ascii_case(name))
                            .map(|(_, value)| value.trim().to_string())
                    })
                };
                let length = field("content-length")
                    .and_then(|s| s.parse::<usize>().ok())
                    .unwrap_or(0)
                    .min(2 * 1024 * 1024);
                let mut body = vec![0; length];
                if socket.read_exact(&mut body).is_err() {
                    continue;
                }
                let body: Value = match serde_json::from_slice(&body) {
                    Ok(body) => body,
                    Err(_) => continue,
                };
                if body.get("req_0").is_none() {
                    continue;
                }
                let request = Request {
                    body,
                    cookie: field("cookie").unwrap_or_default(),
                };
                let index = {
                    let mut saved = saved.lock().unwrap();
                    let index = saved.len();
                    saved.push(request.clone());
                    index
                };
                let response = reply(&request, index);
                std::thread::sleep(response.delay);
                let bytes = response.body.to_string();
                let _ = write!(socket,"HTTP/1.1 {} Mock\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.status,bytes.len(),bytes);
            }
        });
        Self {
            url,
            requests,
            stopped,
            thread: Some(thread),
        }
    }
    pub async fn wait_for_request(&self) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while self.requests.lock().unwrap().is_empty() {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .unwrap();
    }
}
impl Drop for MockHttp {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let result = thread.join();
            if !std::thread::panicking() {
                result.unwrap();
            }
        }
    }
}
