// rs_mem_carrier: see rs_mem_carrier.h (CAR6).
#include "rs_mem_carrier.h"

#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace grc {
namespace test {
namespace {

struct Item {
  enum Kind { Binary, Text, Close } kind = Binary;
  std::uint32_t local = 0;
  grc_buf buf{nullptr, 0, nullptr};
  std::uint16_t code = 0;
  std::string reason;
};

struct ConnStats {
  bool admitted = false;
  bool opened = false;
  std::uint64_t messages = 0;
  std::uint64_t texts = 0;
  std::vector<std::uint8_t> bytes;
  int close_code = -1;
  std::string close_reason;
  std::uint64_t queued = 0;
  std::uint64_t max_queued = 0;
  bool closing = false;
};

struct Mem {
  MemCarrierOptions opt;
  int *starts = nullptr;
  int *destroys = nullptr;
  const grc_carrier_host_v1 *host = nullptr;
  std::uint64_t limit = 16u << 20;
  std::mutex mu;
  std::condition_variable cv;
  std::deque<Item> inbox;
  std::map<std::uint32_t, ConnStats> conns;
  bool stopping = false;
  std::thread client;
  std::uint64_t binaries_seen = 0;
  std::uint64_t double_releases = 0;
  std::uint64_t admit_refused = 0;
};

void client_main(Mem *m) {
  const grc_carrier_host_v1 *h = m->host;
  for (int i = 1; i <= m->opt.connections; ++i) {
    const auto local = static_cast<std::uint32_t>(i);
    if (h->admit(h->host, local) == 0) {
      std::lock_guard<std::mutex> lock(m->mu);
      ++m->admit_refused;
      continue;
    }
    {
      std::lock_guard<std::mutex> lock(m->mu);
      m->conns[local].admitted = true;
      m->conns[local].opened = true;
    }
    h->opened(h->host, local, m->opt.subprotocol.data(), m->opt.subprotocol.size(), nullptr, 0);
    if (!m->opt.hello.empty()) h->text(h->host, local, m->opt.hello.data(), m->opt.hello.size());
  }
  for (;;) {
    Item item;
    {
      std::unique_lock<std::mutex> lock(m->mu);
      m->cv.wait(lock, [m] { return m->stopping || !m->inbox.empty(); });
      if (m->inbox.empty()) return;  // stopping, nothing left
      item = std::move(m->inbox.front());
      m->inbox.pop_front();
    }
    bool echo_close = false;
    bool twice = false;
    {
      std::lock_guard<std::mutex> lock(m->mu);
      ConnStats &c = m->conns[item.local];
      if (item.kind == Item::Binary) {
        c.queued -= item.buf.len;
        ++c.messages;
        c.bytes.insert(c.bytes.end(), item.buf.data, item.buf.data + item.buf.len);
        ++m->binaries_seen;
        twice = m->opt.fault == "double-release" && m->binaries_seen == 3;
      } else if (item.kind == Item::Text) {
        c.queued -= item.buf.len;
        ++c.texts;
      } else {
        c.close_code = item.code;
        c.close_reason = item.reason;
        c.opened = false;
        echo_close = true;
      }
    }
    if (item.kind != Item::Close) {
      h->release(h->host, item.buf.owner);
      if (twice) {
        h->release(h->host, item.buf.owner);  // the sabotage
        std::lock_guard<std::mutex> lock(m->mu);
        ++m->double_releases;
      }
    }
    if (echo_close) {
      // A close handshake's answer: the peer echoes the code, after every earlier message.
      h->closed(h->host, item.local, item.code, item.reason.data(), item.reason.size());
    }
  }
}

std::string json_escape(const std::string &s) {
  std::string out;
  for (char ch : s) {
    if (ch == '"' || ch == '\\') {
      out += '\\';
      out += ch;
    } else if (static_cast<unsigned char>(ch) < 0x20) {
      char buf[8];
      std::snprintf(buf, sizeof(buf), "\\u%04x", ch);
      out += buf;
    } else {
      out += ch;
    }
  }
  return out;
}

void write_results(Mem *m) {
  if (m->opt.out_dir.empty()) return;
  std::string json = "{\"schema\":\"rs-mem-carrier/1\",\"name\":\"" + json_escape(m->opt.name) +
                     "\",\"fault\":\"" + json_escape(m->opt.fault) +
                     "\",\"admit_refused\":" + std::to_string(m->admit_refused) +
                     ",\"double_releases\":" + std::to_string(m->double_releases) +
                     ",\"connections\":[";
  bool first = true;
  for (const auto &entry : m->conns) {
    const ConnStats &c = entry.second;
    const std::string bin =
        m->opt.out_dir + "/mem-" + m->opt.name + "-" + std::to_string(entry.first) + ".bin";
    if (FILE *f = std::fopen(bin.c_str(), "wb")) {
      if (!c.bytes.empty()) std::fwrite(c.bytes.data(), 1, c.bytes.size(), f);
      std::fclose(f);
    }
    json += std::string(first ? "" : ",") + "{\"local\":" + std::to_string(entry.first) +
            ",\"messages\":" + std::to_string(c.messages) + ",\"texts\":" + std::to_string(c.texts) +
            ",\"bytes\":" + std::to_string(c.bytes.size()) + ",\"max_queued\":" +
            std::to_string(c.max_queued) + ",\"close_code\":" + std::to_string(c.close_code) +
            ",\"close_reason\":\"" + json_escape(c.close_reason) + "\",\"file\":\"" +
            json_escape(bin) + "\"}";
    first = false;
  }
  json += "]}\n";
  const std::string path = m->opt.out_dir + "/mem-" + m->opt.name + ".json";
  if (FILE *f = std::fopen(path.c_str(), "wb")) {
    std::fwrite(json.data(), 1, json.size(), f);
    std::fclose(f);
  }
}

Mem *mem(void *self) { return static_cast<Mem *>(self); }

int c_start(void *self, const grc_carrier_host_v1 *host, char *error, std::size_t cap) {
  Mem *m = mem(self);
  if (m->starts != nullptr) ++*m->starts;
  if (host == nullptr || host->abi_version != GRC_CARRIER_ABI_VERSION ||
      host->size < sizeof(grc_carrier_host_v1)) {
    std::snprintf(error, cap, "mem: host struct not accepted");
    return 0;
  }
  m->host = host;
  if (const char *q = host->config(host->host, "max_queued_bytes")) {
    m->limit = std::strtoull(q, nullptr, 10);
  }
  m->client = std::thread(client_main, m);
  return 1;
}

void c_stop(void *self) {
  Mem *m = mem(self);
  {
    std::lock_guard<std::mutex> lock(m->mu);
    m->stopping = true;
  }
  m->cv.notify_all();
  if (m->client.joinable()) m->client.join();
  // The client drained the inbox before it returned; anything a racing send added is released.
  std::deque<Item> left;
  {
    std::lock_guard<std::mutex> lock(m->mu);
    left.swap(m->inbox);
  }
  for (const Item &item : left) {
    if (item.kind != Item::Close) m->host->release(m->host->host, item.buf.owner);
  }
  write_results(m);
}

int c_send(void *self, std::uint32_t local, grc_buf message, Item::Kind kind) {
  Mem *m = mem(self);
  bool ok = false;
  {
    std::lock_guard<std::mutex> lock(m->mu);
    const auto it = m->conns.find(local);
    if (!m->stopping && it != m->conns.end() && it->second.opened && !it->second.closing &&
        it->second.queued + message.len <= m->limit) {
      Item item;
      item.kind = kind;
      item.local = local;
      item.buf = message;
      m->inbox.push_back(item);
      it->second.queued += message.len;
      if (it->second.queued > it->second.max_queued) it->second.max_queued = it->second.queued;
      ok = true;
    }
  }
  if (ok) {
    m->cv.notify_one();
  } else {
    m->host->release(m->host->host, message.owner);
  }
  return ok ? 1 : 0;
}

int c_send_binary(void *self, std::uint32_t local, grc_buf message) {
  return c_send(self, local, message, Item::Binary);
}

int c_send_text(void *self, std::uint32_t local, grc_buf message) {
  return c_send(self, local, message, Item::Text);
}

void c_close(void *self, std::uint32_t local, std::uint16_t code, const char *reason,
             std::size_t len) {
  Mem *m = mem(self);
  {
    std::lock_guard<std::mutex> lock(m->mu);
    const auto it = m->conns.find(local);
    if (m->stopping || it == m->conns.end() || it->second.closing || !it->second.opened) return;
    it->second.closing = true;
    Item item;
    item.kind = Item::Close;
    item.local = local;
    item.code = code;
    item.reason.assign(reason != nullptr ? reason : "", reason != nullptr ? len : 0);
    m->inbox.push_back(std::move(item));
  }
  m->cv.notify_one();
}

std::uint64_t c_queued(void *self, std::uint32_t local) {
  Mem *m = mem(self);
  std::lock_guard<std::mutex> lock(m->mu);
  const auto it = m->conns.find(local);
  return it != m->conns.end() ? it->second.queued : 0;
}

std::uint64_t c_max_queued(void *self, std::uint32_t local) {
  Mem *m = mem(self);
  std::lock_guard<std::mutex> lock(m->mu);
  const auto it = m->conns.find(local);
  return it != m->conns.end() ? it->second.max_queued : 0;
}

void c_destroy(void *self) {
  Mem *m = mem(self);
  if (m->destroys != nullptr) ++*m->destroys;
  if (m->client.joinable()) {  // destroyed without a stop (never happens through the capture)
    {
      std::lock_guard<std::mutex> lock(m->mu);
      m->stopping = true;
    }
    m->cv.notify_all();
    m->client.join();
  }
  delete m;
}

}  // namespace

grc_carrier_v1 make_mem_carrier(const MemCarrierOptions &options, int *stats_starts,
                                int *stats_destroys) {
  Mem *m = new Mem();
  m->opt = options;
  m->starts = stats_starts;
  m->destroys = stats_destroys;
  grc_carrier_v1 vt;
  std::memset(&vt, 0, sizeof(vt));
  vt.abi_version = GRC_CARRIER_ABI_VERSION;
  vt.size = sizeof(grc_carrier_v1);
  vt.name = m->opt.name.c_str();
  vt.self = m;
  vt.start = &c_start;
  vt.stop = &c_stop;
  vt.send_binary = &c_send_binary;
  vt.send_text = &c_send_text;
  vt.close = &c_close;
  vt.queued_bytes = &c_queued;
  vt.max_queued_bytes = &c_max_queued;
  vt.destroy = &c_destroy;
  return vt;
}

}  // namespace test
}  // namespace grc
