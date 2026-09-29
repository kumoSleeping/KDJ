//! 测试专用：统计一段代码在当前线程上的峰值分配字节数。
//!
//! 不是 crate。要用的 crate 在 lib.rs 里写
//! `#[cfg(test)] #[path = "../../test-support/peak_alloc.rs"] mod peak_alloc;`，
//! 它的测试二进制就以这里的计数分配器作为全局分配器。只记当前线程，并行跑的其它测试
//! 不会混进来。

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

struct PeakAlloc;

thread_local! {
    static LIVE_BYTES: Cell<isize> = const { Cell::new(0) };
    static PEAK_BYTES: Cell<isize> = const { Cell::new(0) };
}

fn count(delta: isize) {
    // 线程退出时 TLS 已销毁，那之后的分配不记
    let _ = LIVE_BYTES.try_with(|live| {
        live.set(live.get() + delta);
        let _ = PEAK_BYTES.try_with(|peak| peak.set(peak.get().max(live.get())));
    });
}

unsafe impl GlobalAlloc for PeakAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count(layout.size() as isize);
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        count(layout.size() as isize);
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        count(-(layout.size() as isize));
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        count(size as isize - layout.size() as isize);
        unsafe { System.realloc(ptr, layout, size) }
    }
}

#[global_allocator]
static ALLOCATOR: PeakAlloc = PeakAlloc;

/// `f` 执行期间，当前线程相对进入时多出的峰值分配字节数。
pub(crate) fn peak_allocated<T>(f: impl FnOnce() -> T) -> (T, usize) {
    let base = LIVE_BYTES.with(Cell::get);
    PEAK_BYTES.with(|peak| peak.set(base));
    let out = f();
    let peak = PEAK_BYTES.with(Cell::get) - base;
    (out, peak.max(0) as usize)
}
