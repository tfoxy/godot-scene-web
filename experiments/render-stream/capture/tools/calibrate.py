#!/usr/bin/env python3
"""Derive a RenderingServer vtable calibration record from a Godot ELF or PE binary.

Gate -1 of docs/handoff-headless-render-stream.md. Stdlib only, read-only: the
binary is never modified and never executed.

What it does, in order:

1. Parses ELF or PE headers, sections and relocations.
2. Finds the Itanium-ABI RTTI typeinfo name strings for `RenderingServer` and
   its concrete subclass, then the typeinfo objects that point at them, then the
   vtables that point at those typeinfo objects.
3. Walks each vtable from its address point and records, per slot, whether it
   holds a real code address ("implemented") or the pure-virtual placeholder.
4. Parses the ordered virtual-method list of `class RenderingServer` out of the
   pinned `servers/rendering_server.h`, honouring the release preprocessor
   define set, and derives the `Object` vtable prefix from the slot count.
5. Verifies that every non-pure method in the header lands on an implemented
   slot and every pure method on a placeholder slot, with the matching prefix
   unique, then emits the record.

The record is evidence, not a contract with the engine: the extension re-checks
every claim against live memory before it writes anything.
"""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import mmap
import os
import re
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import census as call_census

CALIBRATOR_VERSION = "9"
SCHEMA = "render-stream-calibration/1"

# Slots the capture library needs, as `record key -> accepted header names`.
# Hooked slots plus read-only probe slots used for the behavioural method-bind
# cross-check. A key keeps its name in the record even when the engine renamed
# the method (4.6 renamed `RenderingServer::free` to `free_rid`).
#
# The first block is the gate -1 set, which the library requires. Everything
# after it was added later and is optional to the library: a record written by
# an older calibrator that lacks those keys still loads, and the library leaves
# the missing hooks out and says so (README "Calibration records and hook
# versions"). Adding a key here is therefore backward compatible; renaming or
# removing one is not.
WANTED_SLOTS: tuple[tuple[str, tuple[str, ...]], ...] = (
    # calibrator 1: gate -1
    ("canvas_item_add_rect", ("canvas_item_add_rect",)),
    ("canvas_item_add_texture_rect", ("canvas_item_add_texture_rect",)),
    ("canvas_item_add_texture_rect_region", ("canvas_item_add_texture_rect_region",)),
    ("canvas_item_add_msdf_texture_rect_region", ("canvas_item_add_msdf_texture_rect_region",)),
    ("canvas_item_add_polygon", ("canvas_item_add_polygon",)),
    ("texture_2d_create", ("texture_2d_create",)),
    ("texture_2d_update", ("texture_2d_update",)),
    ("free", ("free", "free_rid")),
    ("get_default_clear_color", ("get_default_clear_color",)),
    # calibrator 2: geometry, nine-patch, canvas-item state, meshes (the
    # spine-godot draw path), materials and shaders
    ("canvas_item_add_triangle_array", ("canvas_item_add_triangle_array",)),
    ("canvas_item_add_mesh", ("canvas_item_add_mesh",)),
    ("canvas_item_add_multimesh", ("canvas_item_add_multimesh",)),
    ("canvas_item_add_nine_patch", ("canvas_item_add_nine_patch",)),
    ("canvas_item_add_primitive", ("canvas_item_add_primitive",)),
    ("canvas_item_add_line", ("canvas_item_add_line",)),
    ("canvas_item_add_polyline", ("canvas_item_add_polyline",)),
    ("canvas_item_add_circle", ("canvas_item_add_circle",)),
    ("canvas_item_add_set_transform", ("canvas_item_add_set_transform",)),
    ("canvas_item_set_transform", ("canvas_item_set_transform",)),
    ("canvas_item_set_modulate", ("canvas_item_set_modulate",)),
    ("canvas_item_create", ("canvas_item_create",)),
    ("canvas_item_clear", ("canvas_item_clear",)),
    ("canvas_item_set_material", ("canvas_item_set_material",)),
    ("mesh_create", ("mesh_create",)),
    ("mesh_add_surface", ("mesh_add_surface",)),
    ("mesh_surface_update_vertex_region", ("mesh_surface_update_vertex_region",)),
    ("mesh_surface_update_attribute_region", ("mesh_surface_update_attribute_region",)),
    ("mesh_clear", ("mesh_clear",)),
    ("mesh_set_custom_aabb", ("mesh_set_custom_aabb",)),
    ("shader_create_from_code", ("shader_create_from_code",)),
    ("shader_set_code", ("shader_set_code",)),
    ("material_set_param", ("material_set_param",)),
    # calibrator 3: gate 0's retained canvas mirror -- canvas and viewport
    # identity, parenting and per-item state
    ("viewport_attach_canvas", ("viewport_attach_canvas",)),
    ("viewport_set_canvas_transform", ("viewport_set_canvas_transform",)),
    ("canvas_create", ("canvas_create",)),
    ("canvas_item_set_parent", ("canvas_item_set_parent",)),
    ("canvas_item_set_visible", ("canvas_item_set_visible",)),
    ("canvas_item_set_clip", ("canvas_item_set_clip",)),
    ("canvas_item_set_custom_rect", ("canvas_item_set_custom_rect",)),
    ("canvas_item_set_self_modulate", ("canvas_item_set_self_modulate",)),
    ("canvas_item_set_visibility_layer", ("canvas_item_set_visibility_layer",)),
    ("canvas_item_set_z_index", ("canvas_item_set_z_index",)),
    ("canvas_item_set_draw_index", ("canvas_item_set_draw_index",)),
    # calibrator 4: draw-order items the mirror held at RS defaults
    ("canvas_item_set_z_as_relative_to_parent", ("canvas_item_set_z_as_relative_to_parent",)),
    ("canvas_item_set_draw_behind_parent", ("canvas_item_set_draw_behind_parent",)),
    # calibrator 5: textures -- placeholders, replacement, canvas textures and the
    # three levels of texture filter/repeat, plus the LCD
    # text draw so a silent op becomes visible
    ("texture_2d_placeholder_create", ("texture_2d_placeholder_create",)),
    ("texture_replace", ("texture_replace",)),
    (
        "viewport_set_default_canvas_item_texture_filter",
        ("viewport_set_default_canvas_item_texture_filter",),
    ),
    (
        "viewport_set_default_canvas_item_texture_repeat",
        ("viewport_set_default_canvas_item_texture_repeat",),
    ),
    ("canvas_texture_create", ("canvas_texture_create",)),
    ("canvas_texture_set_channel", ("canvas_texture_set_channel",)),
    ("canvas_texture_set_texture_filter", ("canvas_texture_set_texture_filter",)),
    ("canvas_texture_set_texture_repeat", ("canvas_texture_set_texture_repeat",)),
    ("canvas_item_set_default_texture_filter", ("canvas_item_set_default_texture_filter",)),
    ("canvas_item_set_default_texture_repeat", ("canvas_item_set_default_texture_repeat",)),
    ("canvas_item_add_lcd_texture_rect_region", ("canvas_item_add_lcd_texture_rect_region",)),
    # calibrator 6: clip_ignore refused, typed
    ("canvas_item_add_clip_ignore", ("canvas_item_add_clip_ignore",)),
    # calibrator 7: -- the two silent holes (draw_multiline /
    # draw_dashed_line's canvas_item_add_multiline, and a loaded ArrayMesh's
    # mesh_create_from_surfaces), typed refusals (particles, animation slice, skeleton
    # attach), and the remaining mesh region/removal hooks.
    ("canvas_item_add_multiline", ("canvas_item_add_multiline",)),
    ("canvas_item_add_particles", ("canvas_item_add_particles",)),
    ("canvas_item_add_animation_slice", ("canvas_item_add_animation_slice",)),
    ("canvas_item_attach_skeleton", ("canvas_item_attach_skeleton",)),
    ("mesh_create_from_surfaces", ("mesh_create_from_surfaces",)),
    ("mesh_surface_update_skin_region", ("mesh_surface_update_skin_region",)),
    ("mesh_surface_update_index_region", ("mesh_surface_update_index_region",)),
    ("mesh_surface_remove", ("mesh_surface_remove",)),
    # calibrator 8: three silent holes (every material's shader,
    # every CanvasItemMaterial shader, inherited materials), a canvas field and two typed
    # refusals (an unknown shader, canvas_light_attach_to_canvas).
    ("shader_create", ("shader_create",)),
    ("shader_set_default_texture_parameter", ("shader_set_default_texture_parameter",)),
    ("material_create", ("material_create",)),
    ("material_create_from_shader", ("material_create_from_shader",)),
    ("material_set_shader", ("material_set_shader",)),
    ("canvas_set_modulate", ("canvas_set_modulate",)),
    ("canvas_item_set_use_parent_material", ("canvas_item_set_use_parent_material",)),
    (
        "canvas_item_set_instance_shader_parameter",
        ("canvas_item_set_instance_shader_parameter",),
    ),
    ("canvas_light_attach_to_canvas", ("canvas_light_attach_to_canvas",)),
    # calibrator 9: -- CanvasLayer attach/stacking/removal, canvas-item
    # mirroring/repeat and the root's global canvas transform. Decode and hook-log only; no
    # mirror change (that lands in G6b).
    ("viewport_remove_canvas", ("viewport_remove_canvas",)),
    ("viewport_set_global_canvas_transform", ("viewport_set_global_canvas_transform",)),
    ("viewport_set_canvas_stacking", ("viewport_set_canvas_stacking",)),
    ("canvas_set_item_mirroring", ("canvas_set_item_mirroring",)),
    ("canvas_set_item_repeat", ("canvas_set_item_repeat",)),
    ("canvas_set_parent", ("canvas_set_parent",)),
    # The res:// path the engine gives a texture right
    # after texture_2d_create. Hooked only under GRC_TEXTURE_CACHE_DIR, so it is neither planned
    # nor omitted without it. It adds no calibrator version: the version is echoed in every
    # session record, and a run with no cache directory must stay byte-identical to before.
    ("texture_set_path", ("texture_set_path",)),
    # CG1 (render-stream-10.md) -- the back-buffer item
    # state: canvas-group mode (`clip_children`, CanvasGroup) and copy-to-backbuffer
    # (BackBufferCopy). Hooked only by a /10 session (GRC_STREAM_VERSION=10), so like
    # texture_set_path they add no calibrator version: below /10 they are neither planned nor
    # omitted, and every /2-/9 session record stays byte-identical.
    ("canvas_item_set_copy_to_backbuffer", ("canvas_item_set_copy_to_backbuffer",)),
    ("canvas_item_set_canvas_group_mode", ("canvas_item_set_canvas_group_mode",)),
    # P3-CK (render-stream-10.md "Shader time") -- RenderingServer::draw(swap_buffers,
    # frame_step), whose frame_step is the step GLES3's TIME adds (main.cpp:4825-4829 pass the
    # main loop's unclamped scaled_step; the tree's process delta is clamped after a stall).
    # Hooked only by a /10 session, like CG1's two: it adds no calibrator version.
    ("draw", ("draw",)),
    # calibrator 11 (PM1, render-stream-11.md "As built (PM1)") -- the multimesh_* mutators: the
    # instance buffer every CPUParticles2D sets each frame, its allocation and the per-instance
    # setters. Hooked only by a /11 session (GRC_STREAM_VERSION=11), like CG1's: they add no
    # calibrator version, and below /11 they are neither planned nor omitted.
    ("multimesh_create", ("multimesh_create",)),
    ("multimesh_allocate_data", ("multimesh_allocate_data",)),
    ("multimesh_set_mesh", ("multimesh_set_mesh",)),
    ("multimesh_instance_set_transform", ("multimesh_instance_set_transform",)),
    ("multimesh_instance_set_transform_2d", ("multimesh_instance_set_transform_2d",)),
    ("multimesh_instance_set_color", ("multimesh_instance_set_color",)),
    ("multimesh_instance_set_custom_data", ("multimesh_instance_set_custom_data",)),
    ("multimesh_set_custom_aabb", ("multimesh_set_custom_aabb",)),
    ("multimesh_set_buffer", ("multimesh_set_buffer",)),
    ("multimesh_set_buffer_interpolated", ("multimesh_set_buffer_interpolated",)),
    ("multimesh_set_physics_interpolated", ("multimesh_set_physics_interpolated",)),
    ("multimesh_set_visible_instances", ("multimesh_set_visible_instances",)),
    # calibrator 12 (PM5, render-stream-12.md "Calibration") -- the 33 particles_* mutators of
    # servers/rendering_server.h:770-842 (the getters are not hooked). Hooked only by a /12 session
    # (GRC_STREAM_VERSION=12), like PM1's: they add no calibrator version, and below /12 they are
    # neither planned nor omitted.
    ("particles_create", ("particles_create",)),
    ("particles_set_mode", ("particles_set_mode",)),
    ("particles_set_emitting", ("particles_set_emitting",)),
    ("particles_set_amount", ("particles_set_amount",)),
    ("particles_set_amount_ratio", ("particles_set_amount_ratio",)),
    ("particles_set_lifetime", ("particles_set_lifetime",)),
    ("particles_set_one_shot", ("particles_set_one_shot",)),
    ("particles_set_pre_process_time", ("particles_set_pre_process_time",)),
    ("particles_request_process_time", ("particles_request_process_time",)),
    ("particles_set_explosiveness_ratio", ("particles_set_explosiveness_ratio",)),
    ("particles_set_randomness_ratio", ("particles_set_randomness_ratio",)),
    ("particles_set_custom_aabb", ("particles_set_custom_aabb",)),
    ("particles_set_speed_scale", ("particles_set_speed_scale",)),
    ("particles_set_use_local_coordinates", ("particles_set_use_local_coordinates",)),
    ("particles_set_process_material", ("particles_set_process_material",)),
    ("particles_set_fixed_fps", ("particles_set_fixed_fps",)),
    ("particles_set_interpolate", ("particles_set_interpolate",)),
    ("particles_set_fractional_delta", ("particles_set_fractional_delta",)),
    ("particles_set_collision_base_size", ("particles_set_collision_base_size",)),
    ("particles_set_seed", ("particles_set_seed",)),
    ("particles_set_transform_align", ("particles_set_transform_align",)),
    ("particles_set_trails", ("particles_set_trails",)),
    ("particles_set_trail_bind_poses", ("particles_set_trail_bind_poses",)),
    ("particles_request_process", ("particles_request_process",)),
    ("particles_restart", ("particles_restart",)),
    ("particles_set_subemitter", ("particles_set_subemitter",)),
    ("particles_emit", ("particles_emit",)),
    ("particles_set_draw_order", ("particles_set_draw_order",)),
    ("particles_set_draw_passes", ("particles_set_draw_passes",)),
    ("particles_set_draw_pass_mesh", ("particles_set_draw_pass_mesh",)),
    ("particles_set_emission_transform", ("particles_set_emission_transform",)),
    ("particles_set_emitter_velocity", ("particles_set_emitter_velocity",)),
    ("particles_set_interp_to_end", ("particles_set_interp_to_end",)),
    # UIT (render-stream-11.md "As built (UIT)") -- canvas_item_set_use_identity_transform, the
    # call a global-coordinate CPUParticles2D makes. Hooked only by a /11 session, like PM1's:
    # it adds no calibrator version, and below /11 it is neither planned nor omitted.
    ("canvas_item_set_use_identity_transform", ("canvas_item_set_use_identity_transform",)),
)

# Every wanted slot belongs to one indivisible capture family.
FAMILIES = {
    "canvas_item_add_rect": "required",
    "canvas_item_add_texture_rect": "required",
    "canvas_item_add_texture_rect_region": "required",
    "canvas_item_add_msdf_texture_rect_region": "required",
    "canvas_item_add_polygon": "required",
    "texture_2d_create": "required",
    "texture_2d_update": "required",
    "free": "required",
    "get_default_clear_color": "probe",
    "canvas_item_add_triangle_array": "canvas_item_draw",
    "canvas_item_add_mesh": "canvas_item_draw",
    "canvas_item_add_multimesh": "canvas_item_draw",
    "canvas_item_add_nine_patch": "canvas_item_draw",
    "canvas_item_add_primitive": "canvas_item_draw",
    "canvas_item_add_line": "canvas_item_draw",
    "canvas_item_add_polyline": "canvas_item_draw",
    "canvas_item_add_circle": "canvas_item_draw",
    "canvas_item_add_set_transform": "canvas_item_draw",
    "canvas_item_set_transform": "canvas_item_state",
    "canvas_item_set_modulate": "canvas_item_state",
    "canvas_item_create": "canvas_item_state",
    "canvas_item_clear": "canvas_item_draw",
    "canvas_item_set_material": "canvas_item_state",
    "mesh_create": "mesh",
    "mesh_add_surface": "mesh",
    "mesh_surface_update_vertex_region": "mesh",
    "mesh_surface_update_attribute_region": "mesh",
    "mesh_clear": "mesh",
    "mesh_set_custom_aabb": "mesh",
    "shader_create_from_code": "material_shader",
    "shader_set_code": "material_shader",
    "material_set_param": "material_shader",
    "viewport_attach_canvas": "canvas_viewport",
    "viewport_set_canvas_transform": "canvas_viewport",
    "canvas_create": "canvas_viewport",
    "canvas_item_set_parent": "canvas_item_state",
    "canvas_item_set_visible": "canvas_item_state",
    "canvas_item_set_clip": "canvas_item_state",
    "canvas_item_set_custom_rect": "canvas_item_state",
    "canvas_item_set_self_modulate": "canvas_item_state",
    "canvas_item_set_visibility_layer": "canvas_item_state",
    "canvas_item_set_z_index": "canvas_item_state",
    "canvas_item_set_draw_index": "canvas_item_state",
    "canvas_item_set_z_as_relative_to_parent": "canvas_item_state",
    "canvas_item_set_draw_behind_parent": "canvas_item_state",
    "texture_2d_placeholder_create": "texture",
    "texture_replace": "texture",
    "viewport_set_default_canvas_item_texture_filter": "canvas_viewport",
    "viewport_set_default_canvas_item_texture_repeat": "canvas_viewport",
    "canvas_texture_create": "texture",
    "canvas_texture_set_channel": "texture",
    "canvas_texture_set_texture_filter": "texture",
    "canvas_texture_set_texture_repeat": "texture",
    "canvas_item_set_default_texture_filter": "canvas_item_state",
    "canvas_item_set_default_texture_repeat": "canvas_item_state",
    "canvas_item_add_lcd_texture_rect_region": "canvas_item_draw",
    "canvas_item_add_clip_ignore": "canvas_item_draw",
    "canvas_item_add_multiline": "canvas_item_draw",
    "canvas_item_add_particles": "canvas_item_draw",
    "canvas_item_add_animation_slice": "canvas_item_draw",
    "canvas_item_attach_skeleton": "canvas_item_state",
    "mesh_create_from_surfaces": "mesh",
    "mesh_surface_update_skin_region": "mesh",
    "mesh_surface_update_index_region": "mesh",
    "mesh_surface_remove": "mesh",
    "shader_create": "material_shader",
    "shader_set_default_texture_parameter": "material_shader",
    "material_create": "material_shader",
    "material_create_from_shader": "material_shader",
    "material_set_shader": "material_shader",
    "canvas_set_modulate": "canvas_viewport",
    "canvas_item_set_use_parent_material": "canvas_item_state",
    "canvas_item_set_instance_shader_parameter": "canvas_item_state",
    "canvas_light_attach_to_canvas": "canvas_viewport",
    "viewport_remove_canvas": "canvas_viewport",
    "viewport_set_global_canvas_transform": "canvas_viewport",
    "viewport_set_canvas_stacking": "canvas_viewport",
    "canvas_set_item_mirroring": "canvas_viewport",
    "canvas_set_item_repeat": "canvas_viewport",
    "canvas_set_parent": "canvas_viewport",
    "texture_set_path": "texture",
    "canvas_item_set_copy_to_backbuffer": "canvas_item_state",
    "canvas_item_set_canvas_group_mode": "canvas_item_state",
    "draw": "frame",
    "multimesh_create": "multimesh",
    "multimesh_allocate_data": "multimesh",
    "multimesh_set_mesh": "multimesh",
    "multimesh_instance_set_transform": "multimesh",
    "multimesh_instance_set_transform_2d": "multimesh",
    "multimesh_instance_set_color": "multimesh",
    "multimesh_instance_set_custom_data": "multimesh",
    "multimesh_set_custom_aabb": "multimesh",
    "multimesh_set_buffer": "multimesh",
    "multimesh_set_buffer_interpolated": "multimesh",
    "multimesh_set_physics_interpolated": "multimesh",
    "multimesh_set_visible_instances": "multimesh",
    "particles_create": "particles",
    "particles_set_mode": "particles",
    "particles_set_emitting": "particles",
    "particles_set_amount": "particles",
    "particles_set_amount_ratio": "particles",
    "particles_set_lifetime": "particles",
    "particles_set_one_shot": "particles",
    "particles_set_pre_process_time": "particles",
    "particles_request_process_time": "particles",
    "particles_set_explosiveness_ratio": "particles",
    "particles_set_randomness_ratio": "particles",
    "particles_set_custom_aabb": "particles",
    "particles_set_speed_scale": "particles",
    "particles_set_use_local_coordinates": "particles",
    "particles_set_process_material": "particles",
    "particles_set_fixed_fps": "particles",
    "particles_set_interpolate": "particles",
    "particles_set_fractional_delta": "particles",
    "particles_set_collision_base_size": "particles",
    "particles_set_seed": "particles",
    "particles_set_transform_align": "particles",
    "particles_set_trails": "particles",
    "particles_set_trail_bind_poses": "particles",
    "particles_request_process": "particles",
    "particles_restart": "particles",
    "particles_set_subemitter": "particles",
    "particles_emit": "particles",
    "particles_set_draw_order": "particles",
    "particles_set_draw_passes": "particles",
    "particles_set_draw_pass_mesh": "particles",
    "particles_set_emission_transform": "particles",
    "particles_set_emitter_velocity": "particles",
    "particles_set_interp_to_end": "particles",
    "canvas_item_set_use_identity_transform": "canvas_item_state",
}


ET_EXEC = 2
ET_DYN = 3
SHT_NOBITS = 8
SHT_RELA = 4
SHF_ALLOC = 0x2
SHF_EXECINSTR = 0x4
R_X86_64_64 = 1
R_X86_64_RELATIVE = 8


class CalibrationError(Exception):
    pass


class Elf:
    platform = "linux-x86_64"

    def __init__(self, path: str) -> None:
        self.path = path
        with open(path, "rb") as handle:
            self.data = handle.read()
        d = self.data
        if d[:4] != b"\x7fELF":
            raise CalibrationError(f"{path}: not an ELF file")
        if d[4] != 2:
            raise CalibrationError(f"{path}: not ELFCLASS64")
        if d[5] != 1:
            raise CalibrationError(f"{path}: not little-endian")
        (self.e_type,) = struct.unpack_from("<H", d, 0x10)
        (e_machine,) = struct.unpack_from("<H", d, 0x12)
        if e_machine != 0x3E:
            raise CalibrationError(f"{path}: not x86-64 (e_machine={e_machine})")
        (self.e_phoff,) = struct.unpack_from("<Q", d, 0x20)
        (self.e_shoff,) = struct.unpack_from("<Q", d, 0x28)
        self.e_phentsize, self.e_phnum = struct.unpack_from("<HH", d, 0x36)
        self.e_shentsize, self.e_shnum, self.e_shstrndx = struct.unpack_from("<HHH", d, 0x3A)
        self.sections = self._read_sections()
        self.segments = self._read_segments()
        self.alloc = [s for s in self.sections if (s["flags"] & SHF_ALLOC) and s["type"] != SHT_NOBITS]
        self.exec_ranges = [
            (s["addr"], s["addr"] + s["size"]) for s in self.alloc if s["flags"] & SHF_EXECINSTR
        ]
        self.relocations = self._read_relocations()
        self.pie = self.e_type == ET_DYN

    def _read_sections(self) -> list[dict]:
        out = []
        for i in range(self.e_shnum):
            off = self.e_shoff + i * self.e_shentsize
            fields = struct.unpack_from("<IIQQQQIIQQ", self.data, off)
            out.append(
                {
                    "name_off": fields[0],
                    "type": fields[1],
                    "flags": fields[2],
                    "addr": fields[3],
                    "offset": fields[4],
                    "size": fields[5],
                    "link": fields[6],
                    "entsize": fields[9],
                }
            )
        strtab = out[self.e_shstrndx]["offset"]
        for s in out:
            start = strtab + s["name_off"]
            end = self.data.index(b"\0", start)
            s["name"] = self.data[start:end].decode("utf-8", "replace")
        return out

    def _read_segments(self) -> list[dict]:
        out = []
        for i in range(self.e_phnum):
            off = self.e_phoff + i * self.e_phentsize
            p_type, p_flags, p_offset, p_vaddr, _p_paddr, p_filesz, p_memsz, _align = struct.unpack_from(
                "<IIQQQQQQ", self.data, off
            )
            out.append(
                {
                    "type": p_type,
                    "flags": p_flags,
                    "offset": p_offset,
                    "vaddr": p_vaddr,
                    "filesz": p_filesz,
                    "memsz": p_memsz,
                }
            )
        return out

    def _read_relocations(self) -> dict[int, int | None]:
        """Map target vaddr -> link-time value, for relocations we can resolve.

        `None` means "relocated against something we cannot resolve statically"
        (an undefined dynamic symbol, e.g. `__cxa_pure_virtual` from libstdc++).
        Non-PIE release templates have no relocations inside vtables at all;
        this exists so the calibrator also behaves on a PIE build.
        """
        out: dict[int, int | None] = {}
        for s in self.sections:
            if s["type"] != SHT_RELA or not s["entsize"]:
                continue
            count = s["size"] // s["entsize"]
            for i in range(count):
                off = s["offset"] + i * s["entsize"]
                r_offset, r_info, r_addend = struct.unpack_from("<QQq", self.data, off)
                r_type = r_info & 0xFFFFFFFF
                if r_type == R_X86_64_RELATIVE:
                    out[r_offset] = r_addend
                elif r_type == R_X86_64_64:
                    out[r_offset] = None
        return out

    def notes(self) -> list[tuple[str, int, bytes]]:
        out = []
        for s in self.sections:
            if s["type"] != 7:  # SHT_NOTE
                continue
            off, end = s["offset"], s["offset"] + s["size"]
            while off + 12 <= end:
                namesz, descsz, ntype = struct.unpack_from("<III", self.data, off)
                name_off = off + 12
                desc_off = name_off + ((namesz + 3) & ~3)
                desc_end = desc_off + descsz
                name = self.data[name_off : name_off + namesz].rstrip(b"\0").decode("ascii", "replace")
                out.append((name, ntype, self.data[desc_off:desc_end]))
                off = desc_end + ((-descsz) & 3)
        return out

    def build_id(self) -> str | None:
        for name, ntype, desc in self.notes():
            if name == "GNU" and ntype == 3:  # NT_GNU_BUILD_ID
                return desc.hex()
        return None

    def vaddr_to_offset(self, vaddr: int) -> int | None:
        for s in self.alloc:
            if s["addr"] <= vaddr < s["addr"] + s["size"]:
                return s["offset"] + (vaddr - s["addr"])
        return None

    def offset_to_vaddr(self, offset: int) -> int | None:
        for s in self.alloc:
            if s["offset"] <= offset < s["offset"] + s["size"]:
                return s["addr"] + (offset - s["offset"])
        return None

    def section_of(self, vaddr: int) -> str | None:
        for s in self.alloc:
            if s["addr"] <= vaddr < s["addr"] + s["size"]:
                return s["name"]
        return None

    def is_code(self, vaddr: int) -> bool:
        return any(lo <= vaddr < hi for lo, hi in self.exec_ranges)

    def read_u64(self, vaddr: int) -> int | None:
        """Link-time value of the pointer-sized word at `vaddr`.

        `None` when a dynamic relocation decides it (unresolvable statically).
        """
        if vaddr in self.relocations:
            return self.relocations[vaddr]
        off = self.vaddr_to_offset(vaddr)
        if off is None or off + 8 > len(self.data):
            return None
        (value,) = struct.unpack_from("<Q", self.data, off)
        return value

    def read_cstring(self, vaddr: int, limit: int = 256) -> str | None:
        off = self.vaddr_to_offset(vaddr)
        if off is None:
            return None
        end = self.data.find(b"\0", off, off + limit)
        if end < 0:
            return None
        raw = self.data[off:end]
        try:
            return raw.decode("ascii")
        except UnicodeDecodeError:
            return None

    def find_bytes(self, needle: bytes) -> list[int]:
        """All vaddrs of `needle` inside allocated sections."""
        out = []
        for match in re.finditer(re.escape(needle), self.data):
            vaddr = self.offset_to_vaddr(match.start())
            if vaddr is not None:
                out.append(vaddr)
        return out

    def find_pointers_to(self, target: int) -> list[int]:
        """All aligned vaddrs whose pointer-sized word equals `target`."""
        out = []
        for vaddr in self.find_bytes(struct.pack("<Q", target)):
            # A RELA addend is metadata, not another pointer in the image.
            # Small PIE fixtures can otherwise make the addend look like RTTI.
            section = next((s for s in self.alloc if s["addr"] <= vaddr < s["addr"] + s["size"]), None)
            if vaddr % 8 == 0 and (section is None or section.get("type") != SHT_RELA):
                out.append(vaddr)
        for addr, value in self.relocations.items():
            if value == target and addr % 8 == 0 and addr not in out:
                out.append(addr)
        return sorted(out)


class Pe(Elf):
    """Read a preferred-base PE32+ image without loading or executing it."""

    platform = "windows-x86_64"

    def __init__(self, path: str) -> None:
        self.path = path
        with open(path, "rb") as handle:
            if os.fstat(handle.fileno()).st_size == 0:
                raise CalibrationError("empty PE file")
            self.data = mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ)
        d = self.data
        self._range(0, 64)
        if d[:2] != b"MZ":
            raise CalibrationError("not an MZ file")
        pe = struct.unpack_from("<I", d, 0x3C)[0]
        self._range(pe, 24)
        if d[pe:pe + 4] != b"PE\0\0":
            raise CalibrationError("invalid PE signature or e_lfanew")
        machine, count, self.time_date_stamp, symbols, symbol_count, opt_size, _ = struct.unpack_from(
            "<HHIIIHH", d, pe + 4
        )
        if machine != 0x8664:
            raise CalibrationError(f"PE Machine {hex(machine)}: not x86-64")
        opt = pe + 24
        self._range(opt, opt_size)
        if opt_size < 112 or struct.unpack_from("<H", d, opt)[0] != 0x20B:
            raise CalibrationError("PE optional-header Magic is not PE32+ (0x20b)")
        directories = struct.unpack_from("<I", d, opt + 108)[0]
        if directories < 7 or opt_size < 112 + 7 * 8:
            raise CalibrationError("PE NumberOfRvaAndSizes must be at least 7")
        self.image_base = struct.unpack_from("<Q", d, opt + 24)[0]
        self.size_of_image, self.size_of_headers = struct.unpack_from("<II", d, opt + 56)
        self.dll_characteristics = struct.unpack_from("<H", d, opt + 70)[0]
        self.dynamic_base = bool(self.dll_characteristics & 0x40)
        self.sections = []
        for i in range(count):
            off = opt + opt_size + i * 40
            self._range(off, 40)
            name, vsize, va, raw_size, raw_off = struct.unpack_from("<8sIIII", d, off)
            flags = struct.unpack_from("<I", d, off + 36)[0]
            name = name.rstrip(b"\0").decode("ascii", "replace")
            if name.startswith("/"):
                if not symbols or not name[1:].isdigit():
                    raise CalibrationError("invalid COFF long section name")
                table = symbols + symbol_count * 18
                self._range(table, 4)
                table_size = struct.unpack_from("<I", d, table)[0]
                self._range(table, table_size)
                start = table + int(name[1:])
                end = d.find(b"\0", start, table + table_size)
                if start < table + 4 or end < 0:
                    raise CalibrationError("invalid COFF string table offset")
                name = d[start:end].decode("ascii", "replace")
            if raw_size:
                self._range(raw_off, raw_size)
            self.sections.append(dict(name=name, addr=self.image_base + va, offset=raw_off,
                                      size=min(vsize, raw_size), virtual_size=vsize,
                                      raw_size=raw_size, flags=flags))
        self.alloc = [s for s in self.sections if s["raw_size"] and s["offset"]
                      and not s["flags"] & 0x02000000]
        self.exec_ranges = [(s["addr"], s["addr"] + s["virtual_size"])
                            for s in self.sections if s["flags"] & 0x20000000]
        self.relocations = {}
        self.dir64 = set()
        reloc_rva, reloc_size = struct.unpack_from("<II", d, opt + 112 + 5 * 8)
        if reloc_size:
            off = self._rva_offset(reloc_rva, reloc_size)
            end = off + reloc_size
            while off < end:
                if off + 8 > end:
                    raise CalibrationError("truncated PE relocation block")
                page, size = struct.unpack_from("<II", d, off)
                if size < 8 or size % 2 or off + size > end:
                    raise CalibrationError("invalid PE relocation block size")
                for entry_off in range(off + 8, off + size, 2):
                    entry = struct.unpack_from("<H", d, entry_off)[0]
                    if entry >> 12 == 10:
                        self.dir64.add(self.image_base + page + (entry & 0xFFF))
                off += size
        self.debug_rva, self.debug_size = struct.unpack_from("<II", d, opt + 112 + 6 * 8)

    def _range(self, off: int, size: int) -> None:
        if off < 0 or size < 0 or off + size > len(self.data):
            raise CalibrationError(f"PE range past EOF: {hex(off)} + {size}")

    def _rva_offset(self, rva: int, size: int) -> int:
        if rva < self.size_of_headers and rva + size <= self.size_of_headers:
            self._range(rva, size)
            return rva
        for s in self.sections:
            delta = rva - (s["addr"] - self.image_base)
            if 0 <= delta and delta + size <= s["raw_size"]:
                return s["offset"] + delta
        raise CalibrationError(f"unmapped PE RVA {hex(rva)} + {size}")

    def find_bytes(self, needle: bytes) -> list[int]:
        out = []
        for s in self.alloc:
            off, end = s["offset"], s["offset"] + s["size"]
            while True:
                off = self.data.find(needle, off, end)
                if off < 0:
                    break
                out.append(s["addr"] + off - s["offset"])
                off += 1
        return out

    def read_u64(self, vaddr: int) -> int | None:
        for section in self.alloc:
            if section["addr"] <= vaddr and vaddr + 8 <= section["addr"] + section["size"]:
                off = section["offset"] + vaddr - section["addr"]
                return struct.unpack_from("<Q", self.data, off)[0]
        return None

    def read_cstring(self, vaddr: int, limit: int = 256) -> str | None:
        for section in self.alloc:
            remaining = section["addr"] + section["size"] - vaddr
            if section["addr"] <= vaddr and remaining > 0:
                return super().read_cstring(vaddr, min(limit, remaining))
        return None

    def build_id(self) -> None:
        return None

    def codeview(self) -> str | None:
        if not self.debug_rva or not self.debug_size:
            return None
        if self.debug_size % 28:
            raise CalibrationError("invalid PE debug directory size")
        off = self._rva_offset(self.debug_rva, self.debug_size)
        found = []
        for entry in range(off, off + self.debug_size, 28):
            kind, size, _rva, raw = struct.unpack_from("<IIII", self.data, entry + 12)
            if kind != 2:
                continue
            self._range(raw, size)
            if self.data[raw:raw + 4] != b"RSDS":
                continue
            if size < 24:
                raise CalibrationError("truncated RSDS entry")
            guid = self.data[raw + 4:raw + 20].hex()
            age = struct.unpack_from("<I", self.data, raw + 20)[0]
            found.append((f"{guid}:{age}", self.data[raw:raw + size]))
        if len({payload for _, payload in found}) > 1:
            raise CalibrationError("conflicting RSDS entries")
        return found[0][0] if found else None

    def image_sha256(self) -> tuple[str, int]:
        self._range(0, self.size_of_headers)
        if not self.exec_ranges or not any(s["name"] == ".rdata" for s in self.sections):
            raise CalibrationError("PE image hash requires executable sections and .rdata")
        ranges = [(0, self.size_of_headers)] + [
            (s["offset"], s["raw_size"]) for s in self.sections
            if s["flags"] & 0x20000000 or s["name"] == ".rdata"
        ]
        digest = hashlib.sha256()
        for off, size in ranges:
            self._range(off, size)
            digest.update(memoryview(self.data)[off:off + size])
        return digest.hexdigest(), sum(size for _, size in ranges)


def open_image(path: str) -> Elf | Pe:
    with open(path, "rb") as handle:
        magic = handle.read(4)
    if magic == b"\x7fELF":
        return Elf(path)
    if magic[:2] == b"MZ":
        return Pe(path)
    raise CalibrationError(f"{path}: not an ELF or PE file")


def pe_identity(image: Pe) -> dict:
    digest, size = image.image_sha256()
    return {
        "sha256": sha256_file(image.path),
        "image_sha256": digest,
        "image_hashed_bytes": size,
        "codeview_id": image.codeview(),
        "time_date_stamp": image.time_date_stamp,
        "size_of_image": image.size_of_image,
        "image_base": hex(image.image_base),
        "dynamic_base": image.dynamic_base,
        "dll_characteristics": image.dll_characteristics,
    }


# ---------------------------------------------------------------------------
# RTTI / vtable discovery
# ---------------------------------------------------------------------------


def mangled_name(class_name: str) -> bytes:
    return f"{len(class_name)}{class_name}".encode("ascii")


def find_typeinfo(elf: Elf, class_name: str) -> tuple[int, int]:
    """Return (typeinfo_name_vaddr, typeinfo_vaddr) for a top-level class."""
    needle = mangled_name(class_name) + b"\0"
    candidates = []
    for vaddr in elf.find_bytes(needle):
        off = elf.vaddr_to_offset(vaddr)
        assert off is not None
        if off > 0 and elf.data[off - 1 : off] != b"\0":
            continue  # tail of a longer mangled name
        candidates.append(vaddr)
    if not candidates:
        if isinstance(elf, Pe) and elf.find_bytes(b".?AVRenderingServer@@"):
            raise CalibrationError("MSVC-ABI RTTI (.?AVRenderingServer@@): the MSVC C++ ABI is not supported")
        raise CalibrationError(f"typeinfo name {needle!r} not found")
    typeinfos = []
    for name_vaddr in candidates:
        for ref in elf.find_pointers_to(name_vaddr):
            # std::type_info layout: { vptr, name }, so the object starts 8 bytes
            # before the name pointer.
            typeinfos.append((name_vaddr, ref - 8))
    if len(typeinfos) != 1:
        raise CalibrationError(
            f"expected exactly one typeinfo for {class_name}, got {[hex(t[1]) for t in typeinfos]}"
        )
    return typeinfos[0]


def looks_like_typeinfo(elf: Elf, vaddr: int) -> bool:
    """Cheap test: a type_info object's second word points at a mangled name."""
    name_ptr = elf.read_u64(vaddr + 8)
    if not name_ptr:
        return False
    text = elf.read_cstring(name_ptr, 128)
    return bool(text) and bool(re.match(r"^(\d+[A-Za-z_]|N\d|P[A-Za-z0-9])", text))


def find_vtable(elf: Elf, typeinfo_vaddr: int, class_name: str) -> dict:
    """Locate the primary vtable for a single-inheritance class."""
    found = []
    for ref in elf.find_pointers_to(typeinfo_vaddr):
        offset_to_top = elf.read_u64(ref - 8)
        if offset_to_top != 0:
            continue  # typeinfo base pointer, or a secondary vtable
        found.append(ref)
    if len(found) != 1:
        raise CalibrationError(
            f"expected exactly one primary vtable for {class_name}, got {[hex(f) for f in found]}"
        )
    typeinfo_ref = found[0]
    vtable_vaddr = typeinfo_ref - 8
    address_point = typeinfo_ref + 8

    slots: list[int | None] = []
    index = 0
    while True:
        vaddr = address_point + 8 * index
        if elf.vaddr_to_offset(vaddr) is None:
            break
        value = elf.read_u64(vaddr)
        if value is None:
            # A following RTTI object may itself start with an unresolved vptr.
            if looks_like_typeinfo(elf, vaddr):
                break
            # A dynamic relocation decides this slot (e.g. __cxa_pure_virtual in
            # a PIE build). Treat it as a placeholder, flagged as unresolved.
            slots.append(None)
            index += 1
            continue
        if value == 0:
            # A zero can be a pure-virtual placeholder or the offset-to-top of
            # the next vtable in the section. Peek at the following word.
            following = elf.read_u64(vaddr + 8)
            if following and looks_like_typeinfo(elf, following):
                break
            slots.append(0)
            index += 1
            continue
        if not elf.is_code(value):
            break
        slots.append(value)
        index += 1
        if index > 4096:
            raise CalibrationError(f"{class_name}: vtable walk did not terminate")
    if not slots:
        raise CalibrationError(f"{class_name}: empty vtable")
    return {
        "class_name": class_name,
        "vtable_vaddr": vtable_vaddr,
        "address_point": address_point,
        "slots": slots,
    }


# ---------------------------------------------------------------------------
# Header parsing
# ---------------------------------------------------------------------------


def parse_virtuals(header_path: str, class_name: str, defines: set[str]) -> list[dict]:
    """Ordered list of virtual members declared directly by `class_name`.

    Itanium ABI vtable order is declaration order. Entries marked `override`
    reuse a base slot and are reported with `override: True`; so does a virtual
    destructor whose base destructor is already virtual (`Object` has one).
    """
    with open(header_path, encoding="utf-8") as handle:
        lines = handle.read().split("\n")

    opener = re.compile(r"^class\s+" + re.escape(class_name) + r"\b.*\{")
    try:
        start = next(i for i, line in enumerate(lines) if opener.match(line.strip()))
    except StopIteration as exc:
        raise CalibrationError(f"{header_path}: class {class_name} not found") from exc

    cond: list[bool | None] = []
    depth = 0
    entered = False
    out: list[dict] = []
    for i in range(start, len(lines)):
        raw = lines[i]
        text = raw.strip()
        directive = re.match(r"#\s*(ifdef|ifndef|if|else|elif|endif)\b\s*(.*)", text)
        if directive:
            keyword, rest = directive.group(1), directive.group(2)
            if keyword == "ifdef":
                cond.append(rest.split()[0] in defines)
            elif keyword == "ifndef":
                cond.append(rest.split()[0] not in defines)
            elif keyword == "if":
                cond.append(None)
            elif keyword == "else":
                cond[-1] = (not cond[-1]) if cond[-1] is not None else None
            elif keyword == "elif":
                cond[-1] = None
            else:
                if not cond:
                    raise CalibrationError(f"{header_path}:{i + 1}: unbalanced #endif")
                cond.pop()
            continue
        if any(value is None for value in cond):
            raise CalibrationError(
                f"{header_path}:{i + 1}: unsupported preprocessor condition in {class_name}"
            )
        if not all(cond):
            continue
        if not entered:
            entered = True
            depth = raw.count("{") - raw.count("}")
            continue
        depth_before = depth
        depth += raw.count("{") - raw.count("}")
        if depth <= 0:
            break
        if depth_before != 1 or not text.startswith("virtual"):
            continue
        if "(" not in text:
            raise CalibrationError(f"{header_path}:{i + 1}: unparsed virtual declaration: {text}")
        head = text.split("(")[0]
        is_dtor = "~" in head
        name = "~" + class_name if is_dtor else re.findall(r"[A-Za-z_][A-Za-z0-9_]*", head)[-1]
        out.append(
            {
                "name": name,
                "pure": bool(re.search(r"=\s*0\s*;\s*(//.*)?$", text)),
                "override": " override" in text,
                "destructor": is_dtor,
                "line": i + 1,
            }
        )
    if cond:
        raise CalibrationError(f"{header_path}: unterminated preprocessor condition")
    if not out:
        raise CalibrationError(f"{header_path}: no virtual declarations found in {class_name}")
    return out


# ---------------------------------------------------------------------------
# Record assembly
# ---------------------------------------------------------------------------


DEFAULT_VERSION_NAME = "Godot Engine"


def engine_version_string(elf: Elf, version_name: str = DEFAULT_VERSION_NAME, *, allow_missing: bool = False) -> str:
    """The exact `GDExtensionGodotVersion2::string` literal (VERSION_FULL_NAME).

    That literal is `GODOT_VERSION_NAME " v" GODOT_VERSION_FULL_BUILD`; an engine
    fork can rebrand `GODOT_VERSION_NAME`, so the name is a parameter.
    """
    candidates = set()
    pattern = re.escape(version_name.encode("ascii")) + rb" v[0-9][ -~]{0,80}?\x00"
    ranges = [(s["offset"], s["offset"] + s["size"]) for s in elf.alloc] if isinstance(elf, Pe) else [(0, len(elf.data))]
    regex = re.compile(pattern)
    for start, end in ranges:
        for match in regex.finditer(elf.data, start, end):
            if elf.offset_to_vaddr(match.start()) is None:
                continue
            candidates.add(match.group()[:-1].decode("ascii"))
    if not candidates and allow_missing:
        return ""
    if len(candidates) != 1:
        raise CalibrationError(f"expected one engine version string, got {sorted(candidates)}")
    return candidates.pop()


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def discover_placeholder(elf, slots, concrete, abstract_class):
    unimplemented = {value for value in slots if value is None or not elf.is_code(value)}
    if unimplemented:
        if len(unimplemented) > 1:
            raise CalibrationError(
                f"{abstract_class}: pure-virtual slots are not uniform: {sorted(unimplemented, key=str)}"
            )
        return "null", None, [value is not None and elf.is_code(value) for value in slots]
    concrete_values = set(concrete)
    counts = Counter(v for v in slots if v not in concrete_values)
    if not counts:
        raise CalibrationError("no pure-virtual placeholder")
    top = counts.most_common(2)
    if len(top) > 1 and top[0][1] == top[1][1]:
        raise CalibrationError(f"placeholder ambiguous: {hex(top[0][0])} and {hex(top[1][0])} both occur {top[0][1]} times")
    placeholder = top[0][0]
    return "code", placeholder, [value != placeholder for value in slots]


def wanted_indices(new_slots: list[dict], prefix: int, abstract_class: str) -> dict[str, int]:
    """Resolve all wanted slots from the header, including omitted hook families."""
    index_by_name = {}
    for i, virtual in enumerate(new_slots):
        name = virtual["name"]
        if name in index_by_name:
            raise CalibrationError(
                f"{abstract_class}::{name} is overloaded; slot lookup by name is ambiguous"
            )
        index_by_name[name] = prefix + i
    wanted = {}
    for key, accepted in WANTED_SLOTS:
        match = next((name for name in accepted if name in index_by_name), None)
        if match is None:
            raise CalibrationError(
                f"{abstract_class}::{'/'.join(accepted)} not declared in the header"
            )
        wanted[key] = index_by_name[match]
    return wanted


def derive(
    elf: Elf,
    header_path: str,
    abstract_class: str,
    concrete_class: str,
    defines: set[str],
) -> dict:
    _name_vaddr, abstract_ti = find_typeinfo(elf, abstract_class)
    _name_vaddr2, concrete_ti = find_typeinfo(elf, concrete_class)
    abstract = find_vtable(elf, abstract_ti, abstract_class)
    concrete = find_vtable(elf, concrete_ti, concrete_class)

    slots = abstract["slots"]
    slot_count = len(slots)
    if len(concrete["slots"]) != slot_count:
        raise CalibrationError(
            f"{concrete_class} vtable has {len(concrete['slots'])} slots, "
            f"{abstract_class} has {slot_count}: the concrete class adds slots, "
            "which this calibrator does not model"
        )
    if isinstance(elf, Pe):
        for table in (abstract, concrete):
            for i, value in enumerate(table["slots"]):
                word = table["address_point"] + i * 8
                if value and word not in elf.dir64:
                    raise CalibrationError(f"slot word at {hex(word)} is not relocated: not a pointer")
    kind, placeholder, implemented = discover_placeholder(elf, slots, concrete["slots"], abstract_class)
    concrete_pure = [i for i, value in enumerate(concrete["slots"]) if value is None or not elf.is_code(value)]
    if concrete_pure:
        raise CalibrationError(f"{concrete_class}: unexpected non-code slots at {concrete_pure}")

    virtuals = parse_virtuals(header_path, abstract_class, defines)
    new_slots = [v for v in virtuals if not v["override"] and not v["destructor"]]
    expected_pure = [v["pure"] for v in new_slots]
    if len(new_slots) > slot_count:
        raise CalibrationError(
            f"header declares {len(new_slots)} new virtuals but the vtable has {slot_count} slots"
        )

    def matches(prefix: int) -> bool:
        return all(implemented[prefix + i] == (not pure) for i, pure in enumerate(expected_pure))

    prefix = slot_count - len(new_slots)
    viable = [p for p in range(0, slot_count - len(new_slots) + 1) if matches(p)]
    if prefix not in viable:
        mismatches = [
            (i, new_slots[i]["name"], "pure" if pure else "implemented")
            for i, pure in enumerate(expected_pure)
            if implemented[prefix + i] == pure
        ]
        raise CalibrationError(
            f"header/binary mask mismatch at prefix {prefix}: "
            f"{len(mismatches)} of {len(expected_pure)} slots disagree, first few {mismatches[:8]}"
        )
    if viable != [prefix]:
        raise CalibrationError(
            f"prefix is ambiguous: mask also matches at {[p for p in viable if p != prefix]}"
        )

    anchors = {
        v["name"]: prefix + i for i, v in enumerate(new_slots) if not v["pure"]
    }
    wanted = wanted_indices(new_slots, prefix, abstract_class)
    for key, index in wanted.items():
        # The library replaces every recorded slot (or, for the probe, calls it
        # through the concrete table), and re-checks exactly this at runtime:
        # pure in the abstract vtable, implemented in the concrete one. Do not
        # write a record the library would refuse.
        if implemented[index]:
            raise CalibrationError(
                f"{abstract_class}::{key} at slot {index} is implemented in the abstract "
                "vtable; the library only hooks pure-virtual slots"
            )
        concrete_value = concrete["slots"][index]
        if concrete_value is None or not elf.is_code(concrete_value) or (kind == "code" and concrete_value == placeholder):
            raise CalibrationError(
                f"{concrete_class}::{key} at slot {index} is not implemented in the concrete vtable"
            )
    return {
        "abstract": abstract,
        "concrete": concrete,
        "prefix": prefix,
        "slot_count": slot_count,
        "anchors": anchors,
        "slots": wanted,
        "new_slot_count": len(new_slots),
        "placeholder_kind": kind,
        "pure_placeholder": placeholder,
        "pure_count": sum(not v for v in implemented),
        "families": FAMILIES,
    }


def build_record(args: argparse.Namespace, census: bool = True) -> tuple[dict, dict]:
    elf = open_image(args.binary)
    derived = derive(elf, args.header, args.abstract_class, args.concrete_class, set(args.define))
    flavor = args.flavor
    if flavor == "auto":
        flavor = "template_debug" if "debug" in os.path.basename(args.binary) else "template_release"
    record = {
        "schema": SCHEMA,
        "engine": {
            "version_string": engine_version_string(elf, args.version_name),
            "build_id": elf.build_id(),
            "sha256": sha256_file(args.binary),
            "platform": elf.platform,
            "flavor": flavor,
            "pie": getattr(elf, "pie", False),
        },
        "rendering_server": {
            "abstract_vtable_vaddr": hex(derived["abstract"]["vtable_vaddr"]),
            "concrete_class": args.concrete_class,
            "concrete_vtable_vaddr": hex(derived["concrete"]["vtable_vaddr"]),
            "object_prefix": derived["prefix"],
            "slot_count": derived["slot_count"],
            "anchors_total": len(derived["anchors"]),
            "anchors_matched": len(derived["anchors"]),
        },
        "slots": derived["slots"],
        "anchors": derived["anchors"],
        "calibrator": {
            "version": CALIBRATOR_VERSION,
            "header_sha256": sha256_file(args.header),
        },
    }
    if isinstance(elf, Pe):
        record["engine"] = {
            "version_string": record["engine"]["version_string"],
            "sha256": record["engine"]["sha256"],
            "image_sha256": elf.image_sha256()[0],
            "codeview_id": elf.codeview(),
            "time_date_stamp": elf.time_date_stamp,
            "size_of_image": elf.size_of_image,
            "image_base": hex(elf.image_base),
            "dynamic_base": elf.dynamic_base,
            "platform": elf.platform,
            "flavor": flavor,
        }
    if isinstance(elf, Pe) or derived["placeholder_kind"] == "code":
        record["rendering_server"].update(
            placeholder_kind=derived["placeholder_kind"],
            pure_placeholder=hex(derived["pure_placeholder"]) if derived["pure_placeholder"] is not None else None,
        )
    if census:
        try:
            result = call_census.run(elf, derived)
        except call_census.CensusError as exc:
            raise CalibrationError(str(exc)) from exc
        entries = result["devirtualized_slots"]
        required = [entry for entry in entries if entry["family"] == "required"]
        if required:
            details = "; ".join(
                f"{e['key']}@{e['slot']} ({e['direct_calls']} direct call{'s' if e['direct_calls'] != 1 else ''} at {e['sites'][0]})"
                for e in required
            )
            raise CalibrationError(f"devirtualized required slot(s): {details}; the capture would miss calls it must see")
        dropped = result["dropped_families"]
        record["slots"] = {key: index for key, index in record["slots"].items()
                           if FAMILIES[key] not in dropped}
        if isinstance(elf, Pe) or entries:
            calibrator = record.pop("calibrator")
            record["devirtualized_slots"] = entries
            record["dropped_families"] = dropped
            record["calibrator"] = calibrator
    return record, derived


def report_mask(args: argparse.Namespace) -> int:
    """Print the raw vtable facts without deriving anything from a header.

    Used for a binary whose matching `rendering_server.h` is not available
    locally: the implemented-slot mask is a measurement, the Object prefix is
    not derivable from it alone.
    """
    elf = open_image(args.binary)
    _n1, abstract_ti = find_typeinfo(elf, args.abstract_class)
    _n2, concrete_ti = find_typeinfo(elf, args.concrete_class)
    abstract = find_vtable(elf, abstract_ti, args.abstract_class)
    concrete = find_vtable(elf, concrete_ti, args.concrete_class)
    kind, placeholder, mask = discover_placeholder(elf, abstract["slots"], concrete["slots"], args.abstract_class)
    implemented = [i for i, value in enumerate(mask) if value]
    print(f"binary: {args.binary}")
    print(f"version: {engine_version_string(elf, args.version_name)}")
    print(f"sha256: {sha256_file(args.binary)}")
    if isinstance(elf, Pe):
        print(f"codeview: {elf.codeview()}")
    else:
        print(f"pie: {elf.pie}  build_id: {elf.build_id()}")
    print(f"placeholder {kind} {hex(placeholder) if placeholder is not None else 'null'}")
    print(f"{args.abstract_class} vtable: {hex(abstract['vtable_vaddr'])} slots {len(abstract['slots'])}")
    print(f"{args.concrete_class} vtable: {hex(concrete['vtable_vaddr'])} slots {len(concrete['slots'])}")
    print(f"implemented slots ({len(implemented)}): {implemented}")
    print(f"implemented-slot gaps: {[b - a for a, b in zip(implemented, implemented[1:])]}")
    return 0


def slot_mask_checks(record: dict, image: Elf | Pe, exclude_placeholder: bool = True) -> list[tuple]:
    """The runtime mask predicates at file-image bias zero."""
    checks = []

    def check(name, ok, detail):
        checks.append((name, bool(ok), detail))
        return ok

    rs = record["rendering_server"]
    abstract = int(rs["abstract_vtable_vaddr"], 16) + 16
    concrete_table = int(rs["concrete_vtable_vaddr"], 16)
    concrete = concrete_table + 16
    count, prefix = rs["slot_count"], rs["object_prefix"]
    kind = rs.get("placeholder_kind", "null")
    placeholder = rs.get("pure_placeholder")
    placeholder = int(placeholder, 16) if placeholder is not None else None
    check("singleton_available", True, "offline")
    ti = image.read_u64(concrete_table + 8)
    name = image.read_u64(ti + 8) if ti else None
    vptr_ok = (
        image.read_u64(concrete_table) == 0 and name
        and image.read_cstring(name) == mangled_name(rs["concrete_class"]).decode()
    )
    if not check("concrete_vptr", vptr_ok, f"live {hex(concrete)} expected {hex(concrete)}"):
        return checks
    indices = list(record["slots"].values()) + list(record["anchors"].values())
    indices_ok = all(isinstance(i, int) and 0 <= i < count for i in indices) and 0 < prefix < count
    if not check("slot_indices_in_range", indices_ok, f"slot_count {count} object_prefix {prefix}"):
        return checks
    matched, detail = 0, ""
    for key, index in record["anchors"].items():
        value = image.read_u64(abstract + index * 8)
        if value and image.is_code(value) and not (exclude_placeholder and kind == "code" and value == placeholder):
            matched += 1
        elif not detail:
            detail = f" first mismatch {key}@{index} = {hex(value or 0)}"
    check("anchors_implemented", matched == len(record["anchors"]) == rs["anchors_total"], f"{matched}/{len(record['anchors'])}{detail}")
    known, pure, uniform, concrete_ok, detail = False, None, True, True, ""
    for key, index in record["slots"].items():
        value = image.read_u64(abstract + index * 8)
        if not known:
            known, pure = True, value
        elif value != pure:
            uniform = False
            if not detail:
                detail = f"{key}@{index} = {hex(value or 0)} != {hex(pure or 0)}"
        impl = image.read_u64(concrete + index * 8)
        if not impl or not image.is_code(impl):
            concrete_ok = False
            if not detail:
                detail = f"{key}@{index} concrete {hex(impl or 0)}"
    concrete_values = [image.read_u64(concrete + i * 8) for i in range(count)]
    if kind == "code":
        distinct = known and pure == placeholder and pure not in concrete_values
    else:
        distinct = known and not image.is_code(pure or 0)
    check("hooked_slots_pure_in_abstract", uniform and distinct, f"placeholder {hex(pure or 0)}" + (" " + detail if detail else ""))
    check("hooked_slots_implemented_in_concrete", concrete_ok, detail)
    last = image.read_u64(concrete + (count - 1) * 8)
    check("slot_count_tail", last and image.is_code(last), f"last slot {hex(last or 0)}")
    return checks



def devirtualized_check(record: dict, image: Elf | Pe, header: str | None,
                        abstract_class: str = "RenderingServer", defines: set[str] | None = None) -> tuple[bool, str]:
    if not header:
        raise CalibrationError("--header is required for the devirtualized check")
    rs = record["rendering_server"]
    _, abstract_ti = find_typeinfo(image, abstract_class)
    _, concrete_ti = find_typeinfo(image, rs["concrete_class"])
    abstract = find_vtable(image, abstract_ti, abstract_class)
    concrete = find_vtable(image, concrete_ti, rs["concrete_class"])
    kind, placeholder, implemented = discover_placeholder(image, abstract["slots"], concrete["slots"], abstract_class)
    listed = record.get("devirtualized_slots", [])
    virtuals = parse_virtuals(header, abstract_class, defines or set())
    new_slots = [v for v in virtuals if not v["override"] and not v["destructor"]]
    indices = wanted_indices(new_slots, rs["object_prefix"], abstract_class)
    if any(i < 0 or i >= len(concrete["slots"]) for i in indices.values()):
        raise CalibrationError("header slot indices exceed the concrete vtable")
    if any(indices.get(key) != index for key, index in record["slots"].items()):
        return False, "record slot indices differ from header"
    for entry in listed:
        key = entry["key"]
        if key not in indices or entry["slot"] != indices[key]:
            return False, f"invalid listed slot {key}@{entry['slot']}"
    derived = dict(abstract=abstract, concrete=concrete, prefix=rs["object_prefix"],
                   slot_count=len(concrete["slots"]), slots=indices, families=FAMILIES,
                   placeholder_kind=kind, pure_placeholder=placeholder,
                   pure_count=sum(not v for v in implemented))
    try:
        result = call_census.run(image, derived)
    except call_census.CensusError as exc:
        raise CalibrationError(str(exc)) from exc
    actual = result["devirtualized_slots"]
    dropped = record.get("dropped_families", [])
    for entry in actual + listed:
        key = entry["key"]
        if FAMILIES[key] == "required":
            return False, f"{key}@{entry['slot']}: required hook devirtualized"
        if key in record["slots"]:
            return False, f"{key}@{entry['slot']}: devirtualized hook retained in slots"
        family = FAMILIES[key]
        if family not in dropped or any(FAMILIES.get(k) == family for k in record["slots"]):
            return False, f"{key}@{entry['slot']}: family {family} was not dropped completely"
    if any(e.get("family") != FAMILIES[e["key"]] for e in listed):
        return False, "listed family differs from slot family"
    if len({e["key"] for e in listed}) != len(listed) or {e["key"] for e in listed} != {e["key"] for e in actual}:
        return False, "listed keys differ from census result"
    if set(dropped) != {e["family"] for e in listed}:
        return False, "dropped families differ from listed families"
    return True, "wanted slots clean; dropped families " + (", ".join(dropped) or "none")


def verify_record(record: dict, image: Elf | Pe, version_name: str | None = None,
                  header: str | None = None, abstract_class: str = "RenderingServer",
                  defines: set[str] | None = None) -> int:
    if record.get("dropped_families") and not header:
        raise CalibrationError("--header is required when the record has dropped_families")
    checks = []

    def check(name, ok, detail):
        checks.append((name, bool(ok), detail))

    if record.get("schema") != SCHEMA:
        raise CalibrationError(f"unsupported calibration schema: {record.get('schema')}")
    engine = record["engine"]
    pe = isinstance(image, Pe)
    name = "image_sha256" if pe else "exe_sha256"
    live = image.image_sha256()[0] if pe else sha256_file(image.path)
    expected = engine.get(name if pe else "sha256", "")
    check(name, bool(live) and live == expected, f"live {live} record {expected}")
    version = engine_version_string(image, version_name or engine["version_string"].split(" v", 1)[0],
                                    allow_missing=True)
    check("version_string", bool(version) and version == engine["version_string"], f"live '{version}' record '{engine['version_string']}'")
    live_id = image.codeview() if pe else image.build_id()
    expected_id = engine.get("codeview_id" if pe else "build_id")
    if expected_id is not None:
        id_ok = (live_id or "") == expected_id
        detail = f"live {live_id or ''} record {expected_id}"
    else:
        id_ok = live_id is None
        detail = "absent in both" if id_ok else "live binary has one, record does not"
    if pe:
        id_ok = id_ok and image.time_date_stamp == engine.get("time_date_stamp") and image.size_of_image == engine.get("size_of_image")
        detail += f" time_date_stamp {image.time_date_stamp} record {engine.get('time_date_stamp')} size_of_image {image.size_of_image} record {engine.get('size_of_image')}"
    check("codeview_id" if pe else "build_id", id_ok, detail)
    if pe:
        check("aslr_and_bias", image.dynamic_base == engine.get("dynamic_base") and hex(image.image_base) == engine.get("image_base"),
              f"live dynamic_base={str(image.dynamic_base).lower()} bias 0x0 image_base {hex(image.image_base)} record dynamic_base={str(engine.get('dynamic_base')).lower()} image_base {engine.get('image_base')}")
    else:
        check("pie_and_bias", image.pie == engine.get("pie", False), f"live pie={str(image.pie).lower()} bias 0x0 record pie={str(engine.get('pie', False)).lower()}")
    check("platform", engine["platform"] == image.platform, engine["platform"])
    failure = "fingerprint-mismatch" if not all(ok for _, ok, _ in checks) else None
    if failure is None:
        mask = slot_mask_checks(record, image)
        checks.extend(mask)
        if not all(ok for _, ok, _ in mask):
            failure = "slot-mask-mismatch"
        else:
            check("behaviour_probe", True, "skipped: offline")
            ok, detail = devirtualized_check(record, image, header, abstract_class, defines)
            check("devirtualized", ok, detail)
            if not ok:
                failure = "devirtualized"
    for name, ok, detail in checks:
        print(f"check {name} {'ok' if ok else 'FAIL'} {detail}")
    if failure:
        print(f"refused: {failure}")
        return 3
    print(f"verified: {len(checks)}/{len(checks)}")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--binary", help="Godot ELF or PE binary to calibrate against")
    parser.add_argument("--pe-identity", metavar="BINARY", help="print the PE file identity")
    parser.add_argument("--verify-record", metavar="RECORD", help="verify a record offline")
    parser.add_argument("--header", help="matching RenderingServer header (required for calibration and the devirtualized check)")
    parser.add_argument(
        "--mask-only",
        action="store_true",
        help="report the measured vtable mask and stop (no header, no record)",
    )
    parser.add_argument("--out", help="write the record here (default: stdout)")
    parser.add_argument("--abstract-class", default="RenderingServer")
    parser.add_argument("--concrete-class", default="RenderingServerDefault")
    parser.add_argument(
        "--define",
        action="append",
        default=[],
        help="preprocessor define active in the build (default: the release set, none)",
    )
    parser.add_argument(
        "--version-name",
        default=None,
        help=f"the engine's GODOT_VERSION_NAME, which a fork may rebrand (default: {DEFAULT_VERSION_NAME}; verification uses the record's brand)",
    )
    parser.add_argument(
        "--flavor",
        default="auto",
        choices=["auto", "template_release", "template_debug"],
        help="engine flavor recorded in the record",
    )
    args = parser.parse_args(argv)

    try:
        if args.pe_identity:
            image = open_image(args.pe_identity)
            if not isinstance(image, Pe):
                raise CalibrationError("--pe-identity requires a PE image")
            print(json.dumps(pe_identity(image), sort_keys=True))
            return 0
        if not args.binary:
            parser.error("--binary is required")
        if args.verify_record:
            with open(args.verify_record, encoding="utf-8") as handle:
                return verify_record(json.load(handle), open_image(args.binary), version_name=args.version_name,
                                     header=args.header,
                                     abstract_class=args.abstract_class, defines=set(args.define))
        args.version_name = args.version_name or DEFAULT_VERSION_NAME
        if args.mask_only:
            return report_mask(args)
        if not args.header:
            parser.error("--header is required unless --mask-only is given")
        record, derived = build_record(args)
    except CalibrationError as exc:
        print(f"calibrate: {exc}", file=sys.stderr)
        return 2

    text = json.dumps(record, indent=2) + "\n"
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(text)
    else:
        sys.stdout.write(text)

    rs = record["rendering_server"]
    print(
        f"calibrate: {os.path.basename(args.binary)} {record['engine']['version_string']}\n"
        f"  abstract vtable {rs['abstract_vtable_vaddr']} concrete {rs['concrete_vtable_vaddr']}\n"
        f"  slots {rs['slot_count']} = object prefix {rs['object_prefix']} + "
        f"{derived['new_slot_count']} RenderingServer virtuals\n"
        f"  anchors {rs['anchors_matched']}/{rs['anchors_total']} matched, "
        f"placeholder {derived['placeholder_kind']} "
        f"{hex(derived['pure_placeholder']) if derived['pure_placeholder'] is not None else 'null'} "
        f"({derived['pure_count']} pure slots)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
