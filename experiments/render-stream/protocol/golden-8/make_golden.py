#!/usr/bin/env python3
"""Generate the render-stream/8 golden vectors (stdlib only, deterministic).

render-stream/8 (../render-stream-8.md) is render-stream/7 plus exactly gate8-design.md Q6's list:
the GRS8 magic and protocol string, the session key `adoption`, `resources.decode`, the
`origin` field "adopted" in the texture/mesh/shader/material tables, `adopted_content` on texture
and mesh entries, `source_format` on texture entries, the eight float payload formats, and seven
new sabotage kinds.

    python3 make_golden.py           # (re)write every output beside this file
    python3 make_golden.py --check   # verify the committed outputs, write nothing

Like golden-7 this script builds on golden-6's (it loads golden-6/make_golden.py as a module and
re-binds the few places whose wire shape changes at /8), so /8's records are /6's byte for byte
except where Q6 says otherwise. Unlike golden-7 it needs a full/patch/inline triple, because the
resource tables change shape. The shared scene is golden-6's states 1-3 (seq 1-3) plus three
new states:

    4 (new) adds, to state 3: texture 6 (adopted, adopted_content "creation"), texture 7 (a host
       decode: RGBA8 payload, source_format "DXT5"), texture 8 (RGBAF 2x2, a legal float
       payload), texture 9 (adopted "current" RH 3x2 with mipmaps), texture 10 (adopted "creation"
       AND a host decode from "BPTC_RGBA"); mesh 1 (adopted "creation"); shader 1 and material 1
       (adopted; the material has a texture param naming texture 6); canvas 2 (adopted) with
       adopted item 7 (material 1), adopted item 6, and created item 8 drawing textures 7, 8, 10
       and mesh 1.
    5 (new) relative to 4: texture 6 and mesh 1 become "current" content with new hashes (their
       version rises), the shape of a lazy adoption refinement.
    6 (new) relative to 5: adopted item 6 is removed and adopted texture 10 is freed (a freed
       entry keeps its origin and adopted_content, and has source_format null).

full.rs8 encodes all six as full transactions (directory delivery); patch.rs8 patch-encodes them
(seq 1 full, seq 5 a full resync, every other seq a patch); inline.rs8 encodes them as full
transactions with inline delivery. All three resolve to resolved.json (stream_id and the
per-transaction "encoding" excepted). The session of the triple declares
adoption {"mode":"arm","frame":12} and resources.decode "engine".

off.rs8 is a separate small recording (its own session): adoption null, decode "off", a websocket
stream, a `perturb-decode` sabotage declaration. It resolves to resolved-off.json.

invalid/ vectors cover exactly /8's new failure modes. golden-7's `rate.rs7` handed to a /8
decoder is `bad-magic`; every other rule /8 keeps is covered by golden-2..7's vectors.

As built (G8w): where Q6 left the key positions open, texture/mesh `adopted_content` sits right
after `origin`, texture `source_format` right after `format`, and `resources.decode` after `auth`
(the end of the resources object). `adoption` is always present at /8, right after
`unknown_item_policy` when that key exists and after `sabotage` otherwise.
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
GOLDEN6 = HERE.parent / "golden-6"
GOLDEN7 = HERE.parent / "golden-7"

_spec = importlib.util.spec_from_file_location("golden6_make_golden", GOLDEN6 / "make_golden.py")
g6 = importlib.util.module_from_spec(_spec)
sys.modules["golden6_make_golden"] = g6
_spec.loader.exec_module(g6)  # type: ignore[union-attr]

MAGIC = bytes([0x47, 0x52, 0x53, 0x38, 0x0D, 0x0A, 0x1A, 0x0A])  # "GRS8\r\n\x1a\n"
PROTOCOL = "render-stream/8"

# Re-bind golden-6's module globals that name the version.
g6.MAGIC = MAGIC
g6.PROTOCOL = PROTOCOL

FLOAT_PIXEL_SIZES = {"RF": 4, "RGF": 8, "RGBF": 12, "RGBAF": 16, "RH": 2, "RGH": 4, "RGBH": 6,
                     "RGBAH": 8}
PERMITTED_FORMATS = sorted(list(g6.PIXEL_SIZES) + list(FLOAT_PIXEL_SIZES))

# --------------------------------------------------------------------------- new payloads

# texture 7 / 10: the RGBA8 result of a host decode (a 4x4 quadrant pattern).
PAYLOAD_DEC = g6.build_payload("RGBA8", 4, 4, False, g6.quadrant_rgba8(
    4, 4, (255, 128, 0, 255), (0, 128, 255, 255), (128, 255, 0, 255), (128, 0, 255, 255)))
HASH_DEC = g6.payload_sha256(PAYLOAD_DEC)


def _f32_texels(count: int, seed: float) -> bytes:
    return b"".join(struct.pack("<f", seed + 0.25 * i) for i in range(count))


def _f16_texels(count: int) -> bytes:
    # IEEE half values 0.0, 0.5, 1.0, 1.5, ... via struct 'e'.
    return b"".join(struct.pack("<e", 0.5 * i) for i in range(count))


# texture 8: RGBAF 2x2 (4 texels x 16 bytes).
PAYLOAD_RGBAF = g6.build_payload("RGBAF", 2, 2, False, _f32_texels(4 * 4, 0.0))
HASH_RGBAF = g6.payload_sha256(PAYLOAD_RGBAF)
# texture 9: RH 3x2 with a mip chain (3x2 + 1x1 = 7 texels x 2 bytes).
PAYLOAD_RH = g6.build_payload("RH", 3, 2, True, _f16_texels(7))
HASH_RH = g6.payload_sha256(PAYLOAD_RH)

# --------------------------------------------------------------------------- re-bound encoders


def _texture_json(texture_id: int, t: dict) -> dict:
    canvas = t["canvas"]
    return {
        "id": texture_id,
        "origin": t.get("origin", "created"),
        "adopted_content": t.get("adopted_content"),
        "kind": t["kind"],
        "status": t["status"],
        "reason": t["reason"],
        "version": t["version"],
        "hash": t["hash"],
        "format": t["format"],
        "source_format": t.get("source_format"),
        "width": t["width"],
        "height": t["height"],
        "mipmaps": t["mipmaps"],
        "payload_bytes": t["payload_bytes"],
        "canvas": None if canvas is None else {
            "diffuse": canvas["diffuse"], "filter": canvas["filter"], "repeat": canvas["repeat"],
        },
    }


def _mesh_json(mesh_id: int, m: dict, mesh_f32: list[float]) -> dict:
    out = g6_mesh_json(mesh_id, m, mesh_f32)
    ordered = {"id": out["id"], "origin": m.get("origin", "created"),
               "adopted_content": m.get("adopted_content")}
    for key in ("status", "reason", "version", "f", "surfaces"):
        ordered[key] = out[key]
    return ordered


def _shader_json(shader_id: int, s: dict) -> dict:
    out = g6_shader_json(shader_id, s)
    out["origin"] = s.get("origin", "created")
    return out


def _material_json(material_id: int, m: dict, param_f64: list[float]) -> dict:
    out = g6_material_json(material_id, m, param_f64)
    out["origin"] = m.get("origin", "created")
    return out


g6_mesh_json = g6._mesh_json
g6_shader_json = g6._shader_json
g6_material_json = g6._material_json
g6._texture_json = _texture_json
g6._mesh_json = _mesh_json
g6._shader_json = _shader_json
g6._material_json = _material_json

_TEXTURE_FIELDS = ("origin", "adopted_content", "kind", "status", "reason", "version", "hash",
                   "format", "source_format", "width", "height", "mipmaps", "payload_bytes",
                   "canvas")


def _texture_differs(a: dict, b: dict) -> bool:
    return any(a.get(key) != b.get(key) for key in _TEXTURE_FIELDS)


def _mesh_differs(a: dict, b: dict) -> bool:
    for key in ("origin", "adopted_content", "status", "reason", "version", "surfaces"):
        if a.get(key) != b.get(key):
            return True
    return g6.f32_pattern(a["custom_aabb"]) != g6.f32_pattern(b["custom_aabb"])


g6.texture_differs = _texture_differs
g6.mesh_differs = _mesh_differs

# --------------------------------------------------------------------------- session


def session_record(
    stream_id: str, transport: str, encoding: str, session_id: str, *, delivery: str,
    adoption: dict | None = {"mode": "arm", "frame": 12},
    decode: str = "engine",
    sabotage: dict | None = None,
    publication_mode: str = "every-frame",
    publication_target_fps: int | None = None,
    credit_window: int = 1,
) -> bytes:
    logical_size = (640, 360)
    if delivery == "out-of-band":
        resources = {
            "hash": "sha256",
            "payloads": sorted([g6.MESH_PAYLOAD_SCHEMA, g6.SHADER_PAYLOAD_SCHEMA,
                                g6.PAYLOAD_SCHEMA]),
            "delivery": "out-of-band", "inline_max_bytes": 0, "max_payload_bytes": 16777216,
            "permitted_formats": PERMITTED_FORMATS, "fetch": "directory", "http_path": None,
            "auth": "none", "decode": decode,
        }
    else:
        assert delivery == "inline"
        resources = {
            "hash": "sha256",
            "payloads": sorted([g6.MESH_PAYLOAD_SCHEMA, g6.SHADER_PAYLOAD_SCHEMA,
                                g6.PAYLOAD_SCHEMA]),
            "delivery": "inline", "inline_max_bytes": 16777216, "max_payload_bytes": 16777216,
            "permitted_formats": PERMITTED_FORMATS, "fetch": "none", "http_path": None,
            "auth": "none", "decode": decode,
        }
    meta = {
        "type": "session",
        "protocol": PROTOCOL,
        "session_id": session_id,
        "stream": {"stream_id": stream_id, "connection": None, "transport": transport,
                   "encoding": encoding},
        "engine": {
            "version_string": "Godot Engine v4.5.1.stable.official",
            "sha256": "54cc228405e5be61934192e3bc5461c91dcb4a3275578b29a869557a4322e79c",
            "display_server": "headless",
            "rendering_driver": "opengl3",
            "rendering_method": "gl_compatibility",
        },
        "capture": {"calibrator_version": 8, "hooks_planned": g6.HOOKS_PLANNED,
                    "hooks_omitted": []},
        "viewport": {
            "canvas_cull_mask": 4294967295,
            "root_canvas": 1,
            "logical_size": list(logical_size),
            "stretch": {"mode": "disabled", "aspect": "ignore", "scale_mode": "fractional"},
            "stretch_applied_by": "receiver",
            "root_size_policy": "observe",
            "presentation_size": list(logical_size),
            "host_size_status": "match",
            "host_window_size": list(logical_size),
            "font_oversampling": g6._RawFloat(1.0),
            "snap_2d": {"transforms": False, "vertices": False},
        },
        "resources": resources,
        "materials": {"shader_policy": "source"},
        "features": {
            "ops": g6.FEATURE_OPS,
            "item_state": g6.FEATURE_ITEM_STATE,
            "canvas_state": g6.FEATURE_CANVAS_STATE,
            "resources": g6.FEATURE_RESOURCES,
            "unsupported_resources": g6.FEATURE_UNSUPPORTED_RESOURCES,
            "observed_unsupported_ops": g6.FEATURE_OBSERVED_UNSUPPORTED_OPS,
            "unobserved": g6.FEATURE_UNOBSERVED,
            "publication": g6.PUBLICATION,
        },
        "publication": {"mode": publication_mode, "target_fps": publication_target_fps,
                        "credit_window": credit_window},
        "sabotage": sabotage,
        "adoption": adoption,
    }
    blocks = [
        g6.f32block("clear_color", [0.25, 0.25, 0.5, 1.0]),
        g6.f32block("root_canvas_xform", g6.IDENTITY),
        g6.f32block("host_visible_rect", [0.0, 0.0, 640.0, 360.0]),
        g6.f32block("host_final_xform", g6.IDENTITY),
        g6.f32block("content_scale_factor", [1.0]),
    ]
    return g6.encode_record(meta, blocks)


# --------------------------------------------------------------------------- the six states


def state4() -> dict:
    state = {k: (dict(v) if isinstance(v, dict) else v) for k, v in g6.STATES[2].items()}
    textures = state["textures"]
    textures[6] = dict(g6.texture(kind="image", version=1, hash=g6.HASH_A1, format="RGBA8",
                                  width=16, height=16, payload_bytes=len(g6.PAYLOAD_A1)),
                       origin="adopted", adopted_content="creation")
    textures[7] = dict(g6.texture(kind="image", version=1, hash=HASH_DEC, format="RGBA8",
                                  width=4, height=4, payload_bytes=len(PAYLOAD_DEC)),
                       source_format="DXT5")
    textures[8] = g6.texture(kind="image", version=1, hash=HASH_RGBAF, format="RGBAF",
                             width=2, height=2, payload_bytes=len(PAYLOAD_RGBAF))
    textures[9] = dict(g6.texture(kind="image", version=1, hash=HASH_RH, format="RH", width=3,
                                  height=2, mipmaps=True, payload_bytes=len(PAYLOAD_RH)),
                       origin="adopted", adopted_content="current")
    textures[10] = dict(g6.texture(kind="image", version=1, hash=HASH_DEC, format="RGBA8",
                                   width=4, height=4, payload_bytes=len(PAYLOAD_DEC)),
                        origin="adopted", adopted_content="creation", source_format="BPTC_RGBA")
    state["meshes"] = {
        1: dict(g6.mesh(version=1, surfaces=[
            g6.mesh_surface(g6.HASH_MESH1_A, len(g6.MESH1_SURFACE_A_PAYLOAD), "triangles",
                            g6.MESH1_SURFACE_A_FORMAT, 3, 0)]),
                origin="adopted", adopted_content="creation"),
    }
    state["shaders"] = {
        1: dict(g6.shader(version=1, hash=g6.HASH_SHADER2_V1,
                          payload_bytes=len(g6.SHADER2_TINT_PAYLOAD_V1)), origin="adopted"),
    }
    state["materials"] = {
        1: dict(g6.material(version=1, shader=1, params=[
            g6.param("tex_a", "rid", tex=6),
            g6.param("tint", "color", floats=[1.0, 0.5, 0.25, 1.0]),
        ]), origin="adopted"),
    }
    items = dict(state["items"])
    items[6] = dict(g6.item(
        parent=("canvas", 1), children=[], xform=[1.0, 0.0, 0.0, 1.0, 100.0, 0.0], draw_index=5,
        content_version=1,
        commands=[g6.add_texture_rect(6, False, False, [0.0, 0.0, 16.0, 16.0]),
                  g6.add_texture_rect(9, False, False, [16.0, 0.0, 8.0, 8.0])]),
        origin="adopted")
    items[7] = dict(g6.item(
        parent=("canvas", 2), children=[], xform=[1.0, 0.0, 0.0, 1.0, 0.0, 40.0], draw_index=0,
        content_version=1, commands=[g6.add_rect([0.0, 0.0, 24.0, 24.0], [0.5, 0.5, 1.0, 1.0])],
        material=1), origin="adopted")
    items[8] = g6.item(
        parent=("canvas", 1), children=[], xform=[1.0, 0.0, 0.0, 1.0, 130.0, 0.0], draw_index=6,
        content_version=1,
        commands=[g6.add_texture_rect(7, False, False, [0.0, 0.0, 8.0, 8.0]),
                  g6.add_texture_rect(8, False, False, [8.0, 0.0, 8.0, 8.0]),
                  g6.add_texture_rect(10, False, False, [16.0, 0.0, 8.0, 8.0]),
                  g6.add_mesh(1, g6.IDENTITY)])
    state["items"] = items
    state["canvases"] = {
        1: g6.root_canvas([1, 2, 3, 4, 5, 6, 8]),
        2: dict(g6.canvas_entry([7], layer=1, xform=[1.0, 0.0, 0.0, 1.0, 10.0, 10.0]),
                origin="adopted"),
    }
    return state


def state5() -> dict:
    state = state4()
    textures = dict(state["textures"])
    tex6 = dict(textures[6])
    tex6.update(version=2, hash=g6.HASH_A2, payload_bytes=len(g6.PAYLOAD_A2),
                adopted_content="current")
    textures[6] = tex6
    state["textures"] = textures
    meshes = dict(state["meshes"])
    mesh1 = dict(meshes[1])
    mesh1.update(version=2, adopted_content="current", surfaces=[
        g6.mesh_surface(g6.HASH_MESH1_B, len(g6.MESH1_SURFACE_B_PAYLOAD), "triangles",
                        g6.MESH1_SURFACE_B_FORMAT, 4, 6)])
    meshes[1] = mesh1
    state["meshes"] = meshes
    return state


def state6() -> dict:
    state = state5()
    items = dict(state["items"])
    del items[6]
    state["items"] = items
    state["canvases"] = dict(state["canvases"])
    state["canvases"][1] = g6.root_canvas([1, 2, 3, 4, 5, 8])
    textures = dict(state["textures"])
    freed = dict(g6.texture(kind="image", status="freed", version=2),
                 origin="adopted", adopted_content="creation")
    textures[10] = freed
    state["textures"] = textures
    return state


STATES = [g6.STATES[0], g6.STATES[1], g6.STATES[2], state4(), state5(), state6()]

# --------------------------------------------------------------------------- decode / resolved


def decode(data: bytes) -> dict:
    out = g6.decode(data)
    out["schema"] = "render-stream-8-decoded/1"
    return out


def resolved_state(state: dict) -> dict:
    out = g6.resolved_state(state)
    # g6's textures/canvases/items already carry the re-bound shapes; rebuild the three tables
    # whose resolved form hard-codes origin "created".
    meshes_out = []
    for mid in sorted(state["meshes"]):
        m = state["meshes"][mid]
        meshes_out.append({
            "id": mid, "origin": m.get("origin", "created"),
            "adopted_content": m.get("adopted_content"), "status": m["status"],
            "reason": m["reason"], "version": m["version"], "custom_aabb": m["custom_aabb"],
            "surfaces": m["surfaces"] if m["status"] == "ok" else [],
        })
    for entry, sid in zip(out["shaders"], sorted(state["shaders"])):
        entry["origin"] = state["shaders"][sid].get("origin", "created")
    for entry, mid in zip(out["materials"], sorted(state["materials"])):
        entry["origin"] = state["materials"][mid].get("origin", "created")
    out["meshes"] = meshes_out
    return out


# --------------------------------------------------------------------------- helpers


def one_tx_recording(session: bytes, state: dict, resources: list[bytes] = ()) -> bytes:
    records = [session] + list(resources) + [g6.full_transaction_bytes(1, 1, state)]
    end = g6.end_record(1, records, diff_ns_total=0, full_transactions=1, patch_transactions=0,
                        resource_records=len(resources), resource_bytes=0)
    return g6.recording(records, end)


MINI_SESSION = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
MINI_STREAM = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"


def mini_state(textures: dict) -> dict:
    item = g6.item(parent=("canvas", 1), children=[], xform=g6.IDENTITY, draw_index=0,
                   content_version=1, commands=[g6.add_rect([0.0, 0.0, 8.0, 8.0], g6.WHITE)])
    return {"items": {1: item}, "canvases": {1: g6.root_canvas([1])}, "textures": textures,
            "meshes": {}, "shaders": {}, "materials": {}, "unsupported": [], "failures": [],
            "default_filter": "nearest", "default_repeat": "disabled"}


def mini_texture(**kw) -> dict:
    extra = {k: kw.pop(k) for k in ("origin", "adopted_content", "source_format") if k in kw}
    base = dict(kind="image", version=1, hash=g6.HASH_A1, format="RGBA8", width=16, height=16,
                payload_bytes=len(g6.PAYLOAD_A1))
    base.update(kw)
    return dict(g6.texture(**base), **extra)


def mini_recording(*, adoption=None, decode="off", textures: dict | None = None,
                   mutate_tex_json=None, resources=(), session_fn=None, hand=None) -> bytes:
    session = (session_fn or session_record)(MINI_STREAM, "file", "full", MINI_SESSION,
                                             delivery="out-of-band", adoption=adoption,
                                             decode=decode)
    return one_tx_recording(session, mini_state(textures or {}), resources)


def build_invalid_vectors() -> dict[str, tuple[bytes, str, str]]:
    out: dict[str, tuple[bytes, str, str]] = {}
    out["bad-magic"] = ((GOLDEN7 / "rate.rs7").read_bytes(), "bad-magic",
                        "magic byte 3 is '7' (GRS7), not '8'")
    arm = {"mode": "arm", "frame": 12}

    out["adoption-undeclared"] = (
        mini_recording(adoption=None, textures={1: mini_texture(
            origin="adopted", adopted_content="creation")}),
        "adoption-entry", "texture 1 has origin \"adopted\", but the session declares no adoption")
    out["adopted-content-missing"] = (
        mini_recording(adoption=arm, textures={1: mini_texture(origin="adopted")}),
        "adoption-entry", "an adopted texture entry carries adopted_content null")
    out["adopted-content-on-created"] = (
        mini_recording(adoption=arm, textures={1: mini_texture(adopted_content="current")}),
        "adoption-entry", "a created texture entry carries adopted_content \"current\"")
    out["adopted-content-value"] = (
        mini_recording(adoption=arm, textures={1: mini_texture(
            origin="adopted", adopted_content="stale")}),
        "meta-schema", "adopted_content is \"stale\", neither null, \"current\" nor \"creation\"")
    out["adoption-frame"] = (
        mini_recording(adoption={"mode": "arm", "frame": 0}),
        "adoption-entry", "adoption.frame is 0, not >= 1")
    out["adoption-mode"] = (
        mini_recording(adoption={"mode": "replay", "frame": 12}),
        "adoption-entry", "adoption.mode is \"replay\", not \"arm\"")
    out["decode-undeclared"] = (
        mini_recording(adoption=None, decode="off", textures={1: mini_texture(
            source_format="DXT1")}),
        "decode-entry", "texture 1 declares source_format DXT1, but resources.decode is \"off\"")
    out["decode-same-format"] = (
        mini_recording(decode="engine", textures={1: mini_texture(source_format="RGBA8")}),
        "decode-entry", "source_format equals the payload format RGBA8")
    out["decode-source-name"] = (
        mini_recording(decode="engine", textures={1: mini_texture(source_format="DXT9")}),
        "meta-schema", "source_format DXT9 is not an Image format name")
    out["decode-freed"] = (
        mini_recording(decode="engine", textures={1: dict(
            g6.texture(kind="image", status="freed", version=1), source_format="DXT1")}),
        "decode-entry", "a freed texture entry carries source_format DXT1")

    def bad_decode_session(*a, **k):
        data = session_record(*a, **k)
        return data.replace(b'"decode":"off"', b'"decode":"gpu"')
    # 'gpu' is 3 chars, 'off' is 3 chars, so record framing stays valid after the splice.
    out["decode-policy"] = (
        mini_recording(decode="off", session_fn=bad_decode_session),
        "meta-schema", "resources.decode is \"gpu\", neither \"off\" nor \"engine\"")

    # float-payload-size: an inline RGBAF 2x2 payload whose data is 60 bytes, not 64.
    bad_data = _f32_texels(15, 0.0)
    bad_payload = g6.build_payload("RGBAF", 2, 2, False, bad_data)
    inline_session = session_record(MINI_STREAM, "file", "full", MINI_SESSION, delivery="inline",
                                    adoption=None, decode="off")
    float_state = mini_state({1: mini_texture(hash=g6.payload_sha256(bad_payload), format="RGBAF",
                                              width=2, height=2,
                                              payload_bytes=len(bad_payload))})
    out["float-payload-size"] = (
        one_tx_recording(inline_session, float_state,
                         [g6.resource_record_bytes(g6.payload_sha256(bad_payload), bad_payload)]),
        "payload-size", "RGBAF 2x2 needs 64 data bytes, the payload carries 60")
    return out


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
    full_rs8 = g6.recording(full_records, full_end)

    patch_session = session_record("2" * 32, "file", "patch", "fedcba9876543210fedcba9876543210",
                                   delivery="out-of-band")
    patch_records = [patch_session, g6.full_transaction_bytes(1, 1, STATES[0])]
    for seq in (2, 3, 4):
        patch_records.append(g6.patch_transaction_bytes(seq, seq, seq - 1, STATES[seq - 2],
                                                        STATES[seq - 1]))
    patch_records.append(g6.full_transaction_bytes(5, 5, STATES[4]))  # resync: full again
    patch_records.append(g6.patch_transaction_bytes(6, 6, 5, STATES[4], STATES[5]))
    patch_end = g6.end_record(len(STATES), patch_records, diff_ns_total=12345,
                              full_transactions=2, patch_transactions=len(STATES) - 2,
                              resource_records=0, resource_bytes=0)
    patch_rs8 = g6.recording(patch_records, patch_end)

    inline_session = session_record("3" * 32, "file", "full", "22222222222222222222222222222222",
                                    delivery="inline")
    r = g6.resource_record_bytes
    inline_payloads: list[tuple[str, bytes]] = []

    def inline_resource(hash_hex: str, payload: bytes) -> bytes:
        inline_payloads.append((hash_hex, payload))
        return r(hash_hex, payload)

    inline_records = [inline_session, inline_resource(g6.HASH_A1, g6.PAYLOAD_A1),
                      inline_resource(g6.HASH_F, g6.PAYLOAD_F)]
    inline_records.append(g6.full_transaction_bytes(1, 1, STATES[0]))
    inline_records.append(g6.full_transaction_bytes(2, 2, STATES[1]))
    inline_records.append(inline_resource(g6.HASH_A2, g6.PAYLOAD_A2))
    inline_records.append(g6.full_transaction_bytes(3, 3, STATES[2]))
    inline_records.append(inline_resource(HASH_DEC, PAYLOAD_DEC))
    inline_records.append(inline_resource(HASH_RGBAF, PAYLOAD_RGBAF))
    inline_records.append(inline_resource(HASH_RH, PAYLOAD_RH))
    inline_records.append(inline_resource(g6.HASH_MESH1_A, g6.MESH1_SURFACE_A_PAYLOAD))
    inline_records.append(inline_resource(g6.HASH_SHADER2_V1, g6.SHADER2_TINT_PAYLOAD_V1))
    inline_records.append(g6.full_transaction_bytes(4, 4, STATES[3]))
    inline_records.append(inline_resource(g6.HASH_MESH1_B, g6.MESH1_SURFACE_B_PAYLOAD))
    inline_records.append(g6.full_transaction_bytes(5, 5, STATES[4]))
    inline_records.append(g6.full_transaction_bytes(6, 6, STATES[5]))
    inline_end = g6.end_record(len(STATES), inline_records, diff_ns_total=0,
                               full_transactions=len(STATES), patch_transactions=0,
                               resource_records=len(inline_payloads),
                               resource_bytes=sum(len(p) for _, p in inline_payloads))
    inline_rs8 = g6.recording(inline_records, inline_end)

    # off.rs8: adoption null, decode "off", websocket, a sabotage declaration.
    off_state = mini_state({})
    off_session = session_record(
        "4" * 32, "websocket", "full", "44444444444444444444444444444444",
        delivery="out-of-band", adoption=None, decode="off",
        sabotage={"kind": "perturb-decode", "frame": 1, "op": None})
    off_records = [off_session, g6.full_transaction_bytes(1, 1, off_state)]
    off_end = g6.end_record(1, off_records, diff_ns_total=0, full_transactions=1,
                            patch_transactions=0, resource_records=0, resource_bytes=0)
    off_rs8 = g6.recording(off_records, off_end)

    full_decoded, patch_decoded = decode(full_rs8), decode(patch_rs8)
    inline_decoded, off_decoded = decode(inline_rs8), decode(off_rs8)
    resolved = {
        "schema": "render-stream-8-resolved/1",
        "transactions": [{"seq": i + 1, "frame": i + 1, "state": resolved_state(s)}
                         for i, s in enumerate(STATES)],
    }
    resolved_off = {
        "schema": "render-stream-8-resolved/1",
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
    corrupt = bytearray(patch_rs8)
    assert corrupt[seq3_offset + 8] == ord("{")
    corrupt[seq3_offset + 8] = 0x00

    invalid = build_invalid_vectors()
    payload_files = [
        ("a1.grt", g6.HASH_A1, g6.PAYLOAD_A1, "RGBA8", 16, 16, False),
        ("a2.grt", g6.HASH_A2, g6.PAYLOAD_A2, "RGBA8", 16, 16, False),
        ("f.grt", g6.HASH_F, g6.PAYLOAD_F, "LA8", 4, 4, False),
        ("dec.grt", HASH_DEC, PAYLOAD_DEC, "RGBA8", 4, 4, False),
        ("rgbaf.grt", HASH_RGBAF, PAYLOAD_RGBAF, "RGBAF", 2, 2, False),
        ("rh.grt", HASH_RH, PAYLOAD_RH, "RH", 3, 2, True),
    ]
    index = {
        "schema": "render-stream-8-golden-index/1",
        "protocol": PROTOCOL,
        "valid": [
            {"file": "full.rs8", "hex": "full.hex", "decoded": "full.decoded.json",
             "sha256": hashlib.sha256(full_rs8).hexdigest()},
            {"file": "patch.rs8", "hex": "patch.hex", "decoded": "patch.decoded.json",
             "sha256": hashlib.sha256(patch_rs8).hexdigest()},
            {"file": "inline.rs8", "hex": "inline.hex", "decoded": "inline.decoded.json",
             "sha256": hashlib.sha256(inline_rs8).hexdigest()},
        ],
        "resolved": "resolved.json",
        "off_leg": {"file": "off.rs8", "hex": "off.hex", "decoded": "off.decoded.json",
                    "sha256": hashlib.sha256(off_rs8).hexdigest(),
                    "resolved": "resolved-off.json"},
        "inline_resources": inline_resources,
        "corrupt": [
            {"file": "corrupt-meta.rs8", "code": "meta-json", "record_index": 3, "seq": 3,
             "description": "patch.rs8 transaction seq 3: first meta byte set to 0x00; framing intact"},
        ],
        "invalid": [
            {"file": f"invalid/{name}.rs8", "code": code, "description": description}
            for name, (_, code, description) in invalid.items()
        ],
        "payloads": [
            {"file": f"payloads/{name}", "hash": h, "format": fmt, "width": w, "height": hh,
             "mipmaps": mips, "bytes": len(p)}
            for name, h, p, fmt, w, hh, mips in payload_files
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
        "full.rs8": full_rs8, "full.hex": g6.to_hex(full_rs8).encode("ascii"),
        "full.decoded.json": g6.pretty(full_decoded),
        "patch.rs8": patch_rs8, "patch.hex": g6.to_hex(patch_rs8).encode("ascii"),
        "patch.decoded.json": g6.pretty(patch_decoded),
        "inline.rs8": inline_rs8, "inline.hex": g6.to_hex(inline_rs8).encode("ascii"),
        "inline.decoded.json": g6.pretty(inline_decoded),
        "off.rs8": off_rs8, "off.hex": g6.to_hex(off_rs8).encode("ascii"),
        "off.decoded.json": g6.pretty(off_decoded),
        "resolved.json": g6.pretty(resolved),
        "resolved-off.json": g6.pretty(resolved_off),
        "corrupt-meta.rs8": bytes(corrupt),
        "index.json": g6.pretty(index),
        "payloads/mesh1-a.grm": g6.MESH1_SURFACE_A_PAYLOAD,
        "payloads/mesh1-b.grm": g6.MESH1_SURFACE_B_PAYLOAD,
        "payloads/shader2-tint-v1.grp": g6.SHADER2_TINT_PAYLOAD_V1,
    }
    for name, _, p, *_ in payload_files:
        outputs[f"payloads/{name}"] = p
    for name, (data, _, _) in invalid.items():
        outputs[f"invalid/{name}.rs8"] = data
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
