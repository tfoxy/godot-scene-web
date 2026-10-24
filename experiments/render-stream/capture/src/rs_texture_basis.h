// G8ku: the lazy Basis encodes (texture-delivery-design.md D6, D11, D13; rs_texture_delivery.h).
//
// Encodes run on their own capture-owned pool, `GRC_TEXTURE_ENCODE_WORKERS` threads (default 2) at
// nice +10, never on the RenderingServer caller and never on G8kw's copy/decode/hash pool: one
// UASTC encode takes seconds per Mpx, so sharing G8kw's FIFO would hold every decode (and with it
// publication) behind it. A job reads only its own immutable decoded payload (the mirror's
// shared GRT1 bytes), never the engine, the mirror or a sink.
#ifndef GRC_RS_TEXTURE_BASIS_H
#define GRC_RS_TEXTURE_BASIS_H

#include "rs_texture_delivery.h"
#include "rs_texture_worker.h"

namespace grc {
namespace rs {

// The process-wide encode pool (entry.cpp starts it for a /9 basis-uastc stream and stops it,
// discarding queued jobs, at stream end).
TextureWorkerPool &texture_encode_pool();

// One job on the calling thread: the decoded GRT1 payload's levels as RGBA8, UASTC at `level`,
// zstd 6, linear (D13), then the SHA-256 of the KTX2 bytes; under `corrupt` (G8kf, GRC_TEXTURE_ENCODE_FAULT=corrupt-ktx2) the first byte of level 0's Zstandard frame
// is flipped BEFORE hashing, so the hash matches the published bytes and the file passes every header
// check but Godot's transcoder refuses it (the cache is bypassed); under `perturb` (the perturb-ktx2
// fault) one byte is flipped after hashing. Finishes the job exactly once.
void run_basis_job(BasisJob *job, int level, bool perturb, bool corrupt = false);

// Queues `job` on the encode pool; false (the job untouched) when the pool is not running.
bool submit_basis_job(const BasisJobPtr &job, int level, bool perturb, bool corrupt = false);

}  // namespace rs
}  // namespace grc

#endif  // GRC_RS_TEXTURE_BASIS_H
