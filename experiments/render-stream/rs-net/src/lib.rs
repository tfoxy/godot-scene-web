//! librender_stream_net: render-stream's net module (carrier-design.md D8, D11, D16, D17, Q4;
//! CAR3).
//!
//! The capture dlopen()s this cdylib only when GRC_LIVE_CARRIERS lists `wt`, and calls its one
//! entry, `grc_net_module_v1()` (capture/src/grc_net_module.h), for a table whose `wt_create`
//! makes the `wt` carrier: WebTransport (render-stream-wt/1) behind the public carrier ABI
//! grc_carrier_v1 (capture/src/grc_carrier.h). The module holds every QUIC and TLS byte.
//!
//! Containment (D17): every `extern "C"` entry runs under `catch_unwind`. A panic stops the
//! carrier (`faulted`, every connection closed 1011), and the capture, its other carriers and the
//! game go on. The cdylib exports only `grc_net_*` symbols (rustc's own version script for a
//! cdylib exports just the `#[no_mangle]` items; scripts/build-rs-net.sh checks the list).

pub mod abi;
pub mod cert;
pub mod host;
pub mod wt;

use std::ffi::{c_char, c_int, c_void};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use abi::*;
use host::{Host, HostBuf};

pub const MODULE_VERSION: &str = concat!("render-stream-net ", env!("CARGO_PKG_VERSION"), "\0");
const NAME: &[u8] = b"wt\0";

/// The state behind one `wt` carrier's `self`.
pub struct WtCarrier {
    /// Main thread only (lifecycle and hot calls); wt_info reads `info` under it too.
    running: Mutex<Option<wt::Running>>,
    stopped: Mutex<bool>,
    host: Mutex<Option<Arc<Host>>>,
}

impl WtCarrier {
    fn shared(&self) -> Option<Arc<wt::Shared>> {
        self.running
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|r| r.shared.clone())
    }
}

unsafe fn carrier<'a>(self_: *mut c_void) -> Option<&'a WtCarrier> {
    (self_ as *const WtCarrier).as_ref()
}

/// Runs `f` under catch_unwind; a panic faults the carrier (D17) and yields `fallback`.
fn guarded<R>(c: Option<&WtCarrier>, fallback: R, what: &str, f: impl FnOnce() -> R) -> R {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(r) => r,
        Err(_) => {
            if let Some(c) = c {
                if let Some(s) = c.shared() {
                    s.fault(&format!("panic in {what}"));
                }
            }
            fallback
        }
    }
}

unsafe extern "C" fn wt_start(self_: *mut c_void, host: *const GrcCarrierHostV1, error: *mut c_char, cap: usize) -> c_int {
    let c = carrier(self_);
    guarded(c, 0, "start", || {
        let Some(c) = c else { return 0 };
        if host.is_null() {
            write_error(error, cap, "carrier-start-failed: no host");
            return 0;
        }
        let raw = *host;
        if raw.abi_version != GRC_CARRIER_ABI_VERSION || (raw.size as usize) < std::mem::size_of::<GrcCarrierHostV1>() {
            write_error(error, cap, "net-module-abi: the host's grc_carrier_host_v1 is not version 1");
            return 0;
        }
        let h = Host::new(raw);
        match catch_unwind(AssertUnwindSafe(|| wt::Running::start(h.clone()))) {
            Ok(Ok(r)) => {
                *c.host.lock().unwrap() = Some(h);
                *c.running.lock().unwrap() = Some(r);
                1
            }
            Ok(Err(e)) => {
                h.kill();
                write_error(error, cap, &e);
                0
            }
            Err(_) => {
                h.kill();
                write_error(error, cap, "carrier-fault: panic while starting");
                0
            }
        }
    })
}

unsafe extern "C" fn wt_stop(self_: *mut c_void) {
    let c = carrier(self_);
    guarded(c, (), "stop", || {
        let Some(c) = c else { return };
        let mut stopped = c.stopped.lock().unwrap_or_else(|e| e.into_inner());
        if *stopped {
            return;
        }
        *stopped = true;
        let taken = c.running.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(mut r) = taken {
            let _ = catch_unwind(AssertUnwindSafe(|| r.stop()));
            // Keep the info for wt_info after stop.
            *c.running.lock().unwrap_or_else(|e| e.into_inner()) = Some(r);
        }
        if let Some(h) = c.host.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            h.kill();
        }
    })
}

unsafe fn send(self_: *mut c_void, local: u32, msg: GrcBuf, kind: u8) -> c_int {
    let c = carrier(self_);
    let host = c.and_then(|c| c.host.lock().unwrap_or_else(|e| e.into_inner()).clone());
    // Ownership first: the buffer is released exactly once, whatever happens below.
    let Some(host) = host else { return 0 };
    let buf = HostBuf::adopt(host, msg);
    guarded(c, 0, "send", move || {
        let Some(s) = c.and_then(|c| c.shared()) else { return 0 };
        if s.stopping.load(Ordering::Acquire) && s.faulted.load(Ordering::Acquire) {
            return 0;
        }
        c_int::from(s.send(local, kind, buf))
    })
}

unsafe extern "C" fn wt_send_binary(self_: *mut c_void, local: u32, msg: GrcBuf) -> c_int {
    send(self_, local, msg, wt::KIND_BINARY)
}

unsafe extern "C" fn wt_send_text(self_: *mut c_void, local: u32, msg: GrcBuf) -> c_int {
    send(self_, local, msg, wt::KIND_TEXT)
}

unsafe extern "C" fn wt_close(self_: *mut c_void, local: u32, code: u16, reason: *const c_char, len: usize) {
    let c = carrier(self_);
    guarded(c, (), "close", || {
        let Some(s) = c.and_then(|c| c.shared()) else { return };
        let reason = if reason.is_null() || len == 0 {
            String::new()
        } else {
            String::from_utf8_lossy(std::slice::from_raw_parts(reason as *const u8, len)).into_owned()
        };
        s.close(local, code, &reason);
    })
}

unsafe extern "C" fn wt_queued_bytes(self_: *mut c_void, local: u32) -> u64 {
    let c = carrier(self_);
    guarded(c, 0, "queued_bytes", || c.and_then(|c| c.shared()).map(|s| s.queued_bytes(local)).unwrap_or(0))
}

unsafe extern "C" fn wt_max_queued_bytes(self_: *mut c_void, local: u32) -> u64 {
    let c = carrier(self_);
    guarded(c, 0, "max_queued_bytes", || c.and_then(|c| c.shared()).map(|s| s.max_queued_bytes(local)).unwrap_or(0))
}

unsafe extern "C" fn wt_destroy(self_: *mut c_void) {
    if self_.is_null() {
        return;
    }
    let _ = catch_unwind(AssertUnwindSafe(|| {
        let b = Box::from_raw(self_ as *mut WtCarrier);
        // A carrier destroyed without stop(): stop it now (the capture always stops first).
        if !*b.stopped.lock().unwrap_or_else(|e| e.into_inner()) {
            wt_stop(self_);
        }
        drop(b);
    }));
}

unsafe extern "C" fn wt_create(out: *mut GrcCarrierV1, error: *mut c_char, cap: usize) -> c_int {
    catch_unwind(AssertUnwindSafe(|| {
        if out.is_null() {
            write_error(error, cap, "wt_create: null out");
            return 0;
        }
        let c = Box::new(WtCarrier { running: Mutex::new(None), stopped: Mutex::new(false), host: Mutex::new(None) });
        *out = GrcCarrierV1 {
            abi_version: GRC_CARRIER_ABI_VERSION,
            size: std::mem::size_of::<GrcCarrierV1>() as u32,
            name: NAME.as_ptr() as *const c_char,
            self_: Box::into_raw(c) as *mut c_void,
            start: wt_start,
            stop: wt_stop,
            send_binary: wt_send_binary,
            send_text: wt_send_text,
            close: wt_close,
            queued_bytes: wt_queued_bytes,
            max_queued_bytes: wt_max_queued_bytes,
            destroy: wt_destroy,
        };
        1
    }))
    .unwrap_or(0)
}

unsafe extern "C" fn wt_info(self_: *mut c_void, out: *mut GrcNetWtInfoV1) -> c_int {
    catch_unwind(AssertUnwindSafe(|| {
        let Some(c) = carrier(self_) else { return 0 };
        if out.is_null() {
            return 0;
        }
        let want = (*out).size as usize;
        if (*out).abi_version != GRC_NET_MODULE_ABI_VERSION || want < std::mem::size_of::<GrcNetWtInfoV1>() {
            return 0;
        }
        let mut info = GrcNetWtInfoV1::default();
        info.size = (*out).size;
        let guard = c.running.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(r) = guard.as_ref() {
            fill_c_array(&mut info.address, &r.info.address);
            info.port = r.info.port;
            fill_c_array(&mut info.tls, &r.info.tls);
            fill_c_array(&mut info.cert_sha256, &r.info.cert_sha256);
            let s = &r.shared;
            info.faulted = u8::from(s.faulted.load(Ordering::Acquire));
            info.cert_expired = u8::from(s.cert_expired.load(Ordering::Acquire));
            info.sessions_refused = s.sessions_refused.load(Ordering::Acquire);
            info.streams_refused = s.streams_refused.load(Ordering::Acquire);
            info.datagrams_dropped = s.datagrams_dropped.load(Ordering::Acquire);
        }
        *out = info;
        1
    }))
    .unwrap_or(0)
}

static MODULE: GrcNetModuleV1 = GrcNetModuleV1 {
    abi_version: GRC_NET_MODULE_ABI_VERSION,
    size: std::mem::size_of::<GrcNetModuleV1>() as u32,
    carrier_abi_version: GRC_CARRIER_ABI_VERSION,
    reserved: 0,
    module_version: MODULE_VERSION.as_ptr() as *const c_char,
    wt_create,
    wt_info,
};

/// The module's one entry (grc_net_module.h, struct grc_net_module_table_v1).
#[no_mangle]
pub extern "C" fn grc_net_module_v1() -> *const GrcNetModuleV1 {
    &MODULE
}
