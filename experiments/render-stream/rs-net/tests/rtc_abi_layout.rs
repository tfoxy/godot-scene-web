#![cfg(all(feature = "rtc", target_pointer_width = "64"))]
use render_stream_net::abi::*;
use std::mem::{align_of, offset_of, size_of};

#[test]
fn every_rtc_field_matches_the_c_header() {
    // These assertions are deliberately independent of the Rust declarations.
    macro_rules! layout {
        ($ty:ty, $size:expr, $align:expr, $($field:ident: $offset:expr),+ $(,)?) => {
            assert_eq!(size_of::<$ty>(), $size, stringify!($ty));
            assert_eq!(align_of::<$ty>(), $align, stringify!($ty));
            $(assert_eq!(offset_of!($ty, $field), $offset, stringify!($field));)+
        }
    }
    layout!(GrcRtcAddr, 20, 2, family: 0, _r: 1, port: 2, addr: 4);
    layout!(GrcRtcCallbacksV1, 72, 8, abi: 0, user: 8, transmit: 16, peer: 24,
        dc_open: 32, dc_message: 40, dc_low: 48, dc_closed: 56, log: 64);
    layout!(GrcRtcConfigV1, 88, 8, cert_der: 0, cert_len: 8, key_pkcs8: 16,
        key_len: 24, ice_ufrag: 32, ice_pwd: 40, local_candidate: 48, max_peers: 68,
        recv_max_message: 72, dc_low_threshold: 76, sctp_send_budget: 80);
    layout!(GrcRtcV1, 64, 8, abi: 0, create: 8, input: 16, send: 24,
        buffered: 32, close_dc: 40, close_peer: 48, destroy: 56);
    let header = include_str!("../../capture/src/grc_net_rtc.h");
    for (name, fields) in [
        (
            "grc_rtc_addr",
            vec![
                "uint8_t family;",
                "uint8_t _r;",
                "uint16_t port;",
                "uint8_t addr[16];",
            ],
        ),
        (
            "grc_rtc_callbacks_v1",
            vec![
                "uint32_t abi;",
                "void *user;",
                "(*transmit)",
                "(*peer)",
                "(*dc_open)",
                "(*dc_message)",
                "(*dc_low)",
                "(*dc_closed)",
                "(*log)",
            ],
        ),
        (
            "grc_rtc_config_v1",
            vec![
                "const uint8_t *cert_der;",
                "size_t cert_len;",
                "const uint8_t *key_pkcs8;",
                "size_t key_len;",
                "const char *ice_ufrag;",
                "const char *ice_pwd;",
                "grc_rtc_addr local_candidate;",
                "uint32_t max_peers;",
                "uint32_t recv_max_message;",
                "uint32_t dc_low_threshold;",
                "uint32_t sctp_send_budget;",
            ],
        ),
        (
            "grc_rtc_v1",
            vec![
                "uint32_t abi;",
                "(*create)",
                "(*input)",
                "(*send)",
                "(*buffered)",
                "(*close_dc)",
                "(*close_peer)",
                "(*destroy)",
            ],
        ),
    ] {
        let start = header.find(&format!("typedef struct {name} {{")).unwrap();
        let mut remaining = &header[start..header[start..].find('}').unwrap() + start];
        for field in fields {
            let index = remaining
                .find(field)
                .unwrap_or_else(|| panic!("{name}: missing or reordered {field}"));
            remaining = &remaining[index + field.len()..];
        }
    }
    assert!(header.contains("#define GRC_NET_RTC_ABI_VERSION 1u"));
    assert_eq!(unsafe { &*render_stream_net::rtc::grc_net_rtc_v1() }.abi, 1);
}
