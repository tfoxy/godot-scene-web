//! `#[repr(C)]` mirrors of `capture/src/grc_carrier.h` (grc_carrier_v1) and
//! `capture/src/grc_net_module.h` (grc_net_module_v1). Field order and types follow the headers
//! exactly; `tests/abi_layout.rs` pins the sizes the capture's C++ compiler sees.

use std::ffi::{c_char, c_int, c_void};

pub const GRC_CARRIER_ABI_VERSION: u32 = 1;
pub const GRC_CARRIER_LOCAL_MAX: u32 = 0x00FF_FFFF;
pub const GRC_NET_MODULE_ABI_VERSION: u32 = 1;

pub const GRC_CODING_IDENTITY: c_int = 0;
pub const GRC_CODING_GZIP: c_int = 1;
pub const GRC_CODING_ZSTD: c_int = 2;

pub const GRC_REJECT_AUTH: c_int = 1;
pub const GRC_REJECT_ORIGIN: c_int = 2;
pub const GRC_REJECT_CAPACITY: c_int = 3;

pub const GRC_LOG_ERROR: c_int = 0;
pub const GRC_LOG_WARN: c_int = 1;
pub const GRC_LOG_INFO: c_int = 2;

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct GrcBuf {
    pub data: *const u8,
    pub len: usize,
    pub owner: *mut c_void,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct GrcCarrierHostV1 {
    pub abi_version: u32,
    pub size: u32,
    pub host: *mut c_void,
    pub config: unsafe extern "C" fn(*mut c_void, *const c_char) -> *const c_char,
    pub admit: unsafe extern "C" fn(*mut c_void, u32) -> c_int,
    pub opened: unsafe extern "C" fn(*mut c_void, u32, *const c_char, usize, *const c_char, usize),
    pub text: unsafe extern "C" fn(*mut c_void, u32, *const c_char, usize),
    pub closed: unsafe extern "C" fn(*mut c_void, u32, u16, *const c_char, usize),
    pub rejected: unsafe extern "C" fn(*mut c_void, u32, c_int, *const c_char, usize),
    pub resource_served: unsafe extern "C" fn(*mut c_void, u32, *const c_char, u16, c_int, u64, u64),
    pub token_ok: unsafe extern "C" fn(*mut c_void, *const c_char, usize) -> c_int,
    pub origin_ok: unsafe extern "C" fn(*mut c_void, *const c_char, usize) -> c_int,
    pub lookup: unsafe extern "C" fn(*mut c_void, *const c_char, c_int, *mut GrcBuf) -> c_int,
    pub release: unsafe extern "C" fn(*mut c_void, *mut c_void),
    pub log: unsafe extern "C" fn(*mut c_void, c_int, *const c_char, usize),
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct GrcCarrierV1 {
    pub abi_version: u32,
    pub size: u32,
    pub name: *const c_char,
    pub self_: *mut c_void,
    pub start: unsafe extern "C" fn(*mut c_void, *const GrcCarrierHostV1, *mut c_char, usize) -> c_int,
    pub stop: unsafe extern "C" fn(*mut c_void),
    pub send_binary: unsafe extern "C" fn(*mut c_void, u32, GrcBuf) -> c_int,
    pub send_text: unsafe extern "C" fn(*mut c_void, u32, GrcBuf) -> c_int,
    pub close: unsafe extern "C" fn(*mut c_void, u32, u16, *const c_char, usize),
    pub queued_bytes: unsafe extern "C" fn(*mut c_void, u32) -> u64,
    pub max_queued_bytes: unsafe extern "C" fn(*mut c_void, u32) -> u64,
    pub destroy: unsafe extern "C" fn(*mut c_void),
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct GrcNetWtInfoV1 {
    pub abi_version: u32,
    pub size: u32,
    pub address: [c_char; 64],
    pub port: i32,
    pub tls: [c_char; 16],
    pub cert_sha256: [c_char; 65],
    pub faulted: u8,
    pub cert_expired: u8,
    pub reserved: [u8; 1],
    pub sessions_refused: u64,
    pub streams_refused: u64,
    pub datagrams_dropped: u64,
}

impl Default for GrcNetWtInfoV1 {
    fn default() -> Self {
        Self {
            abi_version: GRC_NET_MODULE_ABI_VERSION,
            size: std::mem::size_of::<Self>() as u32,
            address: [0; 64],
            port: -1,
            tls: [0; 16],
            cert_sha256: [0; 65],
            faulted: 0,
            cert_expired: 0,
            reserved: [0; 1],
            sessions_refused: 0,
            streams_refused: 0,
            datagrams_dropped: 0,
        }
    }
}

#[repr(C)]
pub struct GrcNetModuleV1 {
    pub abi_version: u32,
    pub size: u32,
    pub carrier_abi_version: u32,
    pub reserved: u32,
    pub module_version: *const c_char,
    pub wt_create: unsafe extern "C" fn(*mut GrcCarrierV1, *mut c_char, usize) -> c_int,
    pub wt_info: unsafe extern "C" fn(*mut c_void, *mut GrcNetWtInfoV1) -> c_int,
}

// The table is immutable static data.
unsafe impl Sync for GrcNetModuleV1 {}

/// Copies `s` into a fixed C char array, NUL-terminated, truncating at a UTF-8 boundary.
pub fn fill_c_array(dst: &mut [c_char], s: &str) {
    if dst.is_empty() {
        return;
    }
    let mut n = s.len().min(dst.len() - 1);
    while n > 0 && !s.is_char_boundary(n) {
        n -= 1;
    }
    for (d, b) in dst.iter_mut().zip(s.as_bytes()[..n].iter()) {
        *d = *b as c_char;
    }
    dst[n] = 0;
}

/// Writes `msg` into a caller's `error` buffer (NUL-terminated, truncated).
///
/// # Safety
/// `error` is null or points at `cap` writable bytes.
pub unsafe fn write_error(error: *mut c_char, cap: usize, msg: &str) {
    if error.is_null() || cap == 0 {
        return;
    }
    let dst = std::slice::from_raw_parts_mut(error, cap);
    fill_c_array(dst, msg);
}
