//! `rs-core-capi`: the C ABI over `render-stream-core` for the Godot receiver's GDExtension
//! adapter (gate7-design.md Q14e, G7xn). `receiver/ext/rs_core_ext.cpp` (C++ over the raw
//! `gdextension_interface.h`, no godot-cpp) links this staticlib, registers the `RsCore` class, hands
//! PackedByteArrays in, turns the Variant trees (`vt.rs`) into Variants and executes the
//! RenderingServer call stream (`ops.rs`) as ptrcalls. GDScript keeps configuration, I/O,
//! evidence and shots.
//!
//! Every function takes the handle `rsc_new()` returned. Answers land in three per-handle buffers
//! the shim reads right after the call: `rsc_vt` (a Variant tree), `rsc_text` (bytes) and
//! `rsc_ops_words`/`rsc_ops_arena` (RenderingServer calls). A panic is caught at this boundary and
//! reported as an `internal` error; the handle is unusable afterwards.
//!
//! The declarations are mirrored by hand in `receiver/ext/rs_core_capi.h`.

pub mod core;
pub mod ops;
pub mod plan;
pub mod vt;

use crate::core::Core;
use std::panic::{catch_unwind, AssertUnwindSafe};

/// The C handle.
pub struct RsCore {
    core: Core,
    poisoned: bool,
}

unsafe fn bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 || ptr.is_null() {
        &[]
    } else {
        std::slice::from_raw_parts(ptr, len)
    }
}

unsafe fn text<'a>(ptr: *const u8, len: usize) -> &'a str {
    std::str::from_utf8(bytes(ptr, len)).unwrap_or("")
}

/// Runs `f` on the core, catching a panic: returns `fallback` (and the error text in `text`) then.
fn guard<T>(h: *mut RsCore, fallback: T, f: impl FnOnce(&mut Core) -> T) -> T {
    let h = unsafe { &mut *h };
    if h.poisoned {
        h.core.text = b"internal: the core panicked earlier".to_vec();
        return fallback;
    }
    match catch_unwind(AssertUnwindSafe(|| f(&mut h.core))) {
        Ok(v) => v,
        Err(e) => {
            h.poisoned = true;
            let msg = e
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| e.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "panic".into());
            h.core.text = format!("internal: {msg}").into_bytes();
            fallback
        }
    }
}

#[no_mangle]
pub extern "C" fn rsc_new() -> *mut RsCore {
    Box::into_raw(Box::new(RsCore {
        core: Core::new(),
        poisoned: false,
    }))
}

/// # Safety
/// `h` came from `rsc_new()` and is not used afterwards.
#[no_mangle]
pub unsafe extern "C" fn rsc_free(h: *mut RsCore) {
    if !h.is_null() {
        drop(Box::from_raw(h));
    }
}

/// The opcode count (ops.rs `OP_COUNT`), checked against the shim's at load.
#[no_mangle]
pub extern "C" fn rsc_op_count() -> u32 {
    ops::OP_COUNT
}

/// # Safety
/// `name` points to `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn rsc_set_sabotage(h: *mut RsCore, name: *const u8, len: usize) {
    let name = text(name, len).to_string();
    guard(h, (), |c| c.set_sabotage(&name));
}

#[no_mangle]
pub extern "C" fn rsc_set_full_scan(h: *mut RsCore, on: i32) {
    guard(h, (), |c| c.planner.full_scan = on != 0);
}

/// The session record at `offset` of `data`: returns 4 (session) or 0 (error); vt holds the
/// accept_record()-shaped Dictionary either way.
///
/// # Safety
/// `data` points to `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn rsc_session(
    h: *mut RsCore,
    data: *const u8,
    len: usize,
    offset: usize,
) -> i32 {
    let data = bytes(data, len);
    guard(h, 0, |c| c.session(data, offset))
}

/// The session's RenderingServer calls (ops).
#[no_mangle]
pub extern "C" fn rsc_begin_session(h: *mut RsCore) {
    guard(h, (), |c| c.begin_session());
}

/// One record after the session: returns 1 resource, 2 transaction, 3 end or 0 error; vt holds
/// the accept_record()-shaped Dictionary.
///
/// # Safety
/// `data` points to `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn rsc_accept(
    h: *mut RsCore,
    data: *const u8,
    len: usize,
    offset: usize,
) -> i32 {
    let data = bytes(data, len);
    guard(h, 0, |c| c.accept(data, offset))
}

/// The last resource record's inline payload into text; 0 when there is none.
#[no_mangle]
pub extern "C" fn rsc_resource_payload(h: *mut RsCore) -> i32 {
    guard(h, 0, |c| c.resource_payload() as i32)
}

/// needed() into vt.
#[no_mangle]
pub extern "C" fn rsc_needed(h: *mut RsCore) {
    guard(h, (), |c| c.needed());
}

/// A payload for the next apply: 1 when kept, 0 with "<code>: <detail>" in text.
///
/// # Safety
/// `hash` points to `hlen` bytes, `data` to `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn rsc_provide(
    h: *mut RsCore,
    hash: *const u8,
    hlen: usize,
    data: *const u8,
    len: usize,
) -> i32 {
    let hash = text(hash, hlen).to_string();
    let data = bytes(data, len);
    guard(h, 0, |c| match c.provide(&hash, data) {
        Ok(()) => 1,
        Err(e) => {
            c.text = e.into_bytes();
            0
        }
    })
}

/// A `withheld` shader's library answer: `ok` with its code, or not with the detail.
///
/// # Safety
/// `hash` points to `hlen` bytes, `body` to `blen` bytes.
#[no_mangle]
pub unsafe extern "C" fn rsc_provide_library(
    h: *mut RsCore,
    hash: *const u8,
    hlen: usize,
    ok: i32,
    body: *const u8,
    blen: usize,
) {
    let hash = text(hash, hlen).to_string();
    let body = text(body, blen).to_string();
    guard(h, (), |c| c.provide_library(&hash, ok != 0, &body));
}

/// apply_state(): 1 with ops and the stats vt, or 0 with "<code>: <detail>" in text.
#[no_mangle]
pub extern "C" fn rsc_apply(h: *mut RsCore) -> i32 {
    guard(h, 0, |c| match c.apply() {
        Ok(()) => 1,
        Err(e) => {
            c.text = e.into_bytes();
            0
        }
    })
}

/// dispose(): the frees into ops; returns how many RIDs.
#[no_mangle]
pub extern "C" fn rsc_dispose(h: *mut RsCore) -> i64 {
    guard(h, 0, |c| c.dispose())
}

/// The resolved state dump (JSON) into text.
#[no_mangle]
pub extern "C" fn rsc_state_json(h: *mut RsCore) {
    guard(h, (), |c| c.state_json());
}

/// The counters Dictionary into vt.
#[no_mangle]
pub extern "C" fn rsc_counters(h: *mut RsCore) {
    guard(h, (), |c| c.counters());
}

/// # Safety
/// `n` is writable.
#[no_mangle]
pub unsafe extern "C" fn rsc_vt(h: *mut RsCore, n: *mut usize) -> *const u8 {
    let c = &(*h).core;
    *n = c.vt.out.len();
    c.vt.out.as_ptr()
}

/// # Safety
/// `n` is writable.
#[no_mangle]
pub unsafe extern "C" fn rsc_text(h: *mut RsCore, n: *mut usize) -> *const u8 {
    let c = &(*h).core;
    *n = c.text.len();
    c.text.as_ptr()
}

/// # Safety
/// `n` is writable.
#[no_mangle]
pub unsafe extern "C" fn rsc_ops_words(h: *mut RsCore, n: *mut usize) -> *const u32 {
    let c = &(*h).core;
    *n = c.ops.words.len();
    c.ops.words.as_ptr()
}

/// # Safety
/// `n` is writable.
#[no_mangle]
pub unsafe extern "C" fn rsc_ops_arena(h: *mut RsCore, n: *mut usize) -> *const u8 {
    let c = &(*h).core;
    *n = c.ops.arena.len();
    c.ops.arena.as_ptr()
}
