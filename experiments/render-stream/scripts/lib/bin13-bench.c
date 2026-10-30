// BIN-D (results/p3/bin-d.md): host and receiver CPU of /13's message variants, through the
// capture's own vendored zstd 1.5.7 and W11t's live settings (level 3, checksum, content size,
// the previous message as a raw prefix; rs_live_coding.cpp `compress_frame`).
//
// Inputs are `wire-budget.py bin13 --dump` files: a u32le count, then u32le length + bytes per
// message, the first message being the second's base.
//
//   bin13-bench zstd <variant.msgs> [repeats]   per message: coded B, encode µs, decode µs (min of
//                                               the repeats; reused contexts, as the hub)
//   bin13-bench zr <pred.msgs> <pred_zr.msgs> <min> [repeats]
//                                               the compact residual's zero-run coding: checks this
//                                               encoder's bytes equal wire-budget.py's, then times
//                                               encode and decode (min of the repeats)
//   bin13-bench frames <variant.msgs> <out>     writes the messages as W11t's live coding sends
//                                               them (the first alone, each next one in its
//                                               envelope against the one before), the input of
//                                               rs-core's `examples/coded_decode.rs`
//
// Build (no project build involved):
//   Z=experiments/render-stream/capture/vendor/zstd
//   cc -O2 -DZSTD_DISABLE_ASM=1 -DZSTD_LEGACY_SUPPORT=0 -I$Z -o bin13-bench (continued)
//      experiments/render-stream/scripts/lib/bin13-bench.c $Z/common/*.c $Z/compress/*.c (continued)
//      $Z/decompress/*.c
#define _POSIX_C_SOURCE 199309L
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "zstd.h"

typedef struct {
  uint32_t n;
  uint8_t **data;
  uint32_t *len;
} Msgs;

static Msgs load(const char *path) {
  Msgs m = {0, NULL, NULL};
  FILE *f = fopen(path, "rb");
  if (!f || fread(&m.n, 4, 1, f) != 1) {
    fprintf(stderr, "bin13-bench: cannot read %s\n", path);
    exit(2);
  }
  m.data = calloc(m.n, sizeof *m.data);
  m.len = calloc(m.n, sizeof *m.len);
  for (uint32_t i = 0; i < m.n; i++) {
    if (fread(&m.len[i], 4, 1, f) != 1) exit(2);
    m.data[i] = malloc(m.len[i] ? m.len[i] : 1);
    if (m.len[i] && fread(m.data[i], 1, m.len[i], f) != m.len[i]) exit(2);
  }
  fclose(f);
  return m;
}

static double now_us(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1e6 + t.tv_nsec / 1e3;
}

static int cmp_d(const void *a, const void *b) {
  double x = *(const double *)a, y = *(const double *)b;
  return x < y ? -1 : x > y;
}

static void summary(const char *name, double *v, uint32_t n) {
  double s = 0;
  for (uint32_t i = 0; i < n; i++) s += v[i];
  qsort(v, n, sizeof *v, cmp_d);
  printf("%s p50 %.1f p95 %.1f mean %.1f\n", name, v[n / 2], v[(uint32_t)(n * 0.95)], s / n);
}

static int bench_zstd(const char *path, int reps) {
  Msgs m = load(path);
  if (m.n < 2) return 2;
  ZSTD_CCtx *c = ZSTD_createCCtx();
  ZSTD_DCtx *d = ZSTD_createDCtx();
  uint32_t k = m.n - 1;
  double *enc = calloc(k, sizeof *enc), *dec = calloc(k, sizeof *dec), *coded = calloc(k, sizeof *coded),
         *raw = calloc(k, sizeof *raw);
  size_t cap = 0;
  for (uint32_t i = 0; i < m.n; i++)
    if (ZSTD_compressBound(m.len[i]) > cap) cap = ZSTD_compressBound(m.len[i]);
  uint8_t *out = malloc(cap), *back = malloc(cap);
  for (uint32_t i = 1; i < m.n; i++) {
    const uint8_t *base = m.data[i - 1];
    size_t bn = m.len[i - 1], n = 0;
    double be = 1e18, bd = 1e18;
    for (int r = 0; r < reps; r++) {
      double t0 = now_us();
      ZSTD_CCtx_reset(c, ZSTD_reset_session_and_parameters);
      ZSTD_CCtx_setParameter(c, ZSTD_c_compressionLevel, 3);
      ZSTD_CCtx_setParameter(c, ZSTD_c_checksumFlag, 1);
      ZSTD_CCtx_setParameter(c, ZSTD_c_contentSizeFlag, 1);
      if (bn >= 8) ZSTD_CCtx_refPrefix(c, base, bn);
      n = ZSTD_compress2(c, out, cap, m.data[i], m.len[i]);
      double t1 = now_us();
      if (ZSTD_isError(n)) return 3;
      ZSTD_DCtx_reset(d, ZSTD_reset_session_and_parameters);
      if (bn >= 8) ZSTD_DCtx_refPrefix(d, base, bn);
      size_t got = ZSTD_decompressDCtx(d, back, cap, out, n);
      double t2 = now_us();
      if (ZSTD_isError(got) || got != m.len[i] || memcmp(back, m.data[i], got) != 0) return 4;
      if (t1 - t0 < be) be = t1 - t0;
      if (t2 - t1 < bd) bd = t2 - t1;
    }
    enc[i - 1] = be;
    dec[i - 1] = bd;
    coded[i - 1] = (double)n;
    raw[i - 1] = (double)m.len[i];
  }
  printf("%s: %u messages, %d repeats\n", path, k, reps);
  summary("raw_B", raw, k);
  summary("zstd_B", coded, k);
  summary("encode_us", enc, k);
  summary("decode_us", dec, k);
  return 0;
}

static size_t put_uvarint(uint8_t *o, uint64_t v) {
  size_t n = 0;
  while (v >= 0x80) {
    o[n++] = (uint8_t)(v | 0x80);
    v >>= 7;
  }
  o[n++] = (uint8_t)v;
  return n;
}

static size_t get_uvarint(const uint8_t *p, uint64_t *v) {
  size_t n = 0;
  int s = 0;
  *v = 0;
  for (;;) {
    uint8_t b = p[n++];
    *v |= (uint64_t)(b & 0x7f) << s;
    if (!(b & 0x80)) return n;
    s += 7;
  }
}

// Zero runs of at least `min` bytes, as wire-budget.py zr_encode: tokens (zeros, n, n literals).
static size_t zr_encode(const uint8_t *b, size_t len, size_t min, uint8_t *o) {
  size_t p = 0, w = 0, zeros = 0, i = 0;
  while (i < len) {
    if (b[i] != 0) {
      i++;
      continue;
    }
    size_t j = i;
    while (j < len && b[j] == 0) j++;
    if (j - i >= min) {
      if (i > p || zeros) {
        w += put_uvarint(o + w, zeros);
        w += put_uvarint(o + w, i - p);
        memcpy(o + w, b + p, i - p);
        w += i - p;
      }
      zeros = j - i;
      p = j;
    }
    i = j;
  }
  if (len > p || zeros) {
    w += put_uvarint(o + w, zeros);
    w += put_uvarint(o + w, len - p);
    memcpy(o + w, b + p, len - p);
    w += len - p;
  }
  return w;
}

static size_t zr_decode(const uint8_t *c, size_t clen, uint8_t *o, size_t n) {
  size_t p = 0, w = 0;
  while (w < n && p < clen) {
    uint64_t z, k;
    p += get_uvarint(c + p, &z);
    p += get_uvarint(c + p, &k);
    memset(o + w, 0, z);
    w += z;
    memcpy(o + w, c + p, k);
    w += k;
    p += k;
  }
  return w;
}

// The zr files hold the three predicted blocks concatenated per transaction; each block is coded
// on its own, so the concatenation of codings is compared only in total length and decoded as a
// whole when its blocks' boundaries are unknown. This bench therefore codes the concatenation
// as one buffer (one block's worth of token overhead less per transaction, a few bytes).
static int bench_zr(const char *plain_path, const char *zr_path, size_t min, int reps) {
  Msgs p = load(plain_path), z = load(zr_path);
  if (p.n != z.n || p.n < 2) return 2;
  uint32_t k = p.n - 1;
  double *enc = calloc(k, sizeof *enc), *dec = calloc(k, sizeof *dec), *ratio = calloc(k, sizeof *ratio);
  size_t cap = 0;
  for (uint32_t i = 0; i < p.n; i++)
    if (p.len[i] * 2 + 64 > cap) cap = p.len[i] * 2 + 64;
  uint8_t *o = malloc(cap), *back = malloc(cap);
  long diff = 0;
  for (uint32_t i = 1; i < p.n; i++) {
    double be = 1e18, bd = 1e18;
    size_t w = 0;
    for (int r = 0; r < reps; r++) {
      double t0 = now_us();
      w = zr_encode(p.data[i], p.len[i], min, o);
      double t1 = now_us();
      size_t got = zr_decode(o, w, back, p.len[i]);
      double t2 = now_us();
      if (got != p.len[i] || memcmp(back, p.data[i], got) != 0) return 4;
      if (t1 - t0 < be) be = t1 - t0;
      if (t2 - t1 < bd) bd = t2 - t1;
    }
    diff += (long)w - (long)z.len[i];
    enc[i - 1] = be;
    dec[i - 1] = bd;
    ratio[i - 1] = p.len[i] ? (double)w / p.len[i] : 1;
  }
  printf("%s: %u transactions, min run %zu, %d repeats; C minus Python coded bytes, total %ld\n", plain_path, k,
         min, reps, diff);
  summary("zr_ratio", ratio, k);
  summary("zr_encode_us", enc, k);
  summary("zr_decode_us", dec, k);
  return 0;
}

// u32le count, then per message u32le length + (envelope ‖ frame): the envelope is the 16-byte
// skippable frame (magic 0x184D2A5B, seq, base_seq) that rs_live_coding.cpp writes.
static int write_frames(const char *path, const char *out_path) {
  Msgs m = load(path);
  ZSTD_CCtx *c = ZSTD_createCCtx();
  FILE *f = fopen(out_path, "wb");
  if (!f) return 2;
  fwrite(&m.n, 4, 1, f);
  for (uint32_t i = 0; i < m.n; i++) {
    size_t cap = ZSTD_compressBound(m.len[i]) + 24;
    uint8_t *o = malloc(cap);
    uint32_t magic = 0x184D2A5B, sz = 16;
    uint64_t seq = i + 1, base = i;  // message 0 is seq 1 with no base; i is coded against i - 1
    memcpy(o, &magic, 4);
    memcpy(o + 4, &sz, 4);
    memcpy(o + 8, &seq, 8);
    memcpy(o + 16, &base, 8);
    ZSTD_CCtx_reset(c, ZSTD_reset_session_and_parameters);
    ZSTD_CCtx_setParameter(c, ZSTD_c_compressionLevel, 3);
    ZSTD_CCtx_setParameter(c, ZSTD_c_checksumFlag, 1);
    ZSTD_CCtx_setParameter(c, ZSTD_c_contentSizeFlag, 1);
    if (i > 0 && m.len[i - 1] >= 8) ZSTD_CCtx_refPrefix(c, m.data[i - 1], m.len[i - 1]);
    size_t n = ZSTD_compress2(c, o + 24, cap - 24, m.data[i], m.len[i]);
    if (ZSTD_isError(n)) return 3;
    uint32_t len = (uint32_t)(n + 24);
    fwrite(&len, 4, 1, f);
    fwrite(o, 1, len, f);
    free(o);
  }
  fclose(f);
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 4 && strcmp(argv[1], "frames") == 0) return write_frames(argv[2], argv[3]);
  if (argc >= 3 && strcmp(argv[1], "zstd") == 0) return bench_zstd(argv[2], argc > 3 ? atoi(argv[3]) : 5);
  if (argc >= 5 && strcmp(argv[1], "zr") == 0)
    return bench_zr(argv[2], argv[3], (size_t)atoi(argv[4]), argc > 5 ? atoi(argv[5]) : 5);
  fprintf(stderr, "usage: bin13-bench zstd <variant.msgs> [repeats] | zr <pred.msgs> <pred_zr.msgs> <min> [repeats]\n");
  return 2;
}
