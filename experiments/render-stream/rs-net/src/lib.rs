//! librender_stream_net: render-stream's net module (carrier-design.md D8, D11, D16, D17, Q4;
//! CAR3).
//!
//! The capture dlopen()s this cdylib only when GRC_LIVE_CARRIERS lists `wt`, and calls its one
//! entry, `grc_net_module_v1()` (capture/src/grc_net_module.h), for a table whose `wt_create`
//! makes the `wt` carrier: WebTransport (render-stream-wt/1) behind the public carrier ABI
//! grc_carrier_v1 (capture/src/grc_carrier.h). The module holds every QUIC and TLS byte.
//!
//! CAR4 adds a second entry, `grc_net_tls_v1()`: a sans-IO TLS server session (src/tls.rs) the
//! capture's `ws` carrier runs its connections through when GRC_LIVE_TLS_CERT/KEY are set (wss,
//! D12). The capture loads the module for that too, with or without `wt`.
//!
//! Containment (D17): every `extern "C"` entry runs under `catch_unwind`. A panic stops the
//! carrier (`faulted`, every connection closed 1011), and the capture, its other carriers and the
//! game go on. The cdylib exports only `grc_net_*` symbols (rustc's own version script for a
//! cdylib exports just the `#[no_mangle]` items; scripts/build-rs-net.sh checks the list).

pub mod abi;
pub mod cert;
pub mod host;
pub mod tls;
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
        // TRK3: a host older than TRK1 (112 bytes, no admit_subprotocol) still starts; it just
        // never gets a track subprotocol.
        let Some(raw) = read_host(host) else {
            write_error(error, cap, "net-module-abi: the host's grc_carrier_host_v1 is not version 1");
            return 0;
        };
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
    features: GRC_NET_FEATURE_TRACKS,
    features_reserved: 0,
};

/// The module's one entry (grc_net_module.h, struct grc_net_module_table_v1).
#[no_mangle]
pub extern "C" fn grc_net_module_v1() -> *const GrcNetModuleV1 {
    &MODULE
}

// ------------------------------------------------------------------------------ grc_net_tls_v1

unsafe fn c_str<'a>(p: *const c_char) -> Option<&'a str> {
    if p.is_null() {
        return None;
    }
    std::ffi::CStr::from_ptr(p).to_str().ok()
}

unsafe extern "C" fn tls_config_create(cert: *const c_char, key: *const c_char, error: *mut c_char, cap: usize) -> *mut c_void {
    catch_unwind(AssertUnwindSafe(|| {
        let (Some(cert), Some(key)) = (c_str(cert), c_str(key)) else {
            write_error(error, cap, "tls-config-invalid: the certificate and key paths must be UTF-8 and non-null");
            return std::ptr::null_mut();
        };
        match tls::TlsConfig::from_pem_files(cert, key) {
            Ok(c) => Box::into_raw(Box::new(c)) as *mut c_void,
            Err(e) => {
                write_error(error, cap, &e);
                std::ptr::null_mut()
            }
        }
    }))
    .unwrap_or_else(|_| {
        write_error(error, cap, "tls-config-invalid: panic while loading the pair");
        std::ptr::null_mut()
    })
}

unsafe extern "C" fn tls_config_cert_sha256(config: *const c_void, out: *mut c_char, cap: usize) -> c_int {
    catch_unwind(AssertUnwindSafe(|| {
        let Some(c) = (config as *const tls::TlsConfig).as_ref() else { return 0 };
        if out.is_null() || cap < 65 {
            return 0;
        }
        write_error(out, cap, &c.sha256);
        1
    }))
    .unwrap_or(0)
}

unsafe extern "C" fn tls_config_destroy(config: *mut c_void) {
    if !config.is_null() {
        let _ = catch_unwind(AssertUnwindSafe(|| drop(Box::from_raw(config as *mut tls::TlsConfig))));
    }
}

unsafe extern "C" fn tls_session_create(config: *const c_void, error: *mut c_char, cap: usize) -> *mut c_void {
    catch_unwind(AssertUnwindSafe(|| {
        let Some(c) = (config as *const tls::TlsConfig).as_ref() else {
            write_error(error, cap, "tls-session: no config");
            return std::ptr::null_mut();
        };
        match tls::TlsSession::new(c) {
            Ok(s) => Box::into_raw(Box::new(s)) as *mut c_void,
            Err(e) => {
                write_error(error, cap, &e);
                std::ptr::null_mut()
            }
        }
    }))
    .unwrap_or(std::ptr::null_mut())
}

unsafe extern "C" fn tls_session_destroy(session: *mut c_void) {
    if !session.is_null() {
        let _ = catch_unwind(AssertUnwindSafe(|| drop(Box::from_raw(session as *mut tls::TlsSession))));
    }
}

/// D17 for a session: a panic fails that session alone (GRC_TLS_FAILED, error "panic in ..."),
/// and the capture closes that one connection.
unsafe fn session_call<R>(session: *mut c_void, fallback: R, what: &str, f: impl FnOnce(&mut tls::TlsSession) -> R) -> R {
    let Some(s) = (session as *mut tls::TlsSession).as_mut() else { return fallback };
    let s_ptr = s as *mut tls::TlsSession;
    match catch_unwind(AssertUnwindSafe(|| f(&mut *s_ptr))) {
        Ok(r) => r,
        Err(_) => {
            (*s_ptr).fail(&format!("panic in tls {what}"));
            fallback
        }
    }
}

unsafe fn bytes<'a>(p: *const u8, len: usize) -> &'a [u8] {
    if p.is_null() || len == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(p, len)
    }
}

unsafe fn bytes_mut<'a>(p: *mut u8, len: usize) -> &'a mut [u8] {
    if p.is_null() || len == 0 {
        &mut []
    } else {
        std::slice::from_raw_parts_mut(p, len)
    }
}

unsafe extern "C" fn tls_feed(session: *mut c_void, data: *const u8, len: usize) -> i64 {
    session_call(session, -1, "feed", |s| s.feed(bytes(data, len)))
}

unsafe extern "C" fn tls_read(session: *mut c_void, out: *mut u8, cap: usize) -> i64 {
    session_call(session, -1, "read", |s| s.read(bytes_mut(out, cap)))
}

unsafe extern "C" fn tls_write(session: *mut c_void, data: *const u8, len: usize) -> i64 {
    session_call(session, -1, "write", |s| s.write(bytes(data, len)))
}

unsafe extern "C" fn tls_take(session: *mut c_void, out: *mut u8, cap: usize) -> i64 {
    session_call(session, 0, "take", |s| s.take(bytes_mut(out, cap)))
}

unsafe extern "C" fn tls_state(session: *const c_void) -> u32 {
    session_call(session as *mut c_void, tls::GRC_TLS_FAILED, "state", |s| s.state())
}

unsafe extern "C" fn tls_error(session: *const c_void, out: *mut c_char, cap: usize) -> usize {
    session_call(session as *mut c_void, 0, "error", |s| {
        write_error(out, cap, s.error());
        s.error().len()
    })
}

unsafe extern "C" fn tls_close_notify(session: *mut c_void) {
    session_call(session, (), "close_notify", |s| s.close_notify())
}

static TLS: GrcNetTlsV1 = GrcNetTlsV1 {
    abi_version: GRC_NET_TLS_ABI_VERSION,
    size: std::mem::size_of::<GrcNetTlsV1>() as u32,
    module_version: MODULE_VERSION.as_ptr() as *const c_char,
    config_create: tls_config_create,
    config_cert_sha256: tls_config_cert_sha256,
    config_destroy: tls_config_destroy,
    session_create: tls_session_create,
    session_destroy: tls_session_destroy,
    feed: tls_feed,
    read: tls_read,
    write: tls_write,
    take: tls_take,
    state: tls_state,
    error: tls_error,
    close_notify: tls_close_notify,
};

/// CAR4's entry (grc_net_module.h, struct grc_net_tls_table_v1): the sans-IO TLS server session.
#[no_mangle]
pub extern "C" fn grc_net_tls_v1() -> *const GrcNetTlsV1 {
    &TLS
}
