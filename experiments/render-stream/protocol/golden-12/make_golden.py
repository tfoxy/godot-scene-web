#!/usr/bin/env python3
"""Generate the render-stream/12 golden vectors (stdlib only, deterministic).

render-stream/12 (../render-stream-12.md) is render-stream/11 plus exactly: the GRSC magic, the
protocol string render-stream/12, the particles table (`particles`, `removed_particles`), the
transaction key `particle_emits`, the `add_particles` command, the optional tenth block `pt_f32`
(present only when it holds a float), the `particle_process_material` shader builtin, and the
session features (`features.ops` gains "add_particles", `features.resources` gains "particles",
`features.observed_unsupported_ops` loses "canvas_item_add_particles"; each list stays sorted).

    python3 make_golden.py           # (re)write every output beside this file
    python3 make_golden.py --check   # verify the committed outputs, write nothing

Like golden-11 this loads the earlier generator (golden-11's, which loads golden-10's, ...) and
re-binds what changes. Every transaction of states 1-21 is byte-identical to golden-11's (no
particles key, no pt_f32 block); only the magic and the session record differ.

Particles floats (render-stream-12.md "Particles table"), 31 + 12 * trail_poses per entry, in
pt_f32: amount_ratio, lifetime, pre_process_time, explosiveness_ratio, randomness_ratio,
speed_scale, collision_base_size, trail length, interp_to_end, request_process_time, custom AABB
(position xyz, size xyz), emission transform (basis.rows[0..2] xyz each, then origin), emitter
velocity xyz, then the trail bind poses (12 floats each, the same Transform3D order). An emit
carries 23: transform (12), velocity (3), colour RGBA (4), custom RGBA (4). Every float is dyadic
(exact in f32). Unless listed, an emitter's floats are the defaults: amount_ratio 1, lifetime 1,
pre_process 0, explosiveness 0, randomness 0, speed_scale 1, collision_base_size 1, trail length
0, interp_to_end 0, request_process_time 0, custom AABB [-4, -4, -4, 8, 8, 8], emission transform
identity, velocity 0, no trail poses; its JSON fields the GLES3 defaults (mode 3d, emitting false,
amount 0, one_shot false, fixed_fps 0, interpolate true, fractional_delta false, local false,
draw_order index, transform_align disabled, trails false, seed 0, no process material, no draw
pass, no subemitter, restarts/emits/process_requests 0).

New tables of state 22: shader 2 (created, ok, mode particles, source payload, the generated code
PPM_CODE below as a render-stream-shader/1 payload, uses [], builtin particle_process_material:
emission_shape box, particle_flags [], textures ["scale"], color_ramp true, everything else
false/"disabled"); material 2 (created, ok, shader 2, params color_ramp rid tex 2,
emission_box_extents vector3 [8, 8, 0], scale_curve rid tex 1).

   22 (from 21) shader 2, material 2 and two emitters:
      - emitter 1: ok, version 14, mode 2d, emitting, amount 8, fixed_fps 30, local true, seed
        1234, process_material 2, draw_passes [1] (mesh 1), subemitter null; floats: lifetime 2,
        explosiveness 0.25, randomness 0.5, custom AABB [-64, -64, 0, 128, 128, 0].
      - emitter 2: ok, version 9, mode 2d, emitting, amount 4, local false (global), seed 0,
        process_material 2, draw_passes [null], subemitter 1; floats: lifetime 0.5, emission
        transform origin [100, 50, 0] (identity basis), emitter velocity [4, 0, 0].
      - item 18 (canvas 1, x 224, draw_index 14, content_version 1): add_particles 1 tex 1,
        add_particles 2 tex null.
      - item 19 (x 240, draw_index 15, content_version 1): one command
        {"op":"unsupported","name":"canvas_item_add_particles","reason":"unknown-particles"}.
      - canvas 1's items gain 18 and 19; unsupported gains
        {"op":"canvas_item_add_particles","item":19,"reason":"unknown-particles"}.
      pt_f32: emitter 1 f 0, emitter 2 f 31, count 62.
   23 emitter 2's emission transform origin moves to [104, 50, 0] (version 10, floats only).
      Emitter 1: set_seed 4321, restart, two emits (version 18, restarts 1, emits 2). The emits,
      both {"particles":1,"restarts":1,...}: flags 5 (position, velocity), transform identity
      with origin [8, 4, 0], velocity [0, -16, 0], colour [1, 1, 1, 1], custom [0, 0, 0, 0]; then
      flags 31, transform basis diag(2, 2, 1) origin [-8, 4, 0], velocity [0, -32, 0], colour
      [1, 0.5, 0.25, 1], custom [0.5, 0, 0, 1]. pt_f32: emitter 1 f 0, emitter 2 f 31, emits f 62
      and 85, count 108 (in full.rs12 and patch.rs12 alike: T's own frame's emits).
   24 emitter 1: set_trails(true, 0.5), set_trail_bind_poses (2 poses: identity, then identity
      with origin [0, -4, 0]): version 20, trails true, trail_poses 2, 55 floats. Emitter 3 is
      new: unsupported, reason particles-3d, version 3, mode 3d, emitting, amount 4, default
      floats. Item 18 also draws add_particles 3 (content_version 2); unsupported gains
      {"op":"canvas_item_add_particles","item":18,"reason":"unsupported-particles"} (before item
      19's). Patch pt_f32: emitter 1 f 0, emitter 3 f 55, count 86 (full: 1 at 0, 2 at 55, 3 at
      86, count 117).
   25 emitter 3 is freed while drawn: the tombstone (version 4, status freed, reason null, f
      null, process_material null, draw_passes [], subemitter null, every other JSON field as at
      24). Item 18 draws add_particles 1 tex 1 and add_particles 3 (content_version 3), so nothing
      names emitter 2: removed_particles [2]. unsupported drops item 18's entry (a tombstone adds
      none). The patch carries emitter 3 only and no pt_f32 block (no float); full.rs12's seq 25
      carries emitter 1 (f 0) and 3, count 55.
   26 unchanged, re-sent full as after a resync: emitters 1 (f 0) and 3, count 55, no emits.

full.rs12 encodes the twenty-six states as full transactions (out-of-band); patch.rs12 patch-
encodes them (seq 1, 5, 16, 21 and 26 full, every other seq a patch; `unsupported` is null in a
patch whose list equals the base's); inline.rs12 encodes them as full transactions with inline
delivery, each preceded by inline(T) minus inline(B) (seq 22 adds shader 2's payload record). All
three resolve to resolved.json (render-stream-12-resolved/1), whose states 22-26 carry
"particles" right after "multimeshes" (an entry's JSON fields without `f`, then a "floats" object:
amount_ratio, lifetime, pre_process_time, explosiveness, randomness, speed_scale,
collision_base_size, trail_length, interp_to_end, request_process_time, custom_aabb,
emission_transform, emitter_velocity, trail_poses; null when freed). The resolved state carries no
emit list. coding/ (W11t's coded forms) is the C++ rs_live_coding_tool's output and is not made
here.

The particles invalid vectors use mini_pt_states() (below): seq 1 full with dynamic mesh 1,
shader 1 (the particles builtin shader), material 1 on it, emitter 1 (ok, version 5, local,
amount 2, seed 7, process_material 1, draw_passes [1], emits 1) and emitter 2 (ok, version 3,
global, amount 1, subemitter 1, draw_passes [null], emission origin [16, 8, 0]); item 1 draws
add_mesh 1, add_particles 1 and add_particles 2; one emit on emitter 1 (flags 1, origin [2, 2,
0]). Seq 2, a patch: emitter 1's emission origin moves to [1, 0, 0] at version 6. Each vector
fails exactly one rule (index.json lists them with their codes).
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
GOLDEN11 = HERE.parent / "golden-11"
G11_SPEC = importlib.util.spec_from_file_location("golden11_make_golden",
                                                  GOLDEN11 / "make_golden.py")
g11 = importlib.util.module_from_spec(G11_SPEC)
sys.modules["golden11_make_golden"] = g11
G11_SPEC.loader.exec_module(g11)  # type: ignore[union-attr]
g10 = g11.g10
g9 = g11.g9
g8 = g11.g8
g6 = g11.g6

MAGIC = bytes([0x47, 0x52, 0x53, 0x43, 0x0D, 0x0A, 0x1A, 0x0A])  # "GRSC\r\n\x1a\n"
PROTOCOL = "render-stream/12"
MAGIC_V11 = g11.MAGIC
PROTOCOL_V11 = g11.PROTOCOL

_PROTO_MODULES = (g6, g8, g9, g10, g11)
V11 = False  # True while writing a /11 record (particles-v11): no /12 rewriting.


def _set_version(magic: bytes, protocol: str) -> None:
    g6.MAGIC = magic
    for module in _PROTO_MODULES:
        module.PROTOCOL = protocol


_set_version(MAGIC, PROTOCOL)


@contextlib.contextmanager
def as_v11():
    global V11
    V11 = True
    _set_version(MAGIC_V11, PROTOCOL_V11)
    try:
        yield
    finally:
        V11 = False
        _set_version(MAGIC, PROTOCOL)


# --------------------------------------------------------------------------- particles

ENTRY_JSON_KEYS = ("origin", "status", "reason", "version", "mode", "emitting", "amount",
                   "one_shot", "fixed_fps", "interpolate", "fractional_delta", "local",
                   "draw_order", "transform_align", "trails", "trail_poses", "seed", "restarts",
                   "emits", "process_requests", "process_material", "draw_passes", "subemitter")
IDENTITY3 = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]
DEFAULT_AABB = [-4.0, -4.0, -4.0, 8.0, 8.0, 8.0]
PT_BASE_FLOATS = 31
EMIT_FLOATS = 23


def xform3(origin: list[float], diag: tuple[float, float, float] = (1.0, 1.0, 1.0)) -> list[float]:
    """A Transform3D in the wire's memory order: basis.rows[0..2] (xyz each), then origin."""
    return [diag[0], 0.0, 0.0, 0.0, diag[1], 0.0, 0.0, 0.0, diag[2]] + list(origin)


def pt_floats(*, amount_ratio: float = 1.0, lifetime: float = 1.0, pre_process_time: float = 0.0,
              explosiveness: float = 0.0, randomness: float = 0.0, speed_scale: float = 1.0,
              collision_base_size: float = 1.0, trail_length: float = 0.0,
              interp_to_end: float = 0.0, request_process_time: float = 0.0,
              custom_aabb: list[float] = DEFAULT_AABB,
              emission_transform: list[float] = IDENTITY3,
              emitter_velocity: list[float] = (0.0, 0.0, 0.0),
              trail_poses: list[list[float]] = ()) -> list[float]:
    out = [amount_ratio, lifetime, pre_process_time, explosiveness, randomness, speed_scale,
           collision_base_size, trail_length, interp_to_end, request_process_time]
    out += list(custom_aabb) + list(emission_transform) + list(emitter_velocity)
    assert len(out) == PT_BASE_FLOATS
    for pose in trail_poses:
        assert len(pose) == 12
        out += list(pose)
    return out


def particles(*, version: int, status: str = "ok", reason: str | None = None, mode: str = "2d",
              emitting: bool = False, amount: int = 0, one_shot: bool = False, fixed_fps: int = 0,
              interpolate: bool = True, fractional_delta: bool = False, local: bool = False,
              draw_order: str = "index", transform_align: str = "disabled", trails: bool = False,
              seed: int = 0, restarts: int = 0, emits: int = 0, process_requests: int = 0,
              process_material: int | None = None, draw_passes: list | None = None,
              subemitter: int | None = None, floats: list[float] | None = None,
              check: bool = True) -> dict:
    floats = pt_floats() if floats is None else list(floats)
    trail_poses = (len(floats) - PT_BASE_FLOATS) // 12
    p = {"origin": "created", "status": status, "reason": reason, "version": version,
         "mode": mode, "emitting": emitting, "amount": amount, "one_shot": one_shot,
         "fixed_fps": fixed_fps, "interpolate": interpolate,
         "fractional_delta": fractional_delta, "local": local, "draw_order": draw_order,
         "transform_align": transform_align, "trails": trails, "trail_poses": trail_poses,
         "seed": seed, "restarts": restarts, "emits": emits,
         "process_requests": process_requests, "process_material": process_material,
         "draw_passes": list(draw_passes or []), "subemitter": subemitter, "floats": floats}
    if check:
        assert (len(floats) - PT_BASE_FLOATS) % 12 == 0
        assert trail_poses == 0 or trails
        if status == "ok":
            assert reason is None and mode == "2d"
        else:
            assert status == "unsupported" and reason is not None
    return p


def freed_particles(p: dict, version: int) -> dict:
    """The tombstone (render-stream-12.md "Shape rules"): reason null, no floats, no references;
    every other JSON field keeps its last value."""
    return dict(p, status="freed", reason=None, version=version, process_material=None,
                draw_passes=[], subemitter=None, floats=None)


def emit(particles_id: int, restarts: int, flags: int, transform: list[float],
         velocity: list[float], color: list[float], custom: list[float]) -> dict:
    floats = list(transform) + list(velocity) + list(color) + list(custom)
    assert len(floats) == EMIT_FLOATS and 0 <= flags <= 31
    return {"particles": particles_id, "restarts": restarts, "flags": flags, "floats": floats}


def add_particles(pt_id: int, tex: int | None = None) -> dict:
    return {"op": "add_particles", "particles": pt_id, "tex": tex}


g11_command_json = g6._command_json


def _command_json(command: dict, cmd_f32: list[float], cmd_i32: list[int]) -> dict:
    if command["op"] == "add_particles":  # no floats, no "f"
        return {"op": "add_particles", "particles": command["particles"], "tex": command["tex"]}
    return g11_command_json(command, cmd_f32, cmd_i32)


g6._command_json = _command_json
g11_resolved_command = g6._resolved_command


def _resolved_command(command: dict) -> dict:
    if command["op"] == "add_particles":
        return {"op": "add_particles", "particles": command["particles"], "tex": command["tex"]}
    return g11_resolved_command(command)


g6._resolved_command = _resolved_command


def pt_differs(base: dict, cur: dict) -> bool:
    if any(base[k] != cur[k] for k in ENTRY_JSON_KEYS):
        return True
    if (base["floats"] is None) != (cur["floats"] is None):
        return True
    return cur["floats"] is not None and (
        g6.f32_pattern(base["floats"]) != g6.f32_pattern(cur["floats"]))


def _pt_entry_json(pt_id: int, p: dict, pt_f32: list[float]) -> dict:
    out = {"id": pt_id}
    for key in ENTRY_JSON_KEYS:
        out[key] = list(p[key]) if key == "draw_passes" else p[key]
    f = None
    if p["floats"] is not None:
        f = len(pt_f32)
        pt_f32 += p["floats"]
    out["f"] = f
    return out


def _particles_tables(encoding: str, base: dict | None, cur: dict, pt_f32: list[float]
                      ) -> tuple[list[dict], list[int], list[dict]]:
    """(particles, removed_particles, particle_emits) of one /12 transaction."""
    cur_pt = cur.get("particles", {})
    full = encoding == "full"
    base_pt = {} if full else base.get("particles", {})
    entries = []
    for pt_id in sorted(cur_pt):
        p, b = cur_pt[pt_id], base_pt.get(pt_id)
        if b is not None:
            if not pt_differs(b, p):
                assert b["version"] == p["version"], pt_id
                continue
            assert p["version"] > b["version"], pt_id  # the version moves on every change
        entries.append(_pt_entry_json(pt_id, p, pt_f32))
    removed = [] if full else sorted(set(base_pt) - set(cur_pt))
    emits = []
    # Every golden patch has base seq - 1, so (B, T] is T's own frame, as on a full.
    for e in cur.get("particle_emits", []):
        emits.append({"particles": e["particles"], "restarts": e["restarts"],
                      "flags": e["flags"], "f": len(pt_f32)})
        pt_f32 += e["floats"]
    return entries, removed, emits


def _after_key(meta: dict) -> str:
    """The key the particles keys follow: the last of materials, multimeshes,
    removed_multimeshes present."""
    after = "materials"
    for key in ("multimeshes", "removed_multimeshes"):
        if key in meta:
            after = key
    return after


# A hook for invalid vectors: called with (meta, blocks) of every /12 (or, under as_v11, /11)
# transaction before encoding; returns the (meta, blocks) to encode.
MUTATE = None
g11_rewrite_transaction = g11._rewrite_transaction


def _rewrite_transaction(meta: dict, blocks: list) -> tuple[dict, list]:
    out, blocks = g11_rewrite_transaction(meta, blocks)
    if not V11:
        ctx = g11.CONTEXT
        pt_f32: list[float] = []
        entries, removed, emits = _particles_tables(ctx["encoding"], ctx["base"], ctx["cur"],
                                                    pt_f32)
        if entries or removed or emits:
            out = g11._with_after(out, _after_key(out), [("particles", entries),
                                                         ("removed_particles", removed),
                                                         ("particle_emits", emits)])
        if pt_f32:  # the tenth block, only when non-empty
            blocks = list(blocks) + [g6.f32block("pt_f32", pt_f32)]
    if MUTATE is not None:
        out, blocks = MUTATE(out, blocks)
    return out, blocks


g11._rewrite_transaction = _rewrite_transaction
PM5_FEATURES = True  # False while writing particles-feature (a session from before PM5)


def _pm5_features(features: dict) -> dict:
    assert "add_particles" not in features["ops"]
    assert "canvas_item_add_particles" in features["observed_unsupported_ops"]
    return dict(
        features,
        ops=sorted(list(features["ops"]) + ["add_particles"]),
        resources=sorted(list(features["resources"]) + ["particles"]),
        observed_unsupported_ops=[op for op in features["observed_unsupported_ops"]
                                  if op != "canvas_item_add_particles"],
    )


g11_encode_record = g6.encode_record


def _encode_record(meta: dict, blocks: list, short_block: str | None = None) -> bytes:
    if not V11 and PM5_FEATURES and meta["type"] == "session":
        meta = dict(meta, features=_pm5_features(meta["features"]))
    return g11_encode_record(meta, blocks, short_block)


g6.encode_record = _encode_record

# --------------------------------------------------------------------------- shader 2 / material 2

PPM_CODE = (
    "// NOTE: Shader automatically converted from Godot Engine 4.5.1.stable's "
    "ParticleProcessMaterial.\n\nshader_type particles;\nrender_mode disable_velocity;\n\n"
    "uniform vec3 emission_box_extents;\nuniform sampler2D color_ramp : repeat_disable;\n"
    "uniform sampler2D scale_curve : repeat_disable;\n\n"
    "void start() {\n\tTRANSFORM[3].xyz = (vec3(0.0) * 2.0 - 1.0) * emission_box_extents;\n}\n\n"
    "void process() {\n\tCOLOR = texture(color_ramp, vec2(CUSTOM.y));\n}\n"
)
PPM_PAYLOAD = g6.build_shader_payload(PPM_CODE)
HASH_PPM = g6.shader_payload_sha256(PPM_PAYLOAD)
g11.PAYLOADS[HASH_PPM] = PPM_PAYLOAD

PPM_BUILTIN_KEYS = ("kind", "emission_shape", "particle_flags", "textures", "color_ramp",
                    "color_initial_ramp", "alpha_curve", "emission_curve", "velocity_limit_curve",
                    "orbit_velocity_curve_xyz", "emission_color_texture", "sub_emitter",
                    "attractor", "collision", "collision_scale", "turbulence")


def builtin_ppm(*, emission_shape: str = "point", particle_flags: list[str] = (),
                textures: list[str] = (), color_ramp: bool = False, sub_emitter: str = "disabled",
                **flags: bool) -> dict:
    out = {"kind": "particle_process_material", "emission_shape": emission_shape,
           "particle_flags": list(particle_flags), "textures": list(textures),
           "color_ramp": color_ramp}
    for key in ("color_initial_ramp", "alpha_curve", "emission_curve", "velocity_limit_curve",
                "orbit_velocity_curve_xyz", "emission_color_texture"):
        out[key] = flags.pop(key, False)
    out["sub_emitter"] = sub_emitter
    out["attractor"] = flags.pop("attractor", False)
    out["collision"] = flags.pop("collision", "disabled")
    out["collision_scale"] = flags.pop("collision_scale", False)
    out["turbulence"] = flags.pop("turbulence", False)
    assert not flags and tuple(out) == PPM_BUILTIN_KEYS
    return out


PPM_BUILTIN = builtin_ppm(emission_shape="box", textures=["scale"], color_ramp=True)


def ppm_shader() -> dict:
    return dict(g6.shader(version=1, mode="particles", hash=HASH_PPM,
                          payload_bytes=len(PPM_PAYLOAD), builtin=PPM_BUILTIN, uses=[]),
                origin="created")


def ppm_material(shader_id: int, params: list[dict]) -> dict:
    return dict(g6.material(version=1, shader=shader_id, params=params), origin="created")


# --------------------------------------------------------------------------- the five states

PT_UNKNOWN_19 = {"op": "canvas_item_add_particles", "item": 19, "reason": "unknown-particles"}
PT_UNSUPPORTED_18 = {"op": "canvas_item_add_particles", "item": 18,
                     "reason": "unsupported-particles"}


def _copy(state: dict) -> dict:
    out = g11._copy(state)
    out["particle_emits"] = []  # an emit list is per frame, never carried into the next state
    return out


def _sorted_unsupported(entries: list[dict]) -> list[dict]:
    return sorted(entries, key=lambda u: (u["item"], u["op"]))


E1_FLOATS_22 = pt_floats(lifetime=2.0, explosiveness=0.25, randomness=0.5,
                         custom_aabb=[-64.0, -64.0, 0.0, 128.0, 128.0, 0.0])
E2_FLOATS_22 = pt_floats(lifetime=0.5, emission_transform=xform3([100.0, 50.0, 0.0]),
                         emitter_velocity=[4.0, 0.0, 0.0])
TRAIL_POSES_24 = [xform3([0.0, 0.0, 0.0]), xform3([0.0, -4.0, 0.0])]


def state22() -> dict:
    state = _copy(g11.STATES[20])
    state["shaders"][2] = ppm_shader()
    state["materials"][2] = ppm_material(2, [
        g6.param("color_ramp", "rid", tex=2),
        g6.param("emission_box_extents", "vector3", floats=[8.0, 8.0, 0.0]),
        g6.param("scale_curve", "rid", tex=1),
    ])
    state["particles"] = {
        1: particles(version=14, emitting=True, amount=8, fixed_fps=30, local=True, seed=1234,
                     process_material=2, draw_passes=[1], floats=E1_FLOATS_22),
        2: particles(version=9, emitting=True, amount=4, process_material=2, draw_passes=[None],
                     subemitter=1, floats=E2_FLOATS_22),
    }
    items = state["items"]
    items[18] = g10._bb_item(parent=("canvas", 1), children=[], x=224.0, draw_index=14,
                             content_version=1, commands=[add_particles(1, 1), add_particles(2)])
    items[19] = g10._bb_item(parent=("canvas", 1), children=[], x=240.0, draw_index=15,
                             content_version=1,
                             commands=[g6.unsupported_cmd("canvas_item_add_particles",
                                                          "unknown-particles")])
    state["canvases"][1] = g6.root_canvas([1, 2, 3, 4, 5, 8, 9, 10, 12, 13, 14, 16, 17, 18, 19])
    state["unsupported"] = _sorted_unsupported(list(state["unsupported"]) + [PT_UNKNOWN_19])
    return state


def state23() -> dict:
    state = _copy(STATES[21])
    pts = state["particles"]
    pts[2] = dict(pts[2], version=10, floats=pt_floats(
        lifetime=0.5, emission_transform=xform3([104.0, 50.0, 0.0]),
        emitter_velocity=[4.0, 0.0, 0.0]))
    pts[1] = dict(pts[1], version=18, seed=4321, restarts=1, emits=2)
    state["particle_emits"] = [
        emit(1, 1, 5, xform3([8.0, 4.0, 0.0]), [0.0, -16.0, 0.0], [1.0, 1.0, 1.0, 1.0],
             [0.0, 0.0, 0.0, 0.0]),
        emit(1, 1, 31, xform3([-8.0, 4.0, 0.0], (2.0, 2.0, 1.0)), [0.0, -32.0, 0.0],
             [1.0, 0.5, 0.25, 1.0], [0.5, 0.0, 0.0, 1.0]),
    ]
    return state


def state24() -> dict:
    state = _copy(STATES[22])
    pts = state["particles"]
    floats = list(E1_FLOATS_22)
    floats[7] = 0.5  # trail length
    pts[1] = particles(**{**{k: pts[1][k] for k in ENTRY_JSON_KEYS
                             if k not in ("origin", "trail_poses")},
                          "version": 20, "trails": True,
                          "floats": floats + TRAIL_POSES_24[0] + TRAIL_POSES_24[1]})
    pts[3] = particles(version=3, status="unsupported", reason="particles-3d", mode="3d",
                       emitting=True, amount=4)
    it = dict(state["items"][18])
    it["content_version"] = 2
    it["commands"] = [add_particles(1, 1), add_particles(2), add_particles(3)]
    state["items"][18] = it
    state["unsupported"] = _sorted_unsupported(list(state["unsupported"]) + [PT_UNSUPPORTED_18])
    return state


def state25() -> dict:
    state = _copy(STATES[23])
    pts = state["particles"]
    state["particles"] = {1: pts[1], 3: freed_particles(pts[3], 4)}
    it = dict(state["items"][18])
    it["content_version"] = 3
    it["commands"] = [add_particles(1, 1), add_particles(3)]
    state["items"][18] = it
    state["unsupported"] = [u for u in state["unsupported"] if u != PT_UNSUPPORTED_18]
    return state


def state26() -> dict:
    return _copy(STATES[24])


STATES: list[dict] = list(g11.STATES)
for _make in (state22, state23, state24, state25, state26):
    STATES.append(_make())
g11.STATES = STATES  # g11.inline_recording's callers pass states explicitly; kept consistent

# --------------------------------------------------------------------------- decode / resolved

FLOAT_NAMES = ("amount_ratio", "lifetime", "pre_process_time", "explosiveness", "randomness",
               "speed_scale", "collision_base_size", "trail_length", "interp_to_end",
               "request_process_time")


def resolved_floats(floats: list[float] | None) -> dict | None:
    if floats is None:
        return None
    out = {name: floats[i] for i, name in enumerate(FLOAT_NAMES)}
    out["custom_aabb"] = floats[10:16]
    out["emission_transform"] = floats[16:28]
    out["emitter_velocity"] = floats[28:31]
    out["trail_poses"] = [floats[i:i + 12] for i in range(31, len(floats), 12)]
    return out


def resolved_particles(pt_id: int, p: dict) -> dict:
    out = {"id": pt_id}
    for key in ENTRY_JSON_KEYS:
        out[key] = list(p[key]) if key == "draw_passes" else p[key]
    out["floats"] = resolved_floats(p["floats"])
    return out


def decode(data: bytes) -> dict:
    out = g6.decode(data)
    out["schema"] = "render-stream-12-decoded/1"
    return out


def resolved_state(state: dict) -> dict:
    out = g11.resolved_state(state)
    pts = state.get("particles", {})
    if pts:  # right after "multimeshes" (or "materials" when there is none), only when non-empty
        assert list(out)[-1] in ("materials", "multimeshes")
        out["particles"] = [resolved_particles(i, pts[i]) for i in sorted(pts)]
    return out


# --------------------------------------------------------------------------- invalid vectors

MINI_SESSION = g11.MINI_SESSION
MINI_STREAM = g11.MINI_STREAM


def mini_pt_states() -> list[dict]:
    one = g11.mini_state({1: g11.mini_mesh([g11.mesh1_dyn()])})
    one["shaders"] = {1: ppm_shader()}
    one["materials"] = {1: ppm_material(1, [])}
    one["items"][1] = dict(one["items"][1], commands=[g6.add_mesh(1, g6.IDENTITY),
                                                      add_particles(1), add_particles(2)])
    one["particles"] = {
        1: particles(version=5, emitting=True, amount=2, local=True, seed=7, process_material=1,
                     draw_passes=[1], emits=1),
        2: particles(version=3, emitting=True, amount=1, subemitter=1, draw_passes=[None],
                     floats=pt_floats(emission_transform=xform3([16.0, 8.0, 0.0]))),
    }
    one["particle_emits"] = [emit(1, 0, 1, xform3([2.0, 2.0, 0.0]), [0.0, 0.0, 0.0],
                                  [1.0, 1.0, 1.0, 1.0], [0.0, 0.0, 0.0, 0.0])]
    two = _copy(one)
    two["particles"][1] = dict(two["particles"][1], version=6,
                               floats=pt_floats(emission_transform=xform3([1.0, 0.0, 0.0])))
    return [one, two]


def mini_recording(states: list[dict] | None = None, mutate=None, *, patch: bool = False,
                   mutate_seq: int | None = None) -> bytes:
    """golden-11's mini_recording over this module's MUTATE hook."""
    global MUTATE
    states = states or mini_pt_states()
    session = g9.session_record(MINI_STREAM, "file", "patch" if patch else "full", MINI_SESSION,
                                delivery="out-of-band", adoption=None, decode="off")
    records = [session]
    for i, state in enumerate(states):
        seq = i + 1
        MUTATE = mutate if (mutate_seq is None or mutate_seq == seq) else None
        try:
            if patch and i > 0:
                records.append(g6.patch_transaction_bytes(seq, seq, seq - 1, states[i - 1],
                                                          state))
            else:
                records.append(g6.full_transaction_bytes(seq, seq, state))
        finally:
            MUTATE = None
    end = g6.end_record(len(states), records, diff_ns_total=0,
                        full_transactions=1 if patch else len(states),
                        patch_transactions=len(states) - 1 if patch else 0,
                        resource_records=0, resource_bytes=0)
    return g6.recording(records, end)


def _pt_entry(pt_id: int, fn):
    def mutate(meta: dict, blocks: list):
        pts = []
        for entry in meta["particles"]:
            entry = dict(entry)
            if entry["id"] == pt_id:
                fn(entry)
            pts.append(entry)
        return dict(meta, particles=pts), blocks
    return mutate


def _pt_block(fn):
    def mutate(meta: dict, blocks: list):
        return meta, [fn(b) if b[0] == "pt_f32" else b for b in blocks]
    return mutate


def _insert_key(key: str, value, after: str):
    def mutate(meta: dict, blocks: list):
        out = {}
        for k, v in meta.items():
            if k == key:
                continue
            out[k] = v
            if k == after:
                out[key] = value
        return out, blocks
    return mutate


def _shader_builtin(fn):
    def mutate(meta: dict, blocks: list):
        shaders = []
        for s in meta["shaders"]:
            s = dict(s)
            if s["builtin"] is not None:
                s["builtin"] = fn(dict(s["builtin"]))
            shaders.append(s)
        return dict(meta, shaders=shaders), blocks
    return mutate


def _add_command(command: dict):
    def mutate(meta: dict, blocks: list):
        items = []
        for entry in meta["items"]:
            entry = dict(entry)
            if entry["id"] == 1:
                entry["commands"] = list(entry["commands"]) + [command]
            items.append(entry)
        return dict(meta, items=items), blocks
    return mutate


def _emits(fn):
    def mutate(meta: dict, blocks: list):
        return dict(meta, particle_emits=fn([dict(e) for e in meta["particle_emits"]])), blocks
    return mutate


def build_invalid_vectors() -> dict[str, tuple[bytes, str, str, int]]:
    global PM5_FEATURES
    out: dict[str, tuple[bytes, str, str, int]] = {}
    out["bad-magic"] = ((GOLDEN11 / "full.rs11").read_bytes(), "bad-magic",
                        "golden-11's full.rs11: magic byte 3 is 'B' (GRSB), not 'C'", 12)
    mini = mini_pt_states()
    full1 = [mini[0]]
    # Seq 1's pt_f32: emitter 1 at 0, emitter 2 at 31, the emit at 62: 85 floats.

    # pt-offset
    out["pt-offset-wrong"] = (
        mini_recording(full1, _pt_entry(2, lambda e: e.update(f=e["f"] + 1))), "pt-offset",
        "emitter 2's f is 32, expected 31 (emitter 1 claims 31 floats)", 12)
    out["pt-offset-short"] = (
        mini_recording(full1, _pt_block(lambda b: (b[0], b[1], b[2][:-1]))), "pt-offset",
        "pt_f32 carries 84 floats (count 84), the entries and the emit claim 85", 12)
    out["pt-offset-empty"] = (
        _pt_offset_empty(), "pt-offset",
        "seq 2 (a patch that carries no particles float) carries an empty pt_f32 block (the "
        "block is present only when non-empty)", 12)
    out["pt-offset-missing"] = (
        mini_recording(full1, lambda meta, blocks: (meta, [b for b in blocks
                                                           if b[0] != "pt_f32"])),
        "pt-offset", "seq 1's entries and emit claim 85 floats, but it carries no pt_f32 block",
        12)

    # particles-entry
    out["particles-entry"] = (
        mini_recording(full1, _pt_entry(1, lambda e: e.update(reason="particles-3d"))),
        "particles-entry", "emitter 1 is ok with reason \"particles-3d\" (ok needs null)", 12)
    freed = [_copy(mini[0])]
    freed[0]["particles"][2] = dict(freed_particles(freed[0]["particles"][2], 4),
                                    floats=pt_floats())
    out["particles-entry-freed-floats"] = (
        mini_recording(freed), "particles-entry",
        "emitter 2 is a freed tombstone that carries f 31 and its 31 floats (freed needs f null)",
        12)
    trails = [_copy(mini[0])]
    trails[0]["particles"][2] = particles(
        **{**{k: trails[0]["particles"][2][k] for k in ENTRY_JSON_KEYS
              if k not in ("origin", "trail_poses")},
           "floats": trails[0]["particles"][2]["floats"] + IDENTITY3, "check": False})
    out["particles-entry-trails"] = (
        mini_recording(trails), "particles-entry",
        "emitter 2 has trail_poses 1 (and its 43 floats) with trails false", 12)

    # particles-version
    out["particles-version"] = (
        mini_recording(mini, _pt_entry(1, lambda e: e.update(version=4)), patch=True,
                       mutate_seq=2), "particles-version",
        "seq 2 carries emitter 1 (a moved emission transform) at version 4, below the base's 5",
        12)
    out["particles-version-json"] = (
        mini_recording(mini, _pt_entry(1, lambda e: e.update(version=5, emitting=False)),
                       patch=True, mutate_seq=2), "particles-version",
        "seq 2 carries emitter 1 with emitting false (and moved floats) at the base's version 5",
        12)
    out["particles-version-floats"] = (
        mini_recording(mini, _pt_entry(1, lambda e: e.update(version=5)), patch=True,
                       mutate_seq=2), "particles-version",
        "seq 2 carries emitter 1 with a moved emission transform (floats only) at the base's "
        "version 5", 12)

    # particles-ref
    out["particles-ref-command"] = (
        mini_recording(full1, _add_command(add_particles(9))), "particles-ref",
        "item 1 also draws add_particles 9, which has no particles entry", 12)
    out["particles-ref-material"] = (
        mini_recording(full1, _pt_entry(1, lambda e: e.update(process_material=7))),
        "particles-ref", "emitter 1's process_material is 7, which has no material entry", 12)
    out["particles-ref-mesh"] = (
        mini_recording(full1, _pt_entry(1, lambda e: e.update(draw_passes=[7]))),
        "particles-ref", "emitter 1's draw pass names mesh 7, which has no mesh entry", 12)
    out["particles-ref-subemitter"] = (
        mini_recording(full1, _pt_entry(2, lambda e: e.update(subemitter=9))),
        "particles-ref", "emitter 2's subemitter is 9, which has no particles entry", 12)

    # particle-emits
    def second_emit(emits: list[dict]) -> list[dict]:
        return emits + [dict(emits[0], f=emits[0]["f"] + EMIT_FLOATS)]

    def with_second_emit(meta: dict, blocks: list):
        meta, blocks = _emits(second_emit)(meta, blocks)
        return meta, [(b[0], b[1], b[2] + b[2][-EMIT_FLOATS:]) if b[0] == "pt_f32" else b
                      for b in blocks]

    out["particle-emits-count"] = (
        mini_recording(full1, with_second_emit), "particle-emits",
        "a full transaction lists two emits on emitter 1, whose emits counter is 1", 12)
    out["particle-emits-unknown"] = (
        mini_recording(full1, _emits(lambda es: [dict(es[0], particles=9)])), "particle-emits",
        "the emit names emitter 9, which has no particles entry", 12)
    out["particle-emits-restarts"] = (
        mini_recording(full1, _emits(lambda es: [dict(es[0], restarts=1)])), "particle-emits",
        "the emit's restarts is 1, above emitter 1's restarts 0", 12)

    # builtin-entry
    def swap_keys(b: dict) -> dict:
        keys = list(b)
        i, j = keys.index("textures"), keys.index("color_ramp")
        keys[i], keys[j] = keys[j], keys[i]
        return {k: b[k] for k in keys}

    out["builtin-entry-order"] = (
        mini_recording(full1, _shader_builtin(swap_keys)), "builtin-entry",
        "shader 1's particle_process_material builtin has color_ramp before textures", 12)
    out["builtin-entry-list"] = (
        mini_recording(full1, _shader_builtin(lambda b: dict(b, textures=["scale", "angle"]))),
        "builtin-entry",
        "shader 1's builtin textures is [\"scale\", \"angle\"], not in Parameter enum order", 12)
    out["builtin-entry-canvas"] = (
        mini_recording(full1, lambda meta, blocks: (dict(meta, shaders=[
            dict(s, mode="canvas_item") for s in meta["shaders"]]), blocks)),
        "builtin-entry",
        "shader 1 carries the particle_process_material builtin but its mode is canvas_item", 12)

    # meta-schema
    out["particles-empty-key"] = (
        mini_recording([mini[0], _copy(mini[0])], _insert_key("particles", [], "materials"),
                       patch=True, mutate_seq=2), "meta-schema",
        "an unchanged patch carries \"particles\": [] (the key is present only when non-empty)",
        12)
    out["particles-removed-empty-key"] = (
        mini_recording(mini, _insert_key("removed_particles", [], "particles"), patch=True,
                       mutate_seq=2), "meta-schema",
        "a patch carries \"removed_particles\": [] (the key is present only when non-empty)", 12)
    out["particle-emits-empty-key"] = (
        mini_recording(mini, _insert_key("particle_emits", [], "particles"), patch=True,
                       mutate_seq=2), "meta-schema",
        "a patch carries \"particle_emits\": [] (the key is present only when non-empty)", 12)
    out["particles-removed-full"] = (
        mini_recording(full1, _insert_key("removed_particles", [3], "particles")),
        "patch-encoding", "a full transaction carries \"removed_particles\": [3]", 12)
    PM5_FEATURES = False
    try:
        out["particles-feature"] = (
            mini_recording(full1), "meta-schema",
            "item 1 draws add_particles in a session whose features.ops lacks add_particles (the "
            "session record from before PM5)", 12)
    finally:
        PM5_FEATURES = True

    # A /11 stream (golden-11's mini scene) whose transaction carries a particles key.
    entry = {"id": 1, "origin": "created", "status": "ok", "reason": None, "version": 1,
             "mode": "2d", "emitting": False, "amount": 0, "one_shot": False, "fixed_fps": 0,
             "interpolate": True, "fractional_delta": False, "local": False,
             "draw_order": "index", "transform_align": "disabled", "trails": False,
             "trail_poses": 0, "seed": 0, "restarts": 0, "emits": 0, "process_requests": 0,
             "process_material": None, "draw_passes": [], "subemitter": None, "f": 0}

    def v11_key(meta: dict, blocks: list):
        meta, blocks = _insert_key("particles", [entry], "materials")(meta, blocks)
        return meta, list(blocks) + [g6.f32block("pt_f32", pt_floats())]

    with as_v11():
        v11 = mini_recording([g11.mini_states()[0]], v11_key)
    out["particles-v11"] = (
        v11, "meta-schema",
        "a render-stream/11 transaction (golden-11's mini scene) carries a \"particles\" key and "
        "a pt_f32 block, which exist only at /12", 11)
    return out


def _pt_offset_empty() -> bytes:
    # Two unchanged states: the patch carries no particles key and no float.
    mini = mini_pt_states()
    states = [mini[0], _copy(mini[0])]
    return mini_recording(states, lambda meta, blocks: (
        meta, list(blocks) + [g6.f32block("pt_f32", [])]), patch=True, mutate_seq=2)


# --------------------------------------------------------------------------- control messages


def control_messages() -> dict[str, dict]:
    hello11 = g11.control_messages()["valid"]["hello-native-block"]
    assert hello11["protocol"] == PROTOCOL
    hello12 = dict(hello11, receiver="gate12-native")
    return {
        "valid": {
            "hello-native-block": hello12,
            "hello-live-coding": dict(hello12, live_coding="zstd-base,zstd"),
        },
        "invalid": {
            "hello-wrong-protocol": dict(hello12, protocol="render-stream/11"),
            "hello-live-coding-grammar": dict(hello12, live_coding="zstd-base,"),
        },
    }


# --------------------------------------------------------------------------- build


def build() -> dict[str, bytes]:
    full_session = g9.session_record("1" * 32, "file", "full", "0123456789abcdef0123456789abcdef",
                                     delivery="out-of-band")
    full_records = [full_session]
    for i, state in enumerate(STATES):
        full_records.append(g6.full_transaction_bytes(i + 1, i + 1, state))
    full_end = g6.end_record(len(STATES), full_records, diff_ns_total=0,
                             full_transactions=len(STATES), patch_transactions=0,
                             resource_records=0, resource_bytes=0)
    full_rs12 = g6.recording(full_records, full_end)

    patch_session = g9.session_record("2" * 32, "file", "patch",
                                      "fedcba9876543210fedcba9876543210", delivery="out-of-band")
    full_seqs = (1, 5, 16, 21, 26)  # 5, 16, 21 and 26: a resync's full
    patch_records = [patch_session]
    for i, state in enumerate(STATES):
        seq = i + 1
        if seq in full_seqs:
            patch_records.append(g6.full_transaction_bytes(seq, seq, state))
        else:
            patch_records.append(g6.patch_transaction_bytes(seq, seq, seq - 1, STATES[i - 1],
                                                            state))
    patch_end = g6.end_record(len(STATES), patch_records, diff_ns_total=12345,
                              full_transactions=len(full_seqs),
                              patch_transactions=len(STATES) - len(full_seqs),
                              resource_records=0, resource_bytes=0)
    patch_rs12 = g6.recording(patch_records, patch_end)

    inline_rs12, inline_payloads = g11.inline_recording(
        STATES, session_id=g11.INLINE_SESSION, stream_id=g11.INLINE_STREAM)

    full_decoded, patch_decoded = decode(full_rs12), decode(patch_rs12)
    inline_decoded = decode(inline_rs12)
    resolved = {
        "schema": "render-stream-12-resolved/1",
        "transactions": [{"seq": i + 1, "frame": i + 1, "state": resolved_state(s)}
                         for i, s in enumerate(STATES)],
    }

    inline_resources = []
    pending = []
    for i, rec in enumerate(inline_decoded["records"]):
        meta = rec["meta"]
        if meta["type"] == "resource":
            pending.append({"hash": meta["hash"], "bytes": meta["bytes"], "record_index": i})
        elif meta["type"] == "transaction":
            for p in pending:
                inline_resources.append(dict(p, before_seq=meta["seq"]))
            pending = []
    assert not pending and len(inline_resources) == len(inline_payloads)

    seq3_offset = patch_decoded["records"][3]["offset"]
    corrupt_rs12 = bytearray(patch_rs12)
    assert corrupt_rs12[seq3_offset + 8] == ord("{")
    corrupt_rs12[seq3_offset + 8] = 0x00

    invalid = build_invalid_vectors()
    control = control_messages()
    dynamic_bodies = [
        {"file": "payloads/mesh1-dyn.body", "source": "mesh1-b moved right by 1",
         "sha256": _sha256(g11.body_of(g11.MESH1_DYN_PAYLOAD)),
         "bytes": len(g11.body_of(g11.MESH1_DYN_PAYLOAD))},
        {"file": "payloads/mesh1-tri.body", "source": "textured triangle",
         "sha256": _sha256(g11.body_of(g11.MESH1_TRI_PAYLOAD)),
         "bytes": len(g11.body_of(g11.MESH1_TRI_PAYLOAD))},
        {"file": "payloads/mesh2-tri.body", "source": "mesh1-a moved down by 20",
         "sha256": _sha256(g11.body_of(g11.MESH2_TRI_PAYLOAD)),
         "bytes": len(g11.body_of(g11.MESH2_TRI_PAYLOAD))},
    ]
    index = {
        "schema": "render-stream-12-golden-index/1",
        "protocol": PROTOCOL,
        "valid": [
            {"file": "full.rs12", "hex": "full.hex", "decoded": "full.decoded.json",
             "sha256": _sha256(full_rs12)},
            {"file": "patch.rs12", "hex": "patch.hex", "decoded": "patch.decoded.json",
             "sha256": _sha256(patch_rs12)},
            {"file": "inline.rs12", "hex": "inline.hex", "decoded": "inline.decoded.json",
             "sha256": _sha256(inline_rs12)},
        ],
        "resolved": "resolved.json",
        "inline_resources": inline_resources,
        "names": [{"seq": i + 1, "names": g11.names(s)} for i, s in enumerate(STATES)],
        "dynamic_bodies": dynamic_bodies,
        "shader_payloads": [
            {"file": "payloads/shader-ppm.grp", "hash": HASH_PPM, "bytes": len(PPM_PAYLOAD)},
        ],
        "corrupt": [
            {"file": "corrupt-meta.rs12", "code": "meta-json", "record_index": 3, "seq": 3,
             "description": "patch.rs12 transaction seq 3: first meta byte set to 0x00; framing intact"},
        ],
        "invalid": [
            {"file": f"invalid/{name}.rs{version}", "code": code, "version": version,
             "description": description}
            for name, (_, code, description, version) in invalid.items()
        ],
        "control": {
            "valid": [f"control/valid/{name}.json" for name in control["valid"]],
            "invalid": [f"control/invalid/{name}.json" for name in control["invalid"]],
        },
    }
    outputs: dict[str, bytes] = {
        "full.rs12": full_rs12, "full.hex": g6.to_hex(full_rs12).encode("ascii"),
        "full.decoded.json": g6.pretty(full_decoded),
        "patch.rs12": patch_rs12, "patch.hex": g6.to_hex(patch_rs12).encode("ascii"),
        "patch.decoded.json": g6.pretty(patch_decoded),
        "inline.rs12": inline_rs12, "inline.hex": g6.to_hex(inline_rs12).encode("ascii"),
        "inline.decoded.json": g6.pretty(inline_decoded),
        "resolved.json": g6.pretty(resolved),
        "corrupt-meta.rs12": bytes(corrupt_rs12),
        "index.json": g6.pretty(index),
        "payloads/mesh1-dyn.body": g11.body_of(g11.MESH1_DYN_PAYLOAD),
        "payloads/mesh1-tri.body": g11.body_of(g11.MESH1_TRI_PAYLOAD),
        "payloads/mesh2-tri.body": g11.body_of(g11.MESH2_TRI_PAYLOAD),
        "payloads/shader-ppm.grp": PPM_PAYLOAD,
    }
    for name, (data, _, _, version) in invalid.items():
        outputs[f"invalid/{name}.rs{version}"] = data
    for kind in ("valid", "invalid"):
        for name, msg in control[kind].items():
            outputs[f"control/{kind}/{name}.json"] = g6.pretty(msg)
    return outputs


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


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
