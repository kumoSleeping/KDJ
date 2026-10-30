//! ISO BMFF box building and walking.

use anyhow::{ensure, Result};

/// Big-endian payload builder.
#[derive(Default)]
pub struct BoxBuf(pub Vec<u8>);

impl BoxBuf {
    pub fn u8(&mut self, value: u8) {
        self.0.push(value);
    }
    pub fn u16(&mut self, value: u16) {
        self.0.extend_from_slice(&value.to_be_bytes());
    }
    pub fn u32(&mut self, value: u32) {
        self.0.extend_from_slice(&value.to_be_bytes());
    }
    pub fn u64(&mut self, value: u64) {
        self.0.extend_from_slice(&value.to_be_bytes());
    }
    pub fn i32(&mut self, value: i32) {
        self.0.extend_from_slice(&value.to_be_bytes());
    }
    pub fn bytes(&mut self, value: &[u8]) {
        self.0.extend_from_slice(value);
    }
}

pub fn mp4_box(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 8);
    out.extend_from_slice(&(payload.len() as u32 + 8).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(payload);
    out
}

pub fn full_box(kind: &[u8; 4], version: u8, flags: u32, payload: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(payload.len() + 4);
    body.extend_from_slice(&(((version as u32) << 24) | (flags & 0x00ff_ffff)).to_be_bytes());
    body.extend_from_slice(payload);
    mp4_box(kind, &body)
}

/// A child box inside a parent's payload.
pub struct Child<'a> {
    pub kind: [u8; 4],
    pub payload: &'a [u8],
    /// The whole box, header included.
    pub raw: &'a [u8],
}

/// The boxes directly inside `data`.
pub fn children(data: &[u8]) -> Result<Vec<Child<'_>>> {
    let mut out = Vec::new();
    let mut pos = 0;
    while pos + 8 <= data.len() {
        let size32 = u32::from_be_bytes(data[pos..pos + 4].try_into().unwrap()) as u64;
        let kind: [u8; 4] = data[pos + 4..pos + 8].try_into().unwrap();
        let (header, size) = match size32 {
            0 => (8, (data.len() - pos) as u64),
            1 => {
                ensure!(pos + 16 <= data.len(), "MP4 box 头不完整");
                (16, u64::from_be_bytes(data[pos + 8..pos + 16].try_into().unwrap()))
            }
            size => (8, size),
        };
        ensure!(size >= header as u64 && pos as u64 + size <= data.len() as u64, "MP4 box 长度越界：{}", String::from_utf8_lossy(&kind));
        let end = pos + size as usize;
        out.push(Child { kind, payload: &data[pos + header..end], raw: &data[pos..end] });
        pos = end;
    }
    Ok(out)
}

pub fn child<'a>(data: &'a [u8], kind: &[u8; 4]) -> Result<Option<Child<'a>>> {
    Ok(children(data)?.into_iter().find(|c| &c.kind == kind))
}

/// Big-endian reader over a box payload.
pub struct Cursor<'a> {
    data: &'a [u8],
    pub pos: usize,
}

impl<'a> Cursor<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }
    fn take(&mut self, count: usize) -> Result<&'a [u8]> {
        ensure!(self.pos + count <= self.data.len(), "MP4 box 内容不完整");
        let out = &self.data[self.pos..self.pos + count];
        self.pos += count;
        Ok(out)
    }
    pub fn skip(&mut self, count: usize) -> Result<()> {
        self.take(count).map(|_| ())
    }
    pub fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    pub fn u16(&mut self) -> Result<u16> {
        Ok(u16::from_be_bytes(self.take(2)?.try_into().unwrap()))
    }
    pub fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }
    pub fn i32(&mut self) -> Result<i32> {
        Ok(i32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }
    pub fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_be_bytes(self.take(8)?.try_into().unwrap()))
    }
    pub fn i64(&mut self) -> Result<i64> {
        Ok(i64::from_be_bytes(self.take(8)?.try_into().unwrap()))
    }
    pub fn bytes(&mut self, count: usize) -> Result<&'a [u8]> {
        self.take(count)
    }
    pub fn rest(&self) -> &'a [u8] {
        &self.data[self.pos..]
    }
    pub fn left(&self) -> usize {
        self.data.len() - self.pos
    }
    /// Version and flags of a full box.
    pub fn version_flags(&mut self) -> Result<(u8, u32)> {
        let word = self.u32()?;
        Ok(((word >> 24) as u8, word & 0x00ff_ffff))
    }
}
