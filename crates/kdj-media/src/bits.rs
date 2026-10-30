//! Bit-level reading and writing for codec headers (H.264 SPS, AAC configs).

use anyhow::{bail, Result};

pub struct BitReader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> BitReader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    pub fn position(&self) -> usize {
        self.pos
    }

    pub fn remaining(&self) -> usize {
        (self.data.len() * 8).saturating_sub(self.pos)
    }

    pub fn bit(&mut self) -> Result<u32> {
        let Some(byte) = self.data.get(self.pos / 8) else { bail!("码流提前结束") };
        let bit = (byte >> (7 - self.pos % 8)) & 1;
        self.pos += 1;
        Ok(bit as u32)
    }

    pub fn bits(&mut self, count: u32) -> Result<u32> {
        let mut value = 0;
        for _ in 0..count {
            value = value << 1 | self.bit()?;
        }
        Ok(value)
    }

    pub fn flag(&mut self) -> Result<bool> {
        Ok(self.bit()? == 1)
    }

    /// Exp-Golomb `ue(v)`.
    pub fn ue(&mut self) -> Result<u32> {
        let mut zeros = 0;
        while self.bit()? == 0 {
            zeros += 1;
            if zeros > 31 {
                bail!("码流里的 Exp-Golomb 值过长");
            }
        }
        Ok(((1u64 << zeros) - 1 + self.bits(zeros)? as u64) as u32)
    }

    /// Exp-Golomb `se(v)`.
    pub fn se(&mut self) -> Result<i32> {
        let value = self.ue()? as i64;
        Ok(if value % 2 == 1 { (value + 1) / 2 } else { -(value / 2) } as i32)
    }
}

#[derive(Default)]
pub struct BitWriter {
    data: Vec<u8>,
    bits: usize,
}

impl BitWriter {
    pub fn bit(&mut self, bit: u32) {
        if self.bits % 8 == 0 {
            self.data.push(0);
        }
        if bit & 1 == 1 {
            *self.data.last_mut().unwrap() |= 1 << (7 - self.bits % 8);
        }
        self.bits += 1;
    }

    pub fn bits(&mut self, value: u32, count: u32) {
        for shift in (0..count).rev() {
            self.bit(value >> shift);
        }
    }

    #[cfg(test)]
    pub fn ue(&mut self, value: u32) {
        let coded = value as u64 + 1;
        let length = 64 - coded.leading_zeros();
        self.bits(0, length - 1);
        for shift in (0..length).rev() {
            self.bit((coded >> shift) as u32);
        }
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.data
    }
}

/// NAL payload → RBSP: drops each `03` of a `00 00 03` emulation prevention sequence.
pub fn unescape(nal: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(nal.len());
    let mut zeros = 0;
    for &byte in nal {
        if zeros >= 2 && byte == 3 {
            zeros = 0;
            continue;
        }
        zeros = if byte == 0 { zeros + 1 } else { 0 };
        out.push(byte);
    }
    out
}

/// RBSP → NAL payload: inserts `03` wherever a start code could otherwise appear.
pub fn escape(rbsp: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(rbsp.len() + 8);
    let mut zeros = 0;
    for &byte in rbsp {
        if zeros >= 2 && byte <= 3 {
            out.push(3);
            zeros = 0;
        }
        zeros = if byte == 0 { zeros + 1 } else { 0 };
        out.push(byte);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exp_golomb_round_trips() {
        let mut writer = BitWriter::default();
        for value in [0, 1, 2, 3, 7, 8, 255, 65_535] {
            writer.ue(value);
        }
        writer.bits(1, 1);
        let bytes = writer.into_bytes();
        let mut reader = BitReader::new(&bytes);
        for value in [0, 1, 2, 3, 7, 8, 255, 65_535] {
            assert_eq!(reader.ue().unwrap(), value);
        }
    }

    #[test]
    fn emulation_prevention_round_trips() {
        let rbsp = [0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x05, 0x00, 0x00];
        let nal = escape(&rbsp);
        assert_eq!(nal, [0x00, 0x00, 0x03, 0x01, 0x00, 0x00, 0x03, 0x00, 0x05, 0x00, 0x00]);
        assert_eq!(unescape(&nal), rbsp);
    }
}
