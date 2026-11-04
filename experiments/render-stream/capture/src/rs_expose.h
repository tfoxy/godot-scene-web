// CAR2 (protocol/carrier-design.md D10, Q3): LAN exposure policy for the live listeners, pure
// so the entry point, the test host and the unit test share one rule.
//
//   GRC_LIVE_EXPOSE      loopback (default) | lan; anything else is `expose-invalid`
//   loopback             GRC_LIVE_LISTEN / GRC_LIVE_WT_LISTEN must be 127.0.0.1 or ::1,
//                        otherwise the refusal is `non-loopback` (unchanged since G1c2)
//   lan                  also 0.0.0.0, `::` or a host IP literal; needs GRC_LIVE_AUTH=token
//                        (`lan-needs-token`) and a non-empty GRC_LIVE_ALLOWED_ORIGINS
//                        (`lan-needs-origins`)
//
// Every refusal string starts with its code, as the other live refusals do.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace grc {
namespace live {

enum class Expose { Loopback, Lan };

// `text` is the raw GRC_LIVE_EXPOSE (null or empty: loopback). False sets *why to
// "expose-invalid: ...".
bool parse_expose(const char *text, Expose *out, std::string *why);

// D10: `lan` needs the token and an origin allow-list. Sets *why to "lan-needs-token: ..." or
// "lan-needs-origins: ..."; always true for loopback.
bool check_expose(Expose expose, bool token_auth, std::size_t origin_count, std::string *why);

// "127.0.0.1" or "::1".
bool is_loopback_literal(const std::string &host);
// An IPv4 or IPv6 literal (what a bind can take without name resolution).
bool is_ip_literal(const std::string &host);
// Whether a listener may bind `host` under `expose`.
bool listen_host_allowed(const std::string &host, Expose expose);

// GRC_LIVE_LISTEN / GRC_LIVE_WT_LISTEN: "<host>:<port>" or "[<v6>]:<port>". False sets *reason to
// "non-loopback" (a well-formed address `expose` does not allow) or a description of the
// malformation. `var` names the variable in malformation text.
bool parse_listen_address(const std::string &text, Expose expose, const char *var, std::string *host,
                          std::uint16_t *port, std::string *reason);

}  // namespace live
}  // namespace grc
