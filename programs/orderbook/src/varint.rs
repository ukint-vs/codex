use alloc::vec::Vec;

/// Helper for writing Varint (LEB128-like) encoded data to a buffer.
pub struct VarintWriter {
    pub buf: Vec<u8>,
}

impl VarintWriter {
    pub fn new() -> Self {
        Self {
            buf: Vec::with_capacity(2048),
        }
    }

    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            buf: Vec::with_capacity(capacity),
        }
    }

    /// Writes a u128 using LEB128 encoding.
    pub fn write_u128(&mut self, mut value: u128) {
        loop {
            if value < 0x80 {
                self.buf.push(value as u8);
                break;
            } else {
                self.buf.push((value as u8) | 0x80);
                value >>= 7;
            }
        }
    }

    /// Writes a u64 using LEB128 encoding.
    pub fn write_u64(&mut self, mut value: u64) {
        loop {
            if value < 0x80 {
                self.buf.push(value as u8);
                break;
            } else {
                self.buf.push((value as u8) | 0x80);
                value >>= 7;
            }
        }
    }

    /// Writes a raw byte slice (e.g. for fixed size fields like Address)
    pub fn write_bytes(&mut self, data: &[u8]) {
        self.buf.extend_from_slice(data);
    }
}
