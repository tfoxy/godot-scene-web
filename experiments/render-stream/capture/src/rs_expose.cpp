#include "rs_expose.h"

#include <arpa/inet.h>

namespace grc {
namespace live {

bool parse_expose(const char *text, Expose *out, std::string *why) {
  const std::string v = text != nullptr ? text : "";
  if (v.empty() || v == "loopback") {
    *out = Expose::Loopback;
    return true;
  }
  if (v == "lan") {
    *out = Expose::Lan;
    return true;
  }
  *why = "expose-invalid: GRC_LIVE_EXPOSE must be loopback or lan (got " + v + ")";
  return false;
}

bool check_expose(Expose expose, bool token_auth, std::size_t origin_count, std::string *why) {
  if (expose != Expose::Lan) {
    return true;
  }
  if (!token_auth) {
    *why = "lan-needs-token: GRC_LIVE_EXPOSE=lan needs GRC_LIVE_AUTH=token";
    return false;
  }
  if (origin_count == 0) {
    *why = "lan-needs-origins: GRC_LIVE_EXPOSE=lan needs a non-empty GRC_LIVE_ALLOWED_ORIGINS";
    return false;
  }
  return true;
}

bool parse_lan_plaintext(const char *text, Expose expose, bool *out, std::string *why) {
  const std::string v = text != nullptr ? text : "";
  if (v.empty()) {
    *out = false;
    return true;
  }
  if (v != "allow") {
    *why = "lan-plaintext-invalid: GRC_LIVE_LAN_PLAINTEXT must be allow or unset (got " + v + ")";
    return false;
  }
  if (expose != Expose::Lan) {
    *why = "lan-plaintext-invalid: GRC_LIVE_LAN_PLAINTEXT=allow needs GRC_LIVE_EXPOSE=lan";
    return false;
  }
  *out = true;
  return true;
}

bool is_loopback_literal(const std::string &host) { return host == "127.0.0.1" || host == "::1"; }

bool is_ip_literal(const std::string &host) {
  unsigned char buf[sizeof(in6_addr)];
  return inet_pton(AF_INET, host.c_str(), buf) == 1 || inet_pton(AF_INET6, host.c_str(), buf) == 1;
}

bool listen_host_allowed(const std::string &host, Expose expose) {
  return is_loopback_literal(host) || (expose == Expose::Lan && is_ip_literal(host));
}

bool parse_listen_address(const std::string &text, Expose expose, const char *var, std::string *host,
                          std::uint16_t *port, std::string *reason) {
  const std::string name = var;
  std::string h;
  std::string p;
  if (!text.empty() && text[0] == '[') {
    const std::size_t close = text.find(']');
    if (close == std::string::npos || close + 1 >= text.size() || text[close + 1] != ':') {
      *reason = "invalid " + name + "=" + text + " (expected [::1]:<port>)";
      return false;
    }
    h = text.substr(1, close - 1);
    p = text.substr(close + 2);
  } else {
    const std::size_t colon = text.rfind(':');
    if (colon == std::string::npos) {
      *reason = "invalid " + name + "=" + text + " (expected 127.0.0.1:<port>)";
      return false;
    }
    h = text.substr(0, colon);
    p = text.substr(colon + 1);
  }
  if (p.empty() || p.size() > 5 || p.find_first_not_of("0123456789") != std::string::npos ||
      std::stoul(p) > 65535) {
    *reason = "invalid " + name + " port \"" + p + "\"";
    return false;
  }
  if (!listen_host_allowed(h, expose)) {
    *reason = "non-loopback";
    return false;
  }
  *host = h;
  *port = static_cast<std::uint16_t>(std::stoul(p));
  return true;
}

}  // namespace live
}  // namespace grc
