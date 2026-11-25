#include "banks.hpp"
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <vector>
using namespace grc::fmod;
namespace {
void check(bool value, const char *message) { if (!value) throw std::runtime_error(message); }
using Bytes = std::vector<unsigned char>;
void put(Bytes &v, std::uint64_t n, unsigned width) {
  for (unsigned i = 0; i < width; ++i) { v.push_back(n & 255); n >>= 8; }
}
Bytes fixture(unsigned version, unsigned pack_flags = 0, unsigned entry_flags = 0) {
  Bytes v;
  put(v, 0x43504447, 4); put(v, version, 4);
  put(v, 4, 4); put(v, 5, 4); put(v, 1, 4);
  put(v, pack_flags, 4); put(v, 512, 8);
  if (version == 3) put(v, 100, 8);
  v.resize(version == 3 ? 100 : 96);
  put(v, 2, 4);
  for (const char *name : {"audio/z.bank", "res://audio/a.bank"}) {
    const std::string path(name);
    put(v, path.size(), 4); v.insert(v.end(), path.begin(), path.end());
    put(v, 0, 8); put(v, 8, 8);
    for (unsigned i = 0; i < 16; ++i) v.push_back(i);
    put(v, entry_flags, 4);
  }
  v.resize(512);
  const char payload[] = "abcdefgh";
  v.insert(v.end(), payload, payload + 8);
  return v;
}
void write(const std::filesystem::path &path, const Bytes &bytes) {
  std::ofstream out(path, std::ios::binary);
  out.write(reinterpret_cast<const char *>(bytes.data()), bytes.size());
}
void refuses(const std::filesystem::path &path, const char *reason) {
  try { Pck p(path.string(), ""); } catch (const std::exception &e) {
    check(e.what() == std::string(reason), "wrong refusal reason"); return;
  }
  throw std::runtime_error("unsupported PCK was accepted");
}
}
int main(int argc, char **argv) {
  try {
    check(argc == 2, "test needs scratch directory");
    const auto path = std::filesystem::path(argv[1]) / "synthetic.pck";
    for (unsigned version : {2, 3}) {
      write(path, fixture(version));
      Pck p(path.string(), "");
      check(p.entries().size() == 2, "bank census");
      check(p.entries()[0].path == "res://audio/z.bank", "res prefix");
      unsigned got = 0;
      char out[16]{};
      check(p.read(p.entries()[0], 2, out, 12, got) && got == 6 && !std::memcmp(out, "cdefgh", 6), "partial EOF");
      check(!p.read(p.entries()[0], 9, out, 1, got) && got == 0, "seek bound");
      Pck selected(path.string(), "res://audio/a.bank");
      check(selected.entries().size() == 1, "explicit bank selection");
      auto entries = p.entries();
      const auto hash = bankset_hash(entries);
      std::swap(entries[0], entries[1]);
      check(bankset_hash(entries) == hash, "bankset path order");
      check(hash == "237bb8dd3bd55226b4d5a1fe156816ca", "bankset domain/vector");
      entries[0].md5[0] ^= 1;
      check(bankset_hash(entries) != hash, "bankset digest sensitivity");
      entries[0].path += "x";
      check(bankset_hash(entries) != hash, "bankset path sensitivity");
      write(path, fixture(version, 1)); refuses(path, "bank-encrypted");
      write(path, fixture(version, 4)); refuses(path, "bank-compressed");
      write(path, fixture(version, 0, 1)); refuses(path, "bank-encrypted");
      write(path, fixture(version, 0, 2)); refuses(path, "bank-compressed");
      auto truncated = fixture(version); truncated.resize(519); write(path, truncated); refuses(path, "bank-load");
      auto huge = fixture(version); huge[28] = 255; write(path, huge); refuses(path, "bank-load");
    }
    Bytes compressed;
    put(compressed, 0x504d4347, 4);
    write(path, compressed);
    refuses(path, "bank-compressed");
    std::filesystem::remove(path);
    std::cout << "PASS pck: v2/v3, selection, positional reads, refusal guards and bankset vector\n";
  } catch (const std::exception &e) { std::cerr << "FAIL " << e.what() << '\n'; return 1; }
}
