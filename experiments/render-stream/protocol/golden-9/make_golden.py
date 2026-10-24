#!/usr/bin/env python3
"""Generate the render-stream/9 golden vectors (stdlib only, deterministic).

render-stream/9 (../render-stream-9.md) is render-stream/8 plus exactly texture-delivery-design.md
Q5's list: the GRS9 magic and protocol string, the session key `resources.texture_delivery`,
texture-entry `variants`, `block` GRT1 payloads and `render-stream-texture/ktx2` payloads (both
legal as variants only), the texture reason `delivery-pending`, and the hello keys
`texture_encodings` and `gpu_formats`.

    python3 make_golden.py           # (re)write every output beside this file
    python3 make_golden.py --check   # verify the committed outputs, write nothing

Like golden-8 this builds on the earlier generators (it loads golden-8's make_golden.py, which loads
golden-6's, and re-binds the few places whose wire shape changes at /9), so /9's records are /8's
byte for byte except where Q5 says otherwise. The shared scene is golden-8's six states plus two:

    7 (new) adds texture 11 (RGBA8 16x16 with a mip chain, version 1) with one variant (`block`,
       DXT5), item 9 drawing it, and gives texture 7 (the host-decoded DXT5 texture, version 1) its
       `block` variant: a variant appearing at an equal version (texture-delivery-design.md D6).
    8 (new) texture 11 and texture 7 each gain a `uastc` variant at the same version (the lazy
       encode finishing); texture 6's content changes (version 3, the old hash back) so its variants
       reset to []; texture 12 is an unsupported image with reason `delivery-pending`.

The KTX2 payloads are NOT built here. `ktx2-16x16-mips.ktx2` and `ktx2-4x4.ktx2` are real UASTC
LDR 4x4 + Zstandard files that Godot 4.5.1's editor binary (its vendored basisu) wrote from
procedural images; `gen_ktx2.gd` is the committed generator and its two outputs are committed under
payloads/. They are synthetic and never game content. This script only reads them.

full.rs9 encodes all eight states as full transactions (directory delivery); patch.rs9 patch-encodes
them (seq 1 full, seq 5 a full resync, every other seq a patch); inline.rs9 encodes them as full
transactions with inline delivery, and carries the variants' payloads as resource records too.
All three resolve to resolved.json. The session declares mode "basis-uastc", encoder "basisu-1.60".

off.rs9 is a separate small recording: mode "rgba", encoder null, a websocket stream. It resolves to
resolved-off.json.

control/ holds the /9 hello vectors; invalid/ covers exactly /9's failure modes (see index.json).
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
GOLDEN8 = HERE.parent / "golden-8"
G8_SPEC = importlib.util.spec_from_file_location("golden8_make_golden", GOLDEN8 / "make_golden.py")
g8 = importlib.util.module_from_spec(G8_SPEC)
sys.modules["golden8_make_golden"] = g8
G8_SPEC.loader.exec_module(g8)  # type: ignore[union-attr]
g6 = g8.g6

MAGIC = bytes([0x47, 0x52, 0x53, 0x39, 0x0D, 0x0A, 0x1A, 0x0A])  # "GRS9\r\n\x1a\n"
PROTOCOL = "render-stream/9"
g6.MAGIC = MAGIC
g6.PROTOCOL = PROTOCOL
g8.PROTOCOL = PROTOCOL

# --------------------------------------------------------------------------- payloads

KTX2_16 = (HERE / "payloads" / "ktx2-16x16-mips.ktx2").read_bytes()
KTX2_4 = (HERE / "payloads" / "ktx2-4x4.ktx2").read_bytes()
HASH_KTX2_16 = hashlib.sha256(KTX2_16).hexdigest()
HASH_KTX2_4 = hashlib.sha256(KTX2_4).hexdigest()

# texture 11's decoded payload: RGBA8 16x16 with a full mip chain.
PAYLOAD_MIP16 = g6.build_payload("RGBA8", 16, 16, True, g6.mip_pattern_rgba8(16, 16, True))
HASH_MIP16 = g6.payload_sha256(PAYLOAD_MIP16)


def _block_bytes(count: int, seed: int) -> bytes:
    # Deterministic stand-in block data (the validators check sizes, never block contents).
    return bytes((seed + i * 37 + (i >> 3) * 11) & 0xFF for i in range(count))


# DXT5: 16 bytes per 4x4 block. 4x4 = 1 block; 16x16 with mips = 16 + 4 + 1 + 1 + 1 = 23 blocks.
PAYLOAD_DXT5_4 = g6.build_payload("DXT5", 4, 4, False, _block_bytes(16, 3))
PAYLOAD_DXT5_16M = g6.build_payload("DXT5", 16, 16, True, _block_bytes(23 * 16, 5))
HASH_DXT5_4 = g6.payload_sha256(PAYLOAD_DXT5_4)
HASH_DXT5_16M = g6.payload_sha256(PAYLOAD_DXT5_16M)

ENCODER = "basisu-1.60"
PARAMS_UASTC = "basisu-1.60/uastc-l1/zstd6/linear"

# --------------------------------------------------------------------------- re-bound encoders

g8_texture_json = g6._texture_json


def _texture_json(texture_id: int, t: dict) -> dict:
    out = g8_texture_json(texture_id, t)
    ordered = {}
    for key, value in out.items():
        ordered[key] = value
        if key == "payload_bytes":
            ordered["variants"] = [
                {"encoding": v["encoding"], "hash": v["hash"], "payload_bytes": v["payload_bytes"],
                 "format": v["format"], "params": v["params"]}
                for v in t.get("variants", [])
            ]
    return ordered


g6._texture_json = _texture_json
g8_texture_differs = g6.texture_differs


def _texture_differs(a: dict, b: dict) -> bool:
    return g8_texture_differs(a, b) or a.get("variants", []) != b.get("variants", [])


g6.texture_differs = _texture_differs


def variant(encoding: str, hash_hex: str, payload_bytes: int, *, format: str | None = None,
            params: str | None = None) -> dict:
    return {"encoding": encoding, "hash": hash_hex, "payload_bytes": payload_bytes,
            "format": format, "params": params}


def block_variant(hash_hex: str, payload: bytes, fmt: str) -> dict:
    return variant("block", hash_hex, len(payload), format=fmt)


def uastc_variant(payload: bytes) -> dict:
    return variant("uastc", hashlib.sha256(payload).hexdigest(), len(payload), params=PARAMS_UASTC)


# --------------------------------------------------------------------------- session


def session_record(
    stream_id: str, transport: str, encoding: str, session_id: str, *, delivery: str,
    adoption: dict | None = {"mode": "arm", "frame": 12}, decode: str = "engine",
    sabotage: dict | None = None, mode: str = "basis-uastc", encoder: str | None = ENCODER,
    publication_mode: str = "every-frame", publication_target_fps: int | None = None,
    credit_window: int = 1,
) -> bytes:
    return g8.session_record(
        stream_id, transport, encoding, session_id, delivery=delivery, adoption=adoption,
        decode=decode, sabotage=sabotage, publication_mode=publication_mode,
        publication_target_fps=publication_target_fps, credit_window=credit_window,
        texture_delivery={"mode": mode, "encoder": encoder})


# --------------------------------------------------------------------------- the eight states


def state7() -> dict:
    state = {k: (dict(v) if isinstance(v, dict) else v) for k, v in g8.STATES[5].items()}
    textures = dict(state["textures"])
    tex7 = dict(textures[7])
    tex7["variants"] = [block_variant(HASH_DXT5_4, PAYLOAD_DXT5_4, "DXT5")]
    textures[7] = tex7
    textures[11] = dict(
        g6.texture(kind="image", version=1, hash=HASH_MIP16, format="RGBA8", width=16, height=16,
                   mipmaps=True, payload_bytes=len(PAYLOAD_MIP16)),
        variants=[block_variant(HASH_DXT5_16M, PAYLOAD_DXT5_16M, "DXT5")])
    state["textures"] = textures
    items = dict(state["items"])
    items[9] = g6.item(
        parent=("canvas", 1), children=[], xform=[1.0, 0.0, 0.0, 1.0, 160.0, 0.0], draw_index=7,
        content_version=1, commands=[g6.add_texture_rect(11, False, False, [0.0, 0.0, 16.0, 16.0])])
    state["items"] = items
    canvases = dict(state["canvases"])
    canvases[1] = g6.root_canvas([1, 2, 3, 4, 5, 8, 9])
    state["canvases"] = canvases
    return state


def state8() -> dict:
    state = state7()
    textures = dict(state["textures"])
    tex7 = dict(textures[7])
    tex7["variants"] = [block_variant(HASH_DXT5_4, PAYLOAD_DXT5_4, "DXT5"), uastc_variant(KTX2_4)]
    textures[7] = tex7
    tex11 = dict(textures[11])
    tex11["variants"] = [block_variant(HASH_DXT5_16M, PAYLOAD_DXT5_16M, "DXT5"),
                         uastc_variant(KTX2_16)]
    textures[11] = tex11
    tex6 = dict(textures[6])
    tex6.update(version=3, hash=g6.HASH_A1, payload_bytes=len(g6.PAYLOAD_A1), variants=[])
    textures[6] = tex6
    textures[12] = g6.texture(kind="image", status="unsupported", reason="delivery-pending",
                              version=1, width=4, height=4)
    state["textures"] = textures
    return state


STATES = list(g8.STATES) + [state7(), state8()]
for _s in STATES:
    for _t in _s["textures"].values():
        _t.setdefault("variants", [])

# --------------------------------------------------------------------------- decode / resolved


def decode(data: bytes) -> dict:
    out = g6.decode(data)
    out["schema"] = "render-stream-9-decoded/1"
    return out


def resolved_state(state: dict) -> dict:
    return g8.resolved_state(state)


# --------------------------------------------------------------------------- invalid vectors

MINI_SESSION = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
MINI_STREAM = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"


def mini_texture(**kw) -> dict:
    variants = kw.pop("variants", [])
    base = dict(kind="image", version=1, hash=g6.HASH_A1, format="RGBA8", width=16, height=16,
                payload_bytes=len(g6.PAYLOAD_A1))
    base.update(kw)
    return dict(g6.texture(**base), variants=variants)


def mini_recording(*, textures: dict, mode: str = "basis-uastc", encoder: str | None = ENCODER,
                   delivery: str = "out-of-band", resources=(), extra_state=None,
                   second_textures: dict | None = None) -> bytes:
    session = session_record(MINI_STREAM, "file", "full", MINI_SESSION, delivery=delivery,
                             adoption=None, decode="off", mode=mode, encoder=encoder)
    records = [session] + list(resources)
    states = [g8.mini_state(textures)]
    if second_textures is not None:
        states.append(g8.mini_state(second_textures))
    for i, state in enumerate(states):
        records.append(g6.full_transaction_bytes(i + 1, i + 1, state))
    end = g6.end_record(len(states), records, diff_ns_total=0, full_transactions=len(states),
                        patch_transactions=0, resource_records=len(list(resources)),
                        resource_bytes=0)
    return g6.recording(records, end)


def corrupt(data: bytes, offset: int, value: bytes) -> bytes:
    return data[:offset] + value + data[offset + len(value):]


def mip16_texture(variants: list[dict]) -> dict:
    return mini_texture(hash=HASH_MIP16, width=16, height=16, mipmaps=True,
                        payload_bytes=len(PAYLOAD_MIP16), variants=variants)


def ktx2_recording(ktx2: bytes, tex: dict | None = None, mode: str = "basis-uastc") -> bytes:
    h = hashlib.sha256(ktx2).hexdigest()
    texture = tex if tex is not None else mip16_texture([variant(
        "uastc", h, len(ktx2), params=PARAMS_UASTC)])
    base_hash, base_payload = ((g6.HASH_A1, g6.PAYLOAD_A1) if texture["hash"] == g6.HASH_A1
                               else (HASH_MIP16, PAYLOAD_MIP16))
    return mini_recording(
        textures={1: texture}, mode=mode, delivery="inline",
        resources=[g6.resource_record_bytes(base_hash, base_payload),
                   g6.resource_record_bytes(h, ktx2)])


def build_invalid_vectors() -> dict[str, tuple[bytes, str, str]]:
    out: dict[str, tuple[bytes, str, str]] = {}
    out["bad-magic"] = ((GOLDEN8 / "off.rs8").read_bytes(), "bad-magic",
                        "magic byte 3 is '8' (GRS8), not '9'")
    blk = block_variant(g6.HASH_A2, PAYLOAD_DXT5_4, "DXT5")
    uas = variant("uastc", g6.HASH_F, 300, params=PARAMS_UASTC)

    out["delivery-mode"] = (
        mini_recording(textures={1: mini_texture()}, mode="gzip"),
        "meta-schema", "resources.texture_delivery.mode is \"gzip\", not an offering mode")
    out["delivery-entry-mode"] = (
        mini_recording(textures={1: mini_texture(variants=[blk])}, mode="rgba", encoder=None),
        "delivery-entry", "a block variant in a session whose mode \"rgba\" offers none")
    out["delivery-entry-mode-uastc"] = (
        mini_recording(textures={1: mini_texture(variants=[uas])}, mode="passthrough"),
        "delivery-entry", "a uastc variant in a session whose mode \"passthrough\" does not offer it")
    out["delivery-entry-order"] = (
        mini_recording(textures={1: mini_texture(variants=[uas, blk])}),
        "delivery-entry", "variants are not sorted by encoding (uastc before block)")
    out["delivery-entry-duplicate"] = (
        mini_recording(textures={1: mini_texture(variants=[
            blk, block_variant(g6.HASH_P, PAYLOAD_DXT5_4, "DXT1")])}),
        "delivery-entry", "two block variants in one entry")
    out["delivery-entry-not-ok"] = (
        mini_recording(textures={1: dict(g6.texture(
            kind="image", status="unsupported", reason="unsupported-format", version=1,
            format="RGBAF", width=4, height=4), variants=[blk])}),
        "delivery-entry", "an unsupported entry carries a variant")
    out["delivery-entry-block-params"] = (
        mini_recording(textures={1: mini_texture(variants=[
            variant("block", g6.HASH_A2, 100, format="DXT5", params="x")])}),
        "delivery-entry", "a block variant with params non-null")
    out["delivery-entry-block-format"] = (
        mini_recording(textures={1: mini_texture(variants=[
            variant("block", g6.HASH_A2, 100, format="RGBA8")])}),
        "delivery-entry", "a block variant whose format RGBA8 is not a block format")
    out["delivery-entry-basis-format"] = (
        mini_recording(textures={1: mini_texture(variants=[
            variant("uastc", g6.HASH_F, 300, format="RGBA8", params=PARAMS_UASTC)])}),
        "delivery-entry", "a uastc variant with format non-null")
    out["delivery-entry-basis-params"] = (
        mini_recording(textures={1: mini_texture(variants=[
            variant("uastc", g6.HASH_F, 300, params="other-encoder/uastc")])}),
        "delivery-entry", "a uastc variant whose params do not start with the declared encoder")
    out["delivery-entry-no-encoder"] = (
        mini_recording(textures={1: mini_texture(variants=[uas])}, encoder=None),
        "delivery-entry", "a uastc variant in a session that declares no encoder")
    out["delivery-entry-block-base"] = (
        mini_recording(textures={1: mini_texture(
            hash=HASH_DXT5_4, format="DXT5", width=4, height=4,
            payload_bytes=len(PAYLOAD_DXT5_4))}),
        "delivery-entry", "an ok entry whose base payload is a block format (legal only as a variant)")
    out["delivery-entry-hash"] = (
        mini_recording(textures={1: mini_texture(variants=[block_variant(
            g6.HASH_A1, PAYLOAD_DXT5_4, "DXT5")])}),
        "delivery-entry", "a variant whose hash equals the base entry's hash")
    out["delivery-entry-bytes"] = (
        mini_recording(textures={1: mini_texture(variants=[
            variant("block", g6.HASH_A2, 0, format="DXT5")])}),
        "delivery-entry", "a variant with payload_bytes 0")
    out["variants-shrink"] = (
        mini_recording(textures={1: mini_texture(variants=[blk])},
                       second_textures={1: mini_texture(variants=[])}),
        "texture-version", "variants disappear at an equal version")
    out["variants-change"] = (
        mini_recording(textures={1: mini_texture(variants=[blk])},
                       second_textures={1: mini_texture(variants=[block_variant(
                           g6.HASH_P, PAYLOAD_DXT5_4, "DXT5")])}),
        "texture-version", "a variant's hash changes at an equal version")
    out["block-payload-size"] = (
        _block_payload_size_vector(),
        "payload-size", "a DXT5 4x4 block variant payload carries 32 data bytes, not 16")
    out["block-payload-shape"] = (
        _block_payload_shape_vector(),
        "resource-payload", "a block variant payload decodes as DXT5 8x8, the entry is 16x16")

    good = KTX2_16
    out["ktx2-header-vkformat"] = (
        ktx2_recording(corrupt(good, 12, struct.pack("<I", 37))), "ktx2-header",
        "vkFormat is 37, not 0 (UNDEFINED)")
    srgb = bytearray(good)
    dfd_offset = struct.unpack_from("<I", good, 48)[0]
    srgb[dfd_offset + 4 + 8 + 2] = 2  # transfer function byte: 2 = sRGB
    out["ktx2-header-transfer"] = (
        ktx2_recording(bytes(srgb)), "ktx2-header", "the DFD transfer function is sRGB, not linear")
    out["ktx2-header-truncated"] = (
        ktx2_recording(good[:60]), "ktx2-header", "the file ends inside the header")
    out["ktx2-header-level-range"] = (
        ktx2_recording(corrupt(good, 80, struct.pack("<Q", len(good) + 1000))), "ktx2-header",
        "level 0's byteOffset runs past the end of the file")
    out["ktx2-shape-size"] = (
        ktx2_recording(KTX2_4, mip16_texture([variant(
            "uastc", HASH_KTX2_4, len(KTX2_4), params=PARAMS_UASTC)])), "ktx2-shape",
        "a 4x4 KTX2 for a 16x16 entry")
    out["ktx2-shape-levels"] = (
        ktx2_recording(KTX2_16, mini_texture(variants=[variant(
            "uastc", HASH_KTX2_16, len(KTX2_16), params=PARAMS_UASTC)])), "ktx2-shape",
        "a 5-level KTX2 for an entry with mipmaps false")
    out["ktx2-shape-codec"] = (
        ktx2_recording(KTX2_16, mip16_texture([variant(
            "etc1s", HASH_KTX2_16, len(KTX2_16), params=ENCODER + "/etc1s")]),
            mode="basis-etc1s"), "ktx2-shape",
        "a UASTC + Zstandard file named as the etc1s variant")
    return out


def _block_payload_size_vector() -> bytes:
    bad = g6.build_payload("DXT5", 4, 4, False, _block_bytes(32, 3))
    h = g6.payload_sha256(bad)
    tex = mini_texture(variants=[block_variant(h, bad, "DXT5")])
    return mini_recording(textures={1: tex}, delivery="inline", resources=[
        g6.resource_record_bytes(g6.HASH_A1, g6.PAYLOAD_A1), g6.resource_record_bytes(h, bad)])


def _block_payload_shape_vector() -> bytes:
    wrong = g6.build_payload("DXT5", 8, 8, False, _block_bytes(64, 3))
    h = g6.payload_sha256(wrong)
    tex = mini_texture(variants=[block_variant(h, wrong, "DXT5")])
    return mini_recording(textures={1: tex}, delivery="inline", resources=[
        g6.resource_record_bytes(g6.HASH_A1, g6.PAYLOAD_A1), g6.resource_record_bytes(h, wrong)])


# --------------------------------------------------------------------------- control messages


def control_messages() -> dict[str, dict]:
    def hello(receiver: str, kind: str, enc: str, gpu: str, **extra) -> dict:
        return {
            "type": "hello", "protocol": PROTOCOL, "receiver": receiver, "receiver_kind": kind,
            "credit_stage": "submitted", "credit_window": 1, "inbound_buffer_bytes": 16777216,
            "token": None, "manifest_sha256": None, "presentation_backing_w": 640,
            "presentation_backing_h": 360, "presentation_css_w": 640, "presentation_css_h": 360,
            "dpr_milli": 1000, "texture_encodings": enc, "gpu_formats": gpu, **extra,
        }

    valid = {
        "hello-native-block": hello("gate9-native", "native", "block,decoded", "s3tc,bptc,rgtc"),
        "hello-gsw-uastc": hello("gate9-gsw-canvas", "gsw-canvas", "uastc,decoded", "etc2,astc"),
        "hello-web-export-decoded": hello("gate9-web-export", "web-export", "decoded", "none"),
        "hello-native-all": hello("gate9-native-all", "native",
                                  "uastc,etc1s,block,decoded", "s3tc,bptc,rgtc,etc2,astc"),
    }
    base = valid["hello-native-block"]
    long_list = ",".join(["abcdefgh"] * 11)  # 98 chars
    assert len(long_list) > 96
    invalid = {
        "hello-missing-encodings": {k: v for k, v in base.items() if k != "texture_encodings"},
        "hello-missing-gpu-formats": {k: v for k, v in base.items() if k != "gpu_formats"},
        "hello-encodings-uppercase": {**base, "texture_encodings": "Block,decoded"},
        "hello-encodings-empty": {**base, "texture_encodings": ""},
        "hello-gpu-formats-trailing-comma": {**base, "gpu_formats": "s3tc,"},
        "hello-gpu-formats-double-comma": {**base, "gpu_formats": "s3tc,,bptc"},
        "hello-gpu-formats-too-long": {**base, "gpu_formats": long_list},
        "hello-encodings-not-string": {**base, "texture_encodings": 1},
        "hello-wrong-protocol": {**base, "protocol": "render-stream/8"},
        "hello-unknown-key": {**base, "extra": 1},
    }
    return {"valid": valid, "invalid": invalid}


# --------------------------------------------------------------------------- build


def build() -> dict[str, bytes]:
    full_session = session_record("1" * 32, "file", "full", "0123456789abcdef0123456789abcdef",
                                  delivery="out-of-band")
    full_records = [full_session]
    for i, state in enumerate(STATES):
        full_records.append(g6.full_transaction_bytes(i + 1, i + 1, state))
    full_end = g6.end_record(len(STATES), full_records, diff_ns_total=0,
                             full_transactions=len(STATES), patch_transactions=0,
                             resource_records=0, resource_bytes=0)
    full_rs9 = g6.recording(full_records, full_end)

    patch_session = session_record("2" * 32, "file", "patch", "fedcba9876543210fedcba9876543210",
                                   delivery="out-of-band")
    patch_records = [patch_session, g6.full_transaction_bytes(1, 1, STATES[0])]
    for seq in (2, 3, 4):
        patch_records.append(g6.patch_transaction_bytes(seq, seq, seq - 1, STATES[seq - 2],
                                                        STATES[seq - 1]))
    patch_records.append(g6.full_transaction_bytes(5, 5, STATES[4]))  # resync: full again
    for seq in (6, 7, 8):
        patch_records.append(g6.patch_transaction_bytes(seq, seq, seq - 1, STATES[seq - 2],
                                                        STATES[seq - 1]))
    patch_end = g6.end_record(len(STATES), patch_records, diff_ns_total=12345,
                              full_transactions=2, patch_transactions=len(STATES) - 2,
                              resource_records=0, resource_bytes=0)
    patch_rs9 = g6.recording(patch_records, patch_end)

    inline_session = session_record("3" * 32, "file", "full", "22222222222222222222222222222222",
                                    delivery="inline")
    r = g6.resource_record_bytes
    inline_payloads: list[tuple[str, bytes]] = []

    def inline_resource(hash_hex: str, payload: bytes) -> bytes:
        inline_payloads.append((hash_hex, payload))
        return r(hash_hex, payload)

    records = [inline_session, inline_resource(g6.HASH_A1, g6.PAYLOAD_A1),
               inline_resource(g6.HASH_F, g6.PAYLOAD_F)]
    records.append(g6.full_transaction_bytes(1, 1, STATES[0]))
    records.append(g6.full_transaction_bytes(2, 2, STATES[1]))
    records.append(inline_resource(g6.HASH_A2, g6.PAYLOAD_A2))
    records.append(g6.full_transaction_bytes(3, 3, STATES[2]))
    records.append(inline_resource(g8.HASH_DEC, g8.PAYLOAD_DEC))
    records.append(inline_resource(g8.HASH_RGBAF, g8.PAYLOAD_RGBAF))
    records.append(inline_resource(g8.HASH_RH, g8.PAYLOAD_RH))
    records.append(inline_resource(g6.HASH_MESH1_A, g6.MESH1_SURFACE_A_PAYLOAD))
    records.append(inline_resource(g6.HASH_SHADER2_V1, g6.SHADER2_TINT_PAYLOAD_V1))
    records.append(g6.full_transaction_bytes(4, 4, STATES[3]))
    records.append(inline_resource(g6.HASH_MESH1_B, g6.MESH1_SURFACE_B_PAYLOAD))
    records.append(g6.full_transaction_bytes(5, 5, STATES[4]))
    records.append(g6.full_transaction_bytes(6, 6, STATES[5]))
    # State 7 names texture 11 (decoded + a block variant) and texture 7's block variant; state 8
    # adds the two uastc variants. Their payloads arrive as resource records, before first use.
    records.append(inline_resource(HASH_MIP16, PAYLOAD_MIP16))
    records.append(inline_resource(HASH_DXT5_16M, PAYLOAD_DXT5_16M))
    records.append(inline_resource(HASH_DXT5_4, PAYLOAD_DXT5_4))
    records.append(g6.full_transaction_bytes(7, 7, STATES[6]))
    records.append(inline_resource(HASH_KTX2_16, KTX2_16))
    records.append(inline_resource(HASH_KTX2_4, KTX2_4))
    records.append(g6.full_transaction_bytes(8, 8, STATES[7]))
    inline_end = g6.end_record(len(STATES), records, diff_ns_total=0,
                               full_transactions=len(STATES), patch_transactions=0,
                               resource_records=len(inline_payloads),
                               resource_bytes=sum(len(p) for _, p in inline_payloads))
    inline_rs9 = g6.recording(records, inline_end)

    off_state = g8.mini_state({})
    off_session = session_record(
        "4" * 32, "websocket", "full", "44444444444444444444444444444444",
        delivery="out-of-band", adoption=None, decode="off", mode="rgba", encoder=None,
        sabotage={"kind": "perturb-decode", "frame": 1, "op": None})
    off_records = [off_session, g6.full_transaction_bytes(1, 1, off_state)]
    off_end = g6.end_record(1, off_records, diff_ns_total=0, full_transactions=1,
                            patch_transactions=0, resource_records=0, resource_bytes=0)
    off_rs9 = g6.recording(off_records, off_end)

    full_decoded, patch_decoded = decode(full_rs9), decode(patch_rs9)
    inline_decoded, off_decoded = decode(inline_rs9), decode(off_rs9)
    resolved = {
        "schema": "render-stream-9-resolved/1",
        "transactions": [{"seq": i + 1, "frame": i + 1, "state": resolved_state(s)}
                         for i, s in enumerate(STATES)],
    }
    resolved_off = {
        "schema": "render-stream-9-resolved/1",
        "transactions": [{"seq": 1, "frame": 1, "state": resolved_state(off_state)}],
    }

    # Inline record_index values come from the decoded records, never from counting by hand.
    by_hash = {}
    for i, rec in enumerate(inline_decoded["records"]):
        if rec["meta"]["type"] == "resource":
            by_hash[rec["meta"]["hash"]] = i
    inline_resources = [{"hash": h, "bytes": len(p), "record_index": by_hash[h]}
                        for h, p in inline_payloads]

    seq3_offset = patch_decoded["records"][3]["offset"]
    corrupt_rs9 = bytearray(patch_rs9)
    assert corrupt_rs9[seq3_offset + 8] == ord("{")
    corrupt_rs9[seq3_offset + 8] = 0x00

    invalid = build_invalid_vectors()
    control = control_messages()
    payload_files = [
        ("a1.grt", g6.HASH_A1, g6.PAYLOAD_A1, "RGBA8", 16, 16, False),
        ("a2.grt", g6.HASH_A2, g6.PAYLOAD_A2, "RGBA8", 16, 16, False),
        ("f.grt", g6.HASH_F, g6.PAYLOAD_F, "LA8", 4, 4, False),
        ("dec.grt", g8.HASH_DEC, g8.PAYLOAD_DEC, "RGBA8", 4, 4, False),
        ("rgbaf.grt", g8.HASH_RGBAF, g8.PAYLOAD_RGBAF, "RGBAF", 2, 2, False),
        ("rh.grt", g8.HASH_RH, g8.PAYLOAD_RH, "RH", 3, 2, True),
        ("mip16.grt", HASH_MIP16, PAYLOAD_MIP16, "RGBA8", 16, 16, True),
        ("dxt5-4x4.grt", HASH_DXT5_4, PAYLOAD_DXT5_4, "DXT5", 4, 4, False),
        ("dxt5-16x16-mips.grt", HASH_DXT5_16M, PAYLOAD_DXT5_16M, "DXT5", 16, 16, True),
    ]
    ktx2_files = [
        ("ktx2-16x16-mips.ktx2", HASH_KTX2_16, KTX2_16, 16, 16, 5),
        ("ktx2-4x4.ktx2", HASH_KTX2_4, KTX2_4, 4, 4, 1),
    ]
    index = {
        "schema": "render-stream-9-golden-index/1",
        "protocol": PROTOCOL,
        "valid": [
            {"file": "full.rs9", "hex": "full.hex", "decoded": "full.decoded.json",
             "sha256": hashlib.sha256(full_rs9).hexdigest()},
            {"file": "patch.rs9", "hex": "patch.hex", "decoded": "patch.decoded.json",
             "sha256": hashlib.sha256(patch_rs9).hexdigest()},
            {"file": "inline.rs9", "hex": "inline.hex", "decoded": "inline.decoded.json",
             "sha256": hashlib.sha256(inline_rs9).hexdigest()},
        ],
        "resolved": "resolved.json",
        "off_leg": {"file": "off.rs9", "hex": "off.hex", "decoded": "off.decoded.json",
                    "sha256": hashlib.sha256(off_rs9).hexdigest(),
                    "resolved": "resolved-off.json"},
        "inline_resources": inline_resources,
        "corrupt": [
            {"file": "corrupt-meta.rs9", "code": "meta-json", "record_index": 3, "seq": 3,
             "description": "patch.rs9 transaction seq 3: first meta byte set to 0x00; framing intact"},
        ],
        "invalid": [
            {"file": f"invalid/{name}.rs9", "code": code, "description": description}
            for name, (_, code, description) in invalid.items()
        ],
        "control": {
            "valid": [f"control/valid/{name}.json" for name in control["valid"]],
            "invalid": [f"control/invalid/{name}.json" for name in control["invalid"]],
        },
        "payloads": [
            {"file": f"payloads/{name}", "hash": h, "format": fmt, "width": w, "height": hh,
             "mipmaps": mips, "bytes": len(p)}
            for name, h, p, fmt, w, hh, mips in payload_files
        ],
        "ktx2_payloads": [
            {"file": f"payloads/{name}", "hash": h, "width": w, "height": hh, "levels": levels,
             "bytes": len(p), "encoding": "uastc", "supercompression": "zstd"}
            for name, h, p, w, hh, levels in ktx2_files
        ],
        "mesh_payloads": [
            {"file": "payloads/mesh1-a.grm", "hash": g6.HASH_MESH1_A, "primitive": "triangles",
             "format": g6.MESH1_SURFACE_A_FORMAT, "vertex_count": 3, "index_count": 0,
             "bytes": len(g6.MESH1_SURFACE_A_PAYLOAD)},
            {"file": "payloads/mesh1-b.grm", "hash": g6.HASH_MESH1_B, "primitive": "triangles",
             "format": g6.MESH1_SURFACE_B_FORMAT, "vertex_count": 4, "index_count": 6,
             "bytes": len(g6.MESH1_SURFACE_B_PAYLOAD)},
        ],
        "shader_payloads": [
            {"file": "payloads/shader2-tint-v1.grp", "hash": g6.HASH_SHADER2_V1,
             "bytes": len(g6.SHADER2_TINT_PAYLOAD_V1)},
        ],
    }
    outputs: dict[str, bytes] = {
        "full.rs9": full_rs9, "full.hex": g6.to_hex(full_rs9).encode("ascii"),
        "full.decoded.json": g6.pretty(full_decoded),
        "patch.rs9": patch_rs9, "patch.hex": g6.to_hex(patch_rs9).encode("ascii"),
        "patch.decoded.json": g6.pretty(patch_decoded),
        "inline.rs9": inline_rs9, "inline.hex": g6.to_hex(inline_rs9).encode("ascii"),
        "inline.decoded.json": g6.pretty(inline_decoded),
        "off.rs9": off_rs9, "off.hex": g6.to_hex(off_rs9).encode("ascii"),
        "off.decoded.json": g6.pretty(off_decoded),
        "resolved.json": g6.pretty(resolved),
        "resolved-off.json": g6.pretty(resolved_off),
        "corrupt-meta.rs9": bytes(corrupt_rs9),
        "index.json": g6.pretty(index),
        "payloads/mesh1-a.grm": g6.MESH1_SURFACE_A_PAYLOAD,
        "payloads/mesh1-b.grm": g6.MESH1_SURFACE_B_PAYLOAD,
        "payloads/shader2-tint-v1.grp": g6.SHADER2_TINT_PAYLOAD_V1,
    }
    for name, _, p, *_ in payload_files:
        outputs[f"payloads/{name}"] = p
    for name, (data, _, _) in invalid.items():
        outputs[f"invalid/{name}.rs9"] = data
    for kind in ("valid", "invalid"):
        for name, msg in control[kind].items():
            outputs[f"control/{kind}/{name}.json"] = g6.pretty(msg)
    return outputs


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="verify committed outputs; write nothing")
    args = parser.parse_args()
    outputs = build()
    if args.check:
        bad = []
        for rel, data in outputs.items():
            path = HERE / rel
            if not path.is_file() or path.read_bytes() != data:
                bad.append(rel)
        if bad:
            print("make_golden: out of date: " + ", ".join(bad), file=sys.stderr)
            return 1
        print(f"make_golden: {len(outputs)} outputs match")
        return 0
    for rel, data in outputs.items():
        path = HERE / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    print(f"make_golden: wrote {len(outputs)} outputs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
