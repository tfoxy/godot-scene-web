// Bench (not a ctest): one large texture body GET over loopback through the real server and
// ServedResources, as a plain-http LAN browser asks for it (`Accept-Encoding: gzip, deflate`).
//   single: GRC_HTTP_ENCODING=zstd -- the body is zstd at rest, so the GET inflates the identity
//           and sends it (the path before the dual default);
//   dual:   GRC_HTTP_ENCODING=zstd,gzip -- the pin queues the gzip sibling on the sibling pool. A
//           GET issued at the pin (the cold case: a client asks right after the publication)
//           follows the streamed encode with a chunked gzip response; one after the encode ended
//           gets the kept gzip body with Content-Length.
// A `zstd` GET is timed for reference. Usage:
//   rs_http_sibling_bench <raw RGBA file> [repeats] [levels, e.g. 1,3,6] [threads]
// (the file's bytes become one GRT1 payload's data, or are the payload when they already are a GRT1
// body such as a `block` variant; levels and threads tune the streamed gzip
// encode, default the host's). Prints one line per GET: wall ms to the response headers, to the
// first body byte and to the last, and the body bytes on the wire; per level, the encode's
// pin-to-ready time and gzip size.
#include "rs_platform.h"

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <deque>
#include <fstream>
#include <functional>
#include <iterator>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "rs_http_coding.h"
#include "rs_payload_rest.h"
#include "rs_resource_store.h"
#include "rs_ws.h"

namespace {

using Clock = std::chrono::steady_clock;

double ms_since(Clock::time_point t0) {
  return std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
}

class Pool {  // the host's sibling pool, minus priority and names
 public:
  explicit Pool(int n) {
    for (int i = 0; i < n; ++i) threads_.emplace_back([this] { run(); });
  }
  ~Pool() {
    {
      std::lock_guard<std::mutex> lock(m_);
      stop_ = true;
    }
    cv_.notify_all();
    for (auto &t : threads_) t.join();
  }
  bool submit(std::function<void()> work) {
    {
      std::lock_guard<std::mutex> lock(m_);
      q_.push_back(std::move(work));
    }
    cv_.notify_one();
    return true;
  }

 private:
  void run() {
    for (;;) {
      std::function<void()> w;
      {
        std::unique_lock<std::mutex> lock(m_);
        cv_.wait(lock, [this] { return stop_ || !q_.empty(); });
        if (q_.empty()) return;
        w = std::move(q_.front());
        q_.pop_front();
      }
      w();
    }
  }
  std::mutex m_;
  std::condition_variable cv_;
  std::deque<std::function<void()>> q_;
  std::vector<std::thread> threads_;
  bool stop_ = false;
};

struct Timing {
  double headers_ms = -1;
  double first_ms = -1;  // the first body byte
  double body_ms = -1;
  std::size_t wire = 0;  // body bytes (chunk framing excluded)
  std::string coding = "identity";
  bool chunked = false;
};

// The data bytes of a complete chunked body starting at `at`; 0 when incomplete.
std::size_t chunked_data(const std::vector<char> &buf, std::size_t at, bool *complete) {
  std::size_t data = 0;
  *complete = false;
  for (;;) {
    std::size_t eol = at;
    while (eol + 1 < buf.size() && !(buf[eol] == '\r' && buf[eol + 1] == '\n')) ++eol;
    if (eol + 1 >= buf.size()) return data;
    const std::size_t n = std::strtoull(std::string(buf.data() + at, eol - at).c_str(), nullptr, 16);
    at = eol + 2;
    if (buf.size() < at + n + 2) return data;
    if (n == 0) {
      *complete = true;
      return data;
    }
    data += n;
    at += n + 2;
  }
}

Timing get(std::uint16_t port, const std::string &path, const std::string &accept) {
  Timing out;
  const auto fd = grc::rs::tcp_connect(grc::rs::loopback_address(grc::rs::AddrFamily::IPv4), port, nullptr);
  if (fd == grc::rs::kInvalidSocket) return out;
  const std::string req = "GET " + path + " HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept-Encoding: " + accept +
                          "\r\nConnection: close\r\n\r\n";
  const auto t0 = Clock::now();
  grc::rs::socket_send(fd, req.data(), req.size());
  std::vector<char> buf;
  std::vector<char> chunk(1 << 20);
  std::size_t head_end = std::string::npos, length = 0;
  for (;;) {
    const std::ptrdiff_t n = grc::rs::socket_recv(fd, chunk.data(), chunk.size());
    if (n <= 0) break;
    buf.insert(buf.end(), chunk.data(), chunk.data() + n);
    if (head_end == std::string::npos) {
      const std::string s(buf.begin(), buf.end());
      head_end = s.find("\r\n\r\n");
      if (head_end != std::string::npos) {
        out.headers_ms = ms_since(t0);
        const std::string head = s.substr(0, head_end);
        const auto cl = head.find("Content-Length: ");
        if (cl != std::string::npos) length = std::strtoull(head.c_str() + cl + 16, nullptr, 10);
        const auto ce = head.find("Content-Encoding: ");
        if (ce != std::string::npos) out.coding = head.substr(ce + 18, head.find("\r\n", ce) - ce - 18);
        out.chunked = head.find("Transfer-Encoding: chunked") != std::string::npos;
      }
    }
    if (head_end == std::string::npos) continue;
    const std::size_t body_at = head_end + 4;
    if (out.first_ms < 0 && buf.size() > body_at) out.first_ms = ms_since(t0);
    if (out.chunked) {
      // Cheap tail test first: a chunked body ends with the zero-size chunk.
      if (buf.size() >= 5 && std::string(buf.end() - 5, buf.end()) == "0\r\n\r\n") {
        bool complete = false;
        const std::size_t data = chunked_data(buf, body_at, &complete);
        if (complete) {
          out.body_ms = ms_since(t0);
          out.wire = data;
          break;
        }
      }
    } else if (buf.size() >= body_at + length) {
      out.body_ms = ms_since(t0);
      out.wire = length;
      break;
    }
  }
  grc::rs::socket_close(fd);
  return out;
}

void print(const std::string &mode, const char *what, const Timing &t) {
  std::printf("%-8s %-22s coding=%-8s %-7s headers_ms=%7.1f first_byte_ms=%7.1f body_ms=%7.1f wire_bytes=%zu\n",
              mode.c_str(), what, t.coding.c_str(), t.chunked ? "chunked" : "length", t.headers_ms, t.first_ms,
              t.body_ms, t.wire);
}

}  // namespace

int main(int argc, char **argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: rs_http_sibling_bench <raw RGBA file> [repeats] [levels] [threads]\n");
    return 2;
  }
  const int repeats = argc > 2 ? std::atoi(argv[2]) : 3;
  std::vector<int> levels;
  for (const char *p = argc > 3 ? argv[3] : ""; *p != '\0';) {
    char *end = nullptr;
    levels.push_back(static_cast<int>(std::strtol(p, &end, 10)));
    p = *end == ',' ? end + 1 : end;
    if (end == p && *p != '\0') break;
  }
  if (levels.empty()) levels.push_back(grc::rs::kSiblingGzipLevel);
  const int threads = argc > 4 ? std::atoi(argv[4]) : 0;
  std::ifstream in(argv[1], std::ios::binary);
  const std::vector<std::uint8_t> data((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  // A file that already is a GRT1 body (e.g. a `block` variant with its format meta) is used as is.
  static const std::uint8_t kGrt1[8] = {'G', 'R', 'T', '1', '\r', '\n', 0x1a, '\n'};
  std::vector<std::uint8_t> grt1;
  if (data.size() > 8 && std::equal(kGrt1, kGrt1 + 8, data.begin())) {
    grt1 = data;
  } else {
    grt1 = {'G', 'R', 'T', '1', '\r', '\n', 0x1a, '\n', 2, 0, 0, 0, '{', '}'};
    for (int shift = 0; shift < 32; shift += 8) grt1.push_back(static_cast<std::uint8_t>((data.size() >> shift) & 0xff));
    grt1.insert(grt1.end(), data.begin(), data.end());
  }
  std::string error;
  if (!grc::rs::net_init(&error)) return 1;
  {
    const auto t = Clock::now();
    std::vector<std::uint8_t> ref;
    grc::rs::http_coding::gzip_compress(grt1.data(), grt1.size(), &ref);
    std::printf("reference single-stream gzip-%d: %.1f ms, %zu bytes\n", grc::rs::http_coding::kGzipLevel, ms_since(t),
                ref.size());
  }
  const std::string hash(64, 'a');
  // Mode 0: single coding; then one dual run per level.
  for (std::size_t mode_i = 0; mode_i <= levels.size(); ++mode_i) {
    const bool dual = mode_i > 0;
    const int level = dual ? levels[mode_i - 1] : 0;
    const std::string mode = dual ? "dual-l" + std::to_string(level) : "single";
    grc::rs::set_sibling_tuning(level, 0, threads);
    for (int r = 0; r < repeats; ++r) {
      grc::rs::RestConfig rest;
      rest.coding = grc::rs::RestCoding::Zstd;
      rest.sibling = dual ? grc::rs::RestCoding::Gzip : grc::rs::RestCoding::Identity;
      grc::rs::set_rest_config(rest);
      grc::rs::PayloadPtr body = std::make_shared<grc::rs::PayloadBytes>(grt1.begin(), grt1.end());
      const auto tc = Clock::now();
      grc::rs::code_at_rest(&body);
      const double code_ms = ms_since(tc);
      Pool pool(1);
      grc::rs::ServedResources served;
      served.set_sibling_submit([&pool](std::function<void()> w) { return pool.submit(std::move(w)); });
      grc::rs::PayloadMap map = {{hash, body}};
      std::vector<grc::rs::ServeEvent> events;
      grc::live::Server server;
      grc::live::ServerConfig config;
      config.codings = {grc::live::Coding::Zstd};
      if (dual) config.codings.push_back(grc::live::Coding::Gzip);
      if (!server.start(config, &served, &error)) return 1;
      const std::string path = config.resource_prefix + hash;
      if (r == 0 && !dual) {
        std::printf("%-8s identity_bytes=%zu zstd_bytes=%zu zstd_code_ms=%.1f\n", mode.c_str(), grt1.size(),
                    body->size(), code_ms);
      }
      // The pin queues the encode; the GET goes out at once, as a client's does after the publication.
      const auto tp = Clock::now();
      served.pin({&map}, 1, &events);
      print(mode, "gzip,deflate (at pin)", get(server.port(), path, "gzip, deflate"));
      double ready_ms = -1;
      if (dual) {
        while (grc::rs::rest_stats().sibling.made + grc::rs::rest_stats().sibling.not_smaller +
                       grc::rs::rest_stats().sibling.failed ==
                   0 &&
               ms_since(tp) < 30000) {
          std::this_thread::sleep_for(std::chrono::microseconds(200));
        }
        ready_ms = ms_since(tp);
      }
      print(mode, "gzip,deflate (ready)", get(server.port(), path, "gzip, deflate"));
      print(mode, "zstd", get(server.port(), path, "gzip, deflate, br, zstd"));
      server.stop(1000);
      const grc::rs::RestStats st = grc::rs::rest_stats();
      if (dual) {
        std::printf("%-8s encode level=%d threads=%d block=%zu made=%llu streamed=%llu gzip_bytes=%llu encode_ms=%.1f "
                    "pin_to_ready_ms=%.1f inflate_ms=%.1f\n",
                    mode.c_str(), level, threads > 0 ? threads : grc::rs::default_sibling_threads(),
                    grc::rs::kSiblingBlockBytes, static_cast<unsigned long long>(st.sibling.made),
                    static_cast<unsigned long long>(st.sibling.streamed),
                    static_cast<unsigned long long>(st.sibling.out_bytes), st.sibling.ns / 1e6, ready_ms,
                    st.inflate[static_cast<std::size_t>(grc::rs::InflateSite::Sibling)].ns / 1e6);
      }
      grc::rs::reset_rest_stats();
    }
  }
  grc::rs::set_sibling_tuning(0, 0, 0);
  grc::rs::net_release();
  return 0;
}
