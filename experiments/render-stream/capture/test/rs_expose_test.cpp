// CAR2 (protocol/carrier-design.md D10, Q3): the refusal matrix of the LAN exposure policy
// (src/rs_expose.h), the rule entry.cpp and rs_live_host share. entry.cpp's own wiring is judged
// by scripts/test/self-test-lan.ts, which launches rs_live_host through the same functions.
#include <cstdio>
#include <string>

#include "rs_expose.h"

using grc::live::Expose;

namespace {
int g_fail = 0;
int g_checks = 0;
void check(bool ok, const std::string &what) {
  ++g_checks;
  if (!ok) {
    std::fprintf(stderr, "FAIL %s\n", what.c_str());
    ++g_fail;
  }
}

std::string listen_reason(const std::string &text, Expose e) {
  std::string host, reason;
  std::uint16_t port = 0;
  return grc::live::parse_listen_address(text, e, "GRC_LIVE_LISTEN", &host, &port, &reason) ? "ok" : reason;
}
}  // namespace

int main() {
  // GRC_LIVE_EXPOSE.
  for (const char *good : {static_cast<const char *>(nullptr), "", "loopback", "lan"}) {
    Expose e = Expose::Loopback;
    std::string why;
    check(grc::live::parse_expose(good, &e, &why), std::string("expose '") + (good ? good : "<null>") + "' parses");
    check((good != nullptr && std::string(good) == "lan") == (e == Expose::Lan), "lan only for 'lan'");
  }
  for (const char *bad : {"LAN", "Lan", "wan", "public", "1", "lan ", " lan", "loopback,lan"}) {
    Expose e = Expose::Loopback;
    std::string why;
    check(!grc::live::parse_expose(bad, &e, &why) && why.rfind("expose-invalid", 0) == 0,
          std::string("expose '") + bad + "' -> expose-invalid, got " + why);
  }

  // lan needs the token, then the origins; loopback needs neither.
  std::string why;
  check(grc::live::check_expose(Expose::Loopback, false, 0, &why), "loopback needs no token and no origins");
  check(!grc::live::check_expose(Expose::Lan, false, 0, &why) && why.rfind("lan-needs-token", 0) == 0,
        "lan, no token, no origins -> lan-needs-token (the token is judged first), got " + why);
  check(!grc::live::check_expose(Expose::Lan, false, 2, &why) && why.rfind("lan-needs-token", 0) == 0,
        "lan, origins but no token -> lan-needs-token");
  check(!grc::live::check_expose(Expose::Lan, true, 0, &why) && why.rfind("lan-needs-origins", 0) == 0,
        "lan, token but no origins -> lan-needs-origins");
  check(grc::live::check_expose(Expose::Lan, true, 1, &why), "lan, token and origins -> allowed");

  // Listen addresses: (text, loopback result, lan result).
  struct Row {
    const char *text;
    const char *loopback;
    const char *lan;
  };
  const Row rows[] = {
      {"127.0.0.1:0", "ok", "ok"},
      {"[::1]:8080", "ok", "ok"},
      {"0.0.0.0:0", "non-loopback", "ok"},
      {"[::]:9000", "non-loopback", "ok"},
      {"192.168.1.20:9000", "non-loopback", "ok"},
      {"10.0.0.7:1", "non-loopback", "ok"},
      {"[fe80::1]:7", "non-loopback", "ok"},
      {"localhost:80", "non-loopback", "non-loopback"},
      {"example.com:80", "non-loopback", "non-loopback"},
      {"127.0.0.2:80", "non-loopback", "ok"},  // an IP literal; only the exact loopback pair is "loopback"
      {"0.0.0.0", "invalid GRC_LIVE_LISTEN=0.0.0.0 (expected 127.0.0.1:<port>)",
       "invalid GRC_LIVE_LISTEN=0.0.0.0 (expected 127.0.0.1:<port>)"},
      {"0.0.0.0:70000", "invalid GRC_LIVE_LISTEN port \"70000\"", "invalid GRC_LIVE_LISTEN port \"70000\""},
      {"0.0.0.0:", "invalid GRC_LIVE_LISTEN port \"\"", "invalid GRC_LIVE_LISTEN port \"\""},
      {"[::]9000", "invalid GRC_LIVE_LISTEN=[::]9000 (expected [::1]:<port>)",
       "invalid GRC_LIVE_LISTEN=[::]9000 (expected [::1]:<port>)"},
  };
  for (const Row &r : rows) {
    check(listen_reason(r.text, Expose::Loopback) == r.loopback,
          std::string("loopback '") + r.text + "' -> " + r.loopback + ", got " + listen_reason(r.text, Expose::Loopback));
    check(listen_reason(r.text, Expose::Lan) == r.lan,
          std::string("lan '") + r.text + "' -> " + r.lan + ", got " + listen_reason(r.text, Expose::Lan));
  }
  {
    std::string host, reason;
    std::uint16_t port = 0;
    check(grc::live::parse_listen_address("[::]:9000", Expose::Lan, "GRC_LIVE_WT_LISTEN", &host, &port, &reason) &&
              host == "::" && port == 9000,
          "'[::]:9000' parses to host '::' port 9000");
    grc::live::parse_listen_address("x", Expose::Lan, "GRC_LIVE_WT_LISTEN", &host, &port, &reason);
    check(reason.find("GRC_LIVE_WT_LISTEN") != std::string::npos, "the variable name is in the malformation text");
  }

  if (g_fail != 0) {
    std::fprintf(stderr, "rs_expose_test: %d of %d checks failed\n", g_fail, g_checks);
    return 1;
  }
  std::printf("rs_expose_test: all %d checks passed\n", g_checks);
  return 0;
}
