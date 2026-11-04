//! The capture's side of grc_carrier_v1 (`grc_carrier_host_v1`), wrapped so that no callback can
//! reach the host after `stop()` returns.
//!
//! Every callback takes `alive`'s read lock and checks it; `kill()` (the end of `stop()`) takes
//! the write lock, so it waits for any callback in flight and none starts after it. Host
//! callbacks never block (grc_carrier.h), so the read side is never held long.

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, RwLock};

use crate::abi::*;

pub struct Host {
    raw: GrcCarrierHostV1,
    alive: RwLock<bool>,
    /// Host buffers held and not yet released (the owner ledger, for tests and stop()).
    outstanding: AtomicI64,
}

// The host's callbacks are thread-safe by contract (grc_carrier.h "Threading and ownership").
unsafe impl Send for Host {}
unsafe impl Sync for Host {}

impl Host {
    /// # Safety
    /// `raw`'s function pointers and `host` stay valid until `kill()` is called.
    pub unsafe fn new(raw: GrcCarrierHostV1) -> Arc<Self> {
        Arc::new(Self { raw, alive: RwLock::new(true), outstanding: AtomicI64::new(0) })
    }

    /// After this returns no callback reaches the host (stop()'s last step).
    pub fn kill(&self) {
        let mut alive = self.alive.write().unwrap_or_else(|e| e.into_inner());
        *alive = false;
    }

    pub fn outstanding(&self) -> i64 {
        self.outstanding.load(Ordering::Acquire)
    }

    fn with<R>(&self, dead: R, f: impl FnOnce(&GrcCarrierHostV1) -> R) -> R {
        let alive = self.alive.read().unwrap_or_else(|e| e.into_inner());
        if !*alive {
            return dead;
        }
        f(&self.raw)
    }

    /// A configuration value (grc_carrier_host_v1.config), copied.
    pub fn config(&self, key: &str) -> Option<String> {
        let key = CString::new(key).ok()?;
        self.with(None, |h| unsafe {
            let v = (h.config)(h.host, key.as_ptr());
            if v.is_null() {
                None
            } else {
                Some(CStr::from_ptr(v).to_string_lossy().into_owned())
            }
        })
    }

    pub fn admit(&self, local: u32) -> bool {
        self.with(false, |h| unsafe { (h.admit)(h.host, local) == 1 })
    }

    pub fn opened(&self, local: u32, subprotocol: &str, origin: Option<&str>) {
        let origin = origin.unwrap_or("");
        self.with((), |h| unsafe {
            (h.opened)(
                h.host,
                local,
                subprotocol.as_ptr() as *const c_char,
                subprotocol.len(),
                origin.as_ptr() as *const c_char,
                origin.len(),
            )
        })
    }

    pub fn text(&self, local: u32, data: &[u8]) {
        self.with((), |h| unsafe { (h.text)(h.host, local, data.as_ptr() as *const c_char, data.len()) })
    }

    pub fn closed(&self, local: u32, code: u16, reason: &str) {
        self.with((), |h| unsafe {
            (h.closed)(h.host, local, code, reason.as_ptr() as *const c_char, reason.len())
        })
    }

    pub fn rejected(&self, local: u32, why: c_int, detail: &str) {
        self.with((), |h| unsafe {
            (h.rejected)(h.host, local, why, detail.as_ptr() as *const c_char, detail.len())
        })
    }

    pub fn resource_served(&self, local: u32, hash: &[u8; 64], status: u16, coding: c_int, identity: u64, wire: u64) {
        self.with((), |h| unsafe {
            (h.resource_served)(h.host, local, hash.as_ptr() as *const c_char, status, coding, identity, wire)
        })
    }

    pub fn token_ok(&self, token: &[u8]) -> bool {
        self.with(false, |h| unsafe { (h.token_ok)(h.host, token.as_ptr() as *const c_char, token.len()) == 1 })
    }

    pub fn origin_ok(&self, origin: &str) -> bool {
        self.with(false, |h| unsafe {
            (h.origin_ok)(h.host, origin.as_ptr() as *const c_char, origin.len()) == 1
        })
    }

    /// The body of `hash` in `coding`, or None (not found, or not servable in that coding).
    pub fn lookup(self: &Arc<Self>, hash: &[u8; 64], coding: c_int) -> Option<HostBuf> {
        let mut out = GrcBuf { data: std::ptr::null(), len: 0, owner: std::ptr::null_mut() };
        let found = self.with(false, |h| unsafe {
            (h.lookup)(h.host, hash.as_ptr() as *const c_char, coding, &mut out) == 1
        });
        if !found {
            return None;
        }
        Some(HostBuf::adopt(self.clone(), out))
    }

    pub fn log(&self, level: c_int, msg: &str) {
        self.with((), |h| unsafe { (h.log)(h.host, level, msg.as_ptr() as *const c_char, msg.len()) })
    }

    fn release(&self, owner: *mut c_void) {
        self.outstanding.fetch_sub(1, Ordering::AcqRel);
        self.with((), |h| unsafe { (h.release)(h.host, owner) })
    }
}

/// A host-owned buffer (a send's message or a lookup's body), released exactly once on drop.
pub struct HostBuf {
    host: Arc<Host>,
    buf: GrcBuf,
}

// The bytes are immutable and the release callback is thread-safe.
unsafe impl Send for HostBuf {}
unsafe impl Sync for HostBuf {}

impl HostBuf {
    pub fn adopt(host: Arc<Host>, buf: GrcBuf) -> Self {
        host.outstanding.fetch_add(1, Ordering::AcqRel);
        Self { host, buf }
    }

    pub fn bytes(&self) -> &[u8] {
        if self.buf.data.is_null() || self.buf.len == 0 {
            &[]
        } else {
            unsafe { std::slice::from_raw_parts(self.buf.data, self.buf.len) }
        }
    }

    pub fn len(&self) -> usize {
        self.buf.len
    }

    pub fn is_empty(&self) -> bool {
        self.buf.len == 0
    }
}

impl Drop for HostBuf {
    fn drop(&mut self) {
        self.host.release(self.buf.owner);
    }
}
