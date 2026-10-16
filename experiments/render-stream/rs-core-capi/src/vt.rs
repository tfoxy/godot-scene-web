//! A small tagged encoding of a Godot Variant tree. The core builds the Dictionaries and Arrays the
//! receiver reads (the transaction meta, needed(), apply_state()'s stats) and the parameter values
//! RenderingServer receives, and the C++ shim turns each into a real Variant (ints stay ints, keys
//! keep their insertion order). Little-endian throughout:
//!
//! | tag | value |
//! | --- | ----- |
//! | 0 | nil |
//! | 1 | bool: u8 |
//! | 2 | int: i64 |
//! | 3 | float: f64 |
//! | 4 | String: u32 length, UTF-8 |
//! | 5 | Array: u32 count, values |
//! | 6 | Dictionary: u32 count, (u32 key length, UTF-8 key, value) pairs; String keys |
//! | 7 | math builtin: u8 Variant type, u8 count, count x 8 bytes (f64, or i64 for the integer types) |
//! | 8 | packed array: u8 Variant type, u32 element count, count x components x 8 bytes (f64, or i64 for the integer arrays) |
//! | 9 | RID: u32 RidRef word (ops.rs) |
//! | 10 | PackedStringArray: u32 count, (u32 length, UTF-8) |

use crate::ops::RidRef;

pub const T_NIL: u8 = 0;
pub const T_BOOL: u8 = 1;
pub const T_INT: u8 = 2;
pub const T_FLOAT: u8 = 3;
pub const T_STRING: u8 = 4;
pub const T_ARRAY: u8 = 5;
pub const T_DICT: u8 = 6;
pub const T_MATH: u8 = 7;
pub const T_PACKED: u8 = 8;
pub const T_RID: u8 = 9;
pub const T_PACKED_STRINGS: u8 = 10;

/// GDExtensionVariantType numbers (core/extension/gdextension_interface.h).
pub mod gd {
    pub const VECTOR2: u8 = 5;
    pub const VECTOR2I: u8 = 6;
    pub const RECT2: u8 = 7;
    pub const RECT2I: u8 = 8;
    pub const VECTOR3: u8 = 9;
    pub const VECTOR3I: u8 = 10;
    pub const TRANSFORM2D: u8 = 11;
    pub const VECTOR4: u8 = 12;
    pub const VECTOR4I: u8 = 13;
    pub const PLANE: u8 = 14;
    pub const QUATERNION: u8 = 15;
    pub const AABB: u8 = 16;
    pub const BASIS: u8 = 17;
    pub const TRANSFORM3D: u8 = 18;
    pub const PROJECTION: u8 = 19;
    pub const COLOR: u8 = 20;
    pub const PACKED_INT32_ARRAY: u8 = 30;
    pub const PACKED_INT64_ARRAY: u8 = 31;
    pub const PACKED_FLOAT32_ARRAY: u8 = 32;
    pub const PACKED_FLOAT64_ARRAY: u8 = 33;
    pub const PACKED_VECTOR2_ARRAY: u8 = 35;
    pub const PACKED_VECTOR3_ARRAY: u8 = 36;
    pub const PACKED_COLOR_ARRAY: u8 = 37;
    pub const PACKED_VECTOR4_ARRAY: u8 = 38;
}

/// A writer. Containers are written count-first, so callers either know the count up front
/// ([`Vt::array`], [`Vt::dict`]) or reserve it and patch it ([`Vt::begin_array`] /
/// [`Vt::end_array`]).
#[derive(Default, Debug, Clone)]
pub struct Vt {
    pub out: Vec<u8>,
}

impl Vt {
    pub fn new() -> Vt {
        Vt { out: Vec::new() }
    }
    pub fn clear(&mut self) {
        self.out.clear();
    }
    fn u32(&mut self, v: u32) {
        self.out.extend_from_slice(&v.to_le_bytes());
    }
    fn raw_str(&mut self, s: &str) {
        self.u32(s.len() as u32);
        self.out.extend_from_slice(s.as_bytes());
    }
    pub fn nil(&mut self) {
        self.out.push(T_NIL);
    }
    pub fn bool(&mut self, v: bool) {
        self.out.push(T_BOOL);
        self.out.push(v as u8);
    }
    pub fn int(&mut self, v: i64) {
        self.out.push(T_INT);
        self.out.extend_from_slice(&v.to_le_bytes());
    }
    pub fn float(&mut self, v: f64) {
        self.out.push(T_FLOAT);
        self.out.extend_from_slice(&v.to_le_bytes());
    }
    pub fn str(&mut self, s: &str) {
        self.out.push(T_STRING);
        self.raw_str(s);
    }
    pub fn opt_str(&mut self, s: Option<&str>) {
        match s {
            Some(s) => self.str(s),
            None => self.nil(),
        }
    }
    pub fn opt_int(&mut self, v: Option<i64>) {
        match v {
            Some(v) => self.int(v),
            None => self.nil(),
        }
    }
    pub fn rid(&mut self, r: RidRef) {
        self.out.push(T_RID);
        self.u32(r.word());
    }
    /// An Array of `n` values the caller writes next.
    pub fn array(&mut self, n: usize) {
        self.out.push(T_ARRAY);
        self.u32(n as u32);
    }
    /// A Dictionary of `n` entries; write each with [`Vt::key`] then its value.
    pub fn dict(&mut self, n: usize) {
        self.out.push(T_DICT);
        self.u32(n as u32);
    }
    pub fn key(&mut self, k: &str) {
        self.raw_str(k);
    }
    /// Starts an Array whose count is patched by [`Vt::end_array`]; returns the patch position.
    pub fn begin_array(&mut self) -> usize {
        self.out.push(T_ARRAY);
        let at = self.out.len();
        self.u32(0);
        at
    }
    pub fn end_array(&mut self, at: usize, n: usize) {
        self.out[at..at + 4].copy_from_slice(&(n as u32).to_le_bytes());
    }
    pub fn strings(&mut self, values: &[&str]) {
        self.out.push(T_PACKED_STRINGS);
        self.u32(values.len() as u32);
        for v in values {
            self.raw_str(v);
        }
    }
    /// A math builtin from float components.
    pub fn math_f(&mut self, ty: u8, values: &[f64]) {
        self.out.push(T_MATH);
        self.out.push(ty);
        self.out.push(values.len() as u8);
        for v in values {
            self.out.extend_from_slice(&v.to_le_bytes());
        }
    }
    /// A math builtin from integer components (Vector2i, Rect2i, Vector3i, Vector4i).
    pub fn math_i(&mut self, ty: u8, values: &[i64]) {
        self.out.push(T_MATH);
        self.out.push(ty);
        self.out.push(values.len() as u8);
        for v in values {
            self.out.extend_from_slice(&v.to_le_bytes());
        }
    }
    /// A packed array of `count` elements; `values` holds count x components f64.
    pub fn packed_f(&mut self, ty: u8, count: usize, values: &[f64]) {
        self.out.push(T_PACKED);
        self.out.push(ty);
        self.u32(count as u32);
        for v in values {
            self.out.extend_from_slice(&v.to_le_bytes());
        }
    }
    /// A packed integer array (PackedInt32Array, PackedInt64Array).
    pub fn packed_i(&mut self, ty: u8, values: &[i64]) {
        self.out.push(T_PACKED);
        self.out.push(ty);
        self.u32(values.len() as u32);
        for v in values {
            self.out.extend_from_slice(&v.to_le_bytes());
        }
    }
}
