//! The `#[repr(C)]` mirrors have the layouts the capture's C++ compiler gives grc_carrier.h and
//! grc_net_module.h (pinned there by static_asserts in capture/src/rs_net_module.cpp).
use render_stream_net::abi::*;
use std::mem::{offset_of, size_of};

#[test]
fn layouts_match_the_c_headers() {
    assert_eq!(size_of::<GrcBuf>(), 24);
    assert_eq!(size_of::<GrcCarrierHostV1>(), 112);
    assert_eq!(size_of::<GrcCarrierV1>(), 88);
    assert_eq!(size_of::<GrcNetWtInfoV1>(), 184);
    assert_eq!(offset_of!(GrcNetWtInfoV1, port), 72);
    assert_eq!(offset_of!(GrcNetWtInfoV1, sessions_refused), 160);
    assert_eq!(size_of::<GrcNetModuleV1>(), 40);
    assert_eq!(size_of::<GrcNetTlsV1>(), 112);
    assert_eq!(offset_of!(GrcNetTlsV1, feed), 56);
    assert_eq!(offset_of!(GrcNetTlsV1, close_notify), 104);
}
