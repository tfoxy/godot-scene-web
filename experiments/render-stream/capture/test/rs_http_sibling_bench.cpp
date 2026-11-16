// Bench (not a ctest): one large texture body GET over loopback through the real server and
// ServedResources, as a plain-http LAN browser asks for it (`Accept-Encoding: gzip, deflate`).
//   single: GRC_HTTP_ENCODING=zstd -- the body is zstd at rest, so the GET inflates the identity
//           and sends it (the path before the dual default);
//   dual:   GRC_HTTP_ENCODING=zstd,gzip -- the pin queues the gzip sibling on the sibling pool; a
//           GET at once races it (the identity, unless the encode already ended), and one after
//           the encode ended gets the gzip body.
// A `zstd` GET is timed for reference. Usage: rs_http_sibling_bench <raw RGBA file> [repeats]
// (the file's bytes become one GRT1 payload's data). Prints one line per GET: wall ms to the
// response headers and to the last body byte, and the bytes on the wire.
#include "rs_platform.h"

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
  double body_ms = -1;
  std::size_t wire = 0;
  std::string coding = "identity";
};

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
      }
    }
    if (head_end != std::string::npos && buf.size() >= head_end + 4 + length) {
      out.body_ms = ms_since(t0);
      out.wire = length;
      break;
    }
  }
  grc::rs::socket_close(fd);
  return out;
}

void print(const char *mode, const char *what, const Timing &t) {
  std::printf("%-6s %-22s coding=%-8s headers_ms=%8.1f body_ms=%8.1f wire_bytes=%zu\n", mode, what,
              t.coding.c_str(), t.headers_ms, t.body_ms, t.wire);
}

}  // namespace

int main(int argc, char **argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: rs_http_sibling_bench <raw RGBA file> [repeats]\n");
    return 2;
  }
  const int repeats = argc > 2 ? std::atoi(argv[2]) : 3;
  std::ifstream in(argv[1], std::ios::binary);
  const std::vector<std::uint8_t> data((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  std::vector<std::uint8_t> grt1 = {'G', 'R', 'T', '1', '\r', '\n', 0x1a, '\n', 2, 0, 0, 0, '{', '}'};
  for (int shift = 0; shift < 32; shift += 8) grt1.push_back(static_cast<std::uint8_t>((data.size() >> shift) & 0xff));
  grt1.insert(grt1.end(), data.begin(), data.end());
  std::string error;
  if (!grc::rs::net_init(&error)) return 1;
  const std::string hash(64, 'a');
  for (int dual = 0; dual <= 1; ++dual) {
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
      const auto tp = Clock::now();
      served.pin({&map}, 1, &events);
      grc::live::Server server;
      grc::live::ServerConfig config;
      config.codings = {grc::live::Coding::Zstd};
      if (dual) config.codings.push_back(grc::live::Coding::Gzip);
      if (!server.start(config, &served, &error)) return 1;
      const std::string path = config.resource_prefix + hash;
      const char *mode = dual ? "dual" : "single";
      if (r == 0) {
        std::printf("%-6s identity_bytes=%zu zstd_bytes=%zu zstd_code_ms=%.1f\n", mode, grt1.size(), body->size(), code_ms);
      }
      print(mode, "gzip,deflate (at pin)", get(server.port(), path, "gzip, deflate"));
      double ready_ms = -1;
      if (dual) {
        while (grc::rs::rest_stats().sibling.made + grc::rs::rest_stats().sibling.not_smaller == 0 &&
               ms_since(tp) < 30000) {
          std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        ready_ms = ms_since(tp);
      }
      print(mode, "gzip,deflate (ready)", get(server.port(), path, "gzip, deflate"));
      print(mode, "zstd", get(server.port(), path, "gzip, deflate, br, zstd"));
      server.stop(1000);
      const grc::rs::RestStats st = grc::rs::rest_stats();
      if (dual && r == 0) {
        std::printf("%-6s sibling made=%llu out_bytes=%llu gzip_ms=%.1f pin_to_ready_ms=%.1f\n", mode,
                    static_cast<unsigned long long>(st.sibling.made),
                    static_cast<unsigned long long>(st.sibling.out_bytes), st.sibling.ns / 1e6, ready_ms);
      }
      grc::rs::reset_rest_stats();
    }
  }
  grc::rs::net_release();
  return 0;
}
