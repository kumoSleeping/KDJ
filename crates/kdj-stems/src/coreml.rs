//! Native fixed-shape SCNet Small Core ML runtime for Apple Silicon.

use std::ffi::{c_char, c_void, CString};
use std::path::Path;

use anyhow::{bail, Context, Result};

use crate::dsp::{MODEL_INPUT_ELEMENTS, MODEL_OUTPUT_ELEMENTS};
use crate::runtime::RuntimeInfo;

const ERROR_CAPACITY: usize = 2_048;

unsafe extern "C" {
    fn kdj_scnet_coreml_load(
        path: *const c_char,
        error: *mut c_char,
        error_capacity: usize,
    ) -> *mut c_void;
    fn kdj_scnet_coreml_predict(
        handle: *mut c_void,
        input: *const f32,
        input_count: usize,
        output: *mut f32,
        output_count: usize,
        error: *mut c_char,
        error_capacity: usize,
    ) -> i32;
    fn kdj_scnet_coreml_free(handle: *mut c_void);
}

pub(crate) struct CoreMlEngine {
    handle: *mut c_void,
}

impl CoreMlEngine {
    pub(crate) fn load(path: &Path) -> Result<Self> {
        if !path.join("Manifest.json").is_file() {
            bail!("SCNet Core ML package is incomplete: {}", path.display());
        }
        let path = CString::new(path.to_string_lossy().as_bytes())
            .context("SCNet Core ML path contains a NUL byte")?;
        let mut error = vec![0i8; ERROR_CAPACITY];
        // SAFETY: `path` and the writable error buffer remain alive for the duration of the call.
        let handle =
            unsafe { kdj_scnet_coreml_load(path.as_ptr(), error.as_mut_ptr(), error.len()) };
        if handle.is_null() {
            bail!("load SCNet Core ML: {}", error_message(&error));
        }
        let mut engine = Self { handle };
        engine.warmup()?;
        Ok(engine)
    }

    pub(crate) fn predict(&mut self, input: &[f32]) -> Result<Vec<f32>> {
        if input.len() != MODEL_INPUT_ELEMENTS {
            bail!(
                "SCNet input elements {} != {MODEL_INPUT_ELEMENTS}",
                input.len()
            );
        }
        let mut output = vec![0.0f32; MODEL_OUTPUT_ELEMENTS];
        let mut error = vec![0i8; ERROR_CAPACITY];
        // SAFETY: the native handle is owned by `self`; all buffers are correctly sized and remain
        // valid until synchronous prediction returns. One Rust worker serializes calls per handle.
        let status = unsafe {
            kdj_scnet_coreml_predict(
                self.handle,
                input.as_ptr(),
                input.len(),
                output.as_mut_ptr(),
                output.len(),
                error.as_mut_ptr(),
                error.len(),
            )
        };
        if status != 0 {
            bail!(
                "SCNet Core ML prediction failed ({status}): {}",
                error_message(&error)
            );
        }
        if output.iter().any(|value| !value.is_finite()) {
            bail!("SCNet Core ML output contains non-finite samples");
        }
        Ok(output)
    }

    pub(crate) fn info(&self) -> RuntimeInfo {
        RuntimeInfo {
            runtime: "Core ML".into(),
            provider: "Apple GPU".into(),
        }
    }

    fn warmup(&mut self) -> Result<()> {
        let silence = vec![0.0f32; MODEL_INPUT_ELEMENTS];
        let _ = self
            .predict(&silence)
            .context("SCNet Core ML warmup failed")?;
        Ok(())
    }
}

impl Drop for CoreMlEngine {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            // SAFETY: this handle came from `kdj_scnet_coreml_load` and is released exactly once.
            unsafe { kdj_scnet_coreml_free(self.handle) };
            self.handle = std::ptr::null_mut();
        }
    }
}

fn error_message(buffer: &[i8]) -> String {
    let bytes = buffer
        .iter()
        .take_while(|byte| **byte != 0)
        .map(|byte| *byte as u8)
        .collect::<Vec<_>>();
    String::from_utf8_lossy(&bytes).into_owned()
}
