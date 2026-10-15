// Gate 6 group G6z (protocol/gate6-design.md "Q8. Supported-feature manifest"): the hand-maintained
// evidence map behind protocol/features/render-stream-6.json. scripts/make-features.ts is the
// generator; this file is its editorial content -- one FeatureEntry per capability, each citing a
// committed fixture, leg and check (for "supported"), or an owner (for every other status).
//
// Four wire-derived kinds (op, item_state, canvas_state, resource) are cross-checked by
// make-features.ts against capture/src/rs_publish.cpp's gate2_features() V6 lists: every id that
// function emits must appear here with a matching status, and every entry of those kinds here
// must name a real id from one of those lists. Every other entry (viewport, material, text,
// control, delivery, payload) has no such external list to check against; its correctness rests
// on gate6-design.md's Decisions/Q8/Deferred sections, cited in `notes`.
//
// Evidence entries naming `gate: "gate6"` are re-verified live by lib/gate6z-checks.ts's
// `manifest-evidence` (the check id must appear with status "pass" in the same run). Evidence
// naming an earlier gate is quoted from that gate's own README result section (Q8: "earlier
// gates' evidence is quoted from their summaries' run directories") and is not re-run here.

export type FeatureKind =
  | "op"
  | "item_state"
  | "canvas_state"
  | "resource"
  | "payload"
  | "material"
  | "viewport"
  | "delivery"
  | "text"
  | "control";

export type FeatureStatus =
  | "supported"
  | "typed-unsupported"
  | "unobserved"
  | "declared-unverified";

export type FeatureExactness = "exact" | "delta1" | "repeat-budget" | null;

export interface FeatureEvidenceRef {
  gate: string;
  fixture: string;
  leg: string;
  check: string;
}

export interface FeatureEntry {
  id: string;
  kind: FeatureKind;
  name: string;
  status: FeatureStatus;
  reason: string | null;
  exactness: FeatureExactness;
  evidence: FeatureEvidenceRef[];
  owner: string | null;
  notes: string | null;
}

function ev(
  gate: string,
  fixture: string,
  leg: string,
  check: string,
): FeatureEvidenceRef {
  return { gate, fixture, leg, check };
}

/** gate6-scene's own census check: proves the op was captured, carried on the wire and replayed
 * (G6a "Checks": scene-census against the hook log, receiver-vs-reference whole-frame budget 0). */
const SCENE_CENSUS = ev(
  "gate6",
  "gate6-scene",
  "capture-scene",
  "scene-census",
);
const SCENE_REPLAY = ev(
  "gate6",
  "gate6-scene",
  "receiver-scene",
  "receiver-vs-reference",
);
const REFUSED = ev(
  "gate6",
  "gate6-scene",
  "capture-refused",
  "leg-class-capture-refused",
);

// -------------------------------------------------------------------------------------------
// kind "op": capture/src/rs_publish.cpp gate2_features(headless_host=true, V6), lines ~229-377.
// -------------------------------------------------------------------------------------------

const OPS_SUPPORTED: readonly string[] = [
  "add_circle",
  "add_clip_ignore",
  "add_line",
  "add_mesh",
  "add_msdf_texture_rect_region",
  "add_multiline",
  "add_nine_patch",
  "add_polygon",
  "add_polyline",
  "add_primitive",
  "add_rect",
  "add_set_transform",
  "add_texture_rect",
  "add_texture_rect_region",
  "add_triangle_array",
];

function supportedOp(id: string): FeatureEntry {
  return {
    id,
    kind: "op",
    name: id,
    status: "supported",
    reason: null,
    exactness: "exact",
    evidence: [SCENE_CENSUS, SCENE_REPLAY],
    owner: null,
    notes: null,
  };
}

const OPS_TYPED_UNSUPPORTED: readonly {
  id: string;
  reason: string;
  owner: string;
  evidence?: FeatureEvidenceRef[];
}[] = [
  {
    id: "canvas_item_add_animation_slice",
    reason: "unsupported-op",
    owner:
      "post-gate-6 capabilities: shader TIME / AnimationPlayer slice drawing (gate6-design.md Deferred, unscheduled)",
  },
  {
    id: "canvas_item_add_lcd_texture_rect_region",
    reason: "unsupported-op",
    owner: "unscheduled: LCD subpixel text (gate4-design.md Deferred)",
    evidence: [REFUSED],
  },
  {
    id: "canvas_item_add_multimesh",
    reason: "unsupported-op",
    owner:
      "post-gate-6 capabilities: multimesh (gate6-design.md Deferred, unscheduled)",
    evidence: [REFUSED],
  },
  {
    id: "canvas_item_add_particles",
    reason: "unsupported-op",
    owner:
      "post-gate-6 capabilities: GPU/CPU particles (gate6-design.md Deferred, unscheduled)",
  },
  {
    id: "canvas_item_attach_skeleton",
    reason: "unsupported-state",
    owner:
      "unscheduled: skeletons, skinning, blend shapes (gate5-design.md Deferred)",
  },
  {
    id: "canvas_light_attach_to_canvas",
    reason: "canvas-light",
    owner:
      "post-gate-6 capabilities: Light2D, occluders, light masks, normal/specular maps (gate5_5-design.md Deferred, unscheduled)",
    evidence: [REFUSED],
  },
  {
    id: "canvas_set_item_mirroring",
    reason: "canvas-repeat",
    owner: "gate 8: follow_viewport layers and parallax repeat census",
  },
  {
    id: "canvas_set_item_repeat",
    reason: "canvas-repeat",
    owner: "gate 8: follow_viewport layers and parallax repeat census",
  },
  {
    id: "canvas_set_parent",
    reason: "canvas-follow-viewport",
    owner: "gate 8: follow_viewport layers and parallax repeat census",
    evidence: [REFUSED],
  },
];

const OPS_UNOBSERVED: readonly { id: string; owner: string; notes: string }[] =
  [
    {
      id: "canvas_item_set_canvas_group_mode",
      owner:
        "post-gate-6 capabilities: CanvasGroup / clip-children (unscheduled)",
      notes:
        "hooked slot; no committed gate 6 fixture creates a CanvasGroup item, so the hook never fires.",
    },
    {
      id: "canvas_item_set_copy_to_backbuffer",
      owner: "post-gate-6 capabilities: screen texture (unscheduled)",
      notes:
        "hooked slot; no committed gate 6 fixture reads the backbuffer, so the hook never fires.",
    },
    {
      id: "canvas_item_set_light_mask",
      owner: "post-gate-6 capabilities: Light2D (unscheduled)",
      notes: "hooked slot; no committed gate 6 fixture sets a light mask.",
    },
    {
      id: "canvas_item_set_sort_children_by_y",
      owner: "unscheduled",
      notes: "hooked slot; no committed gate 6 fixture enables y-sort.",
    },
    {
      id: "canvas_item_set_visibility_notifier",
      owner: "unscheduled",
      notes:
        "hooked slot; no committed gate 6 fixture uses a VisibilityNotifier2D.",
    },
    {
      id: "canvas_set_disable_scale",
      owner: "unscheduled",
      notes:
        'calibrator 9 hooks its five sibling canvas setters but leaves slot 440 unhooked (render-stream-6.md "Features", gate6-design.md Q2).',
    },
    {
      id: "canvas_texture_set_shading_parameters",
      owner:
        "gate 8: CanvasTexture census (memory canvas-texture-headless-rid)",
      notes:
        "hooked slot; CanvasTexture itself is typed canvas-texture-headless on a headless host, so its shading parameters are never reached.",
    },
    {
      id: "global_shader_parameter_add",
      owner: "post-gate-6 capabilities: global shader uniforms (unscheduled)",
      notes:
        "hooked slot; no committed gate 6 fixture sets a global shader parameter.",
    },
    {
      id: "global_shader_parameter_remove",
      owner: "post-gate-6 capabilities: global shader uniforms (unscheduled)",
      notes:
        "hooked slot; no committed gate 6 fixture removes a global shader parameter.",
    },
    {
      id: "global_shader_parameter_set",
      owner: "post-gate-6 capabilities: global shader uniforms (unscheduled)",
      notes:
        "hooked slot; no committed gate 6 fixture sets a global shader parameter.",
    },
    {
      id: "global_shader_parameter_set_override",
      owner: "post-gate-6 capabilities: global shader uniforms (unscheduled)",
      notes:
        "hooked slot; no committed gate 6 fixture overrides a global shader parameter.",
    },
    {
      id: "material_set_next_pass",
      owner: "unscheduled",
      notes:
        "hooked slot; no committed gate 6 fixture chains a material's next pass.",
    },
    {
      id: "material_set_render_priority",
      owner: "unscheduled",
      notes: "hooked slot; no committed gate 6 fixture sets a render priority.",
    },
    {
      id: "shader_set_path_hint",
      owner: "unscheduled",
      notes:
        "hooked slot; no committed gate 6 fixture sets a shader path hint.",
    },
    {
      id: "texture_set_size_override",
      owner: "unscheduled",
      notes:
        "hooked slot; no committed gate 6 fixture overrides a texture's reported size.",
    },
    {
      id: "viewport_set_canvas_cull_mask",
      owner: "unscheduled",
      notes:
        "hooked slot; no committed gate 6 fixture changes the root canvas cull mask.",
    },
    {
      id: "viewport_set_snap_2d_transforms_to_pixel",
      owner:
        "gate 8: snap-to-pixel runtime-change census (gate6-design.md D17)",
      notes:
        "the setting is declared at arm (viewport.snap_2d); a runtime CHANGE to it stays unobserved (D17).",
    },
    {
      id: "viewport_set_snap_2d_vertices_to_pixel",
      owner:
        "gate 8: snap-to-pixel runtime-change census (gate6-design.md D17)",
      notes:
        "the setting is declared at arm (viewport.snap_2d); a runtime CHANGE to it stays unobserved (D17).",
    },
  ];

// -------------------------------------------------------------------------------------------
// kind "item_state" and "canvas_state": same source, lines ~249-266.
// -------------------------------------------------------------------------------------------

const ITEM_STATE_SUPPORTED: readonly string[] = [
  "behind",
  "children",
  "clip",
  "custom_rect",
  "draw_index",
  "instance_params",
  "material",
  "modulate",
  "parent",
  "self_modulate",
  "texture_filter",
  "texture_repeat",
  "transform",
  "use_parent_material",
  "visibility_layer",
  "visible",
  "z_index",
  "z_relative",
];

const CANVAS_STATE_SUPPORTED: readonly string[] = [
  "layer",
  "modulate",
  "transform",
];

// -------------------------------------------------------------------------------------------
// kind "resource": lines ~267-281.
// -------------------------------------------------------------------------------------------

const RESOURCES_SUPPORTED: readonly string[] = [
  "material",
  "mesh",
  "shader",
  "texture_2d",
  "texture_2d_placeholder",
];

// -------------------------------------------------------------------------------------------
// Full entry list, assembled by make-features.ts (sorted there for determinism).
// -------------------------------------------------------------------------------------------

export const FEATURE_ENTRIES: FeatureEntry[] = [
  ...OPS_SUPPORTED.map(supportedOp),
  ...OPS_TYPED_UNSUPPORTED.map(
    (o): FeatureEntry => ({
      id: o.id,
      kind: "op",
      name: o.id,
      status: "typed-unsupported",
      reason: o.reason,
      exactness: null,
      evidence: o.evidence ?? [],
      owner: o.owner,
      notes: null,
    }),
  ),
  ...OPS_UNOBSERVED.map(
    (o): FeatureEntry => ({
      id: o.id,
      kind: "op",
      name: o.id,
      status: "unobserved",
      reason: null,
      exactness: null,
      evidence: [],
      owner: o.owner,
      notes: o.notes,
    }),
  ),
  ...ITEM_STATE_SUPPORTED.map(
    (id): FeatureEntry => ({
      id: `item_state.${id}`,
      kind: "item_state",
      name: id,
      status: "supported",
      reason: null,
      exactness: "exact",
      evidence: [SCENE_CENSUS, SCENE_REPLAY],
      owner: null,
      notes: null,
    }),
  ),
  ...CANVAS_STATE_SUPPORTED.map(
    (id): FeatureEntry => ({
      id: `canvas_state.${id}`,
      kind: "canvas_state",
      name: id,
      status: "supported",
      reason: null,
      exactness: "exact",
      evidence:
        id === "layer"
          ? [
              ev(
                "gate6",
                "gate6-hd",
                "receiver-hd-half",
                "canvas-stacking-parity",
              ),
            ]
          : [SCENE_CENSUS],
      owner: null,
      notes:
        id === "layer"
          ? "CanvasLayer stacking (layer, sublayer), supported on /6 for layers attached to the root viewport (gate6-design.md D3)."
          : null,
    }),
  ),
  ...RESOURCES_SUPPORTED.map(
    (id): FeatureEntry => ({
      id: `resource.${id}`,
      kind: "resource",
      name: id,
      status: "supported",
      reason: null,
      exactness: "exact",
      evidence: [SCENE_CENSUS],
      owner: null,
      notes: null,
    }),
  ),
  {
    id: "resource.canvas_texture",
    kind: "resource",
    name: "canvas_texture",
    status: "typed-unsupported",
    reason: "canvas-texture-headless",
    exactness: null,
    evidence: [],
    owner:
      "gate 8: headless CanvasTexture shim (memory canvas-texture-headless-rid; STS2 criterion 5 pending approval)",
    notes:
      "a headless host's RenderingServer.canvas_texture_create returns RID() by default (dummy renderer); the opt-in GRC_HEADLESS_CANVAS_TEXTURE=synthesize shim is not used by any committed gate 6 fixture.",
  },

  // -----------------------------------------------------------------------------------------
  // kind "viewport": presentation, stretch, snap and canvas-stacking session-level entries.
  // -----------------------------------------------------------------------------------------
  {
    id: "viewport.presentation-declared",
    kind: "viewport",
    name: "presentation_size / font_oversampling / host_size_status declared",
    status: "supported",
    reason: null,
    exactness: "exact",
    evidence: [
      ev("gate6", "gate6-hd", "capture-hd-half", "presentation-declared"),
    ],
    owner: null,
    notes:
      "GRC_ROOT_SIZE=presentation:<W>x<H> makes the headless root window WxH so the engine itself computes the stretch transform, font oversampling and StyleBoxFlat feather (gate6-design.md D2).",
  },
  {
    id: "viewport.snap_2d-declared",
    kind: "viewport",
    name: "snap_2d declared at arm",
    status: "supported",
    reason: null,
    exactness: "exact",
    evidence: [ev("gate6", "gate6-scene", "capture-snap", "snap-typed")],
    owner: null,
    notes: null,
  },
  {
    id: "viewport.snap-2d",
    kind: "viewport",
    name: "snap-to-pixel replay",
    status: "typed-unsupported",
    reason: "snap-2d",
    exactness: null,
    evidence: [ev("gate6", "gate6-scene", "capture-snap", "snap-typed")],
    owner: "gate 8: snap-to-pixel replay census (gate6-design.md D17)",
    notes:
      "declared and typed, never replayed: the receiver does not apply snap_2d_transforms_to_pixel/_vertices_to_pixel.",
  },
  {
    id: "viewport.degenerate-host-size",
    kind: "viewport",
    name: "degenerate 64x64 host (observe policy)",
    status: "typed-unsupported",
    reason: "degenerate-host-size",
    exactness: null,
    evidence: [],
    owner: "gate 8: STS2's host size policy (gate6-design.md D4)",
    notes:
      "root_size_policy observe keeps the 64x64 headless root (scene_tree.cpp:2034); no committed gate 6 fixture uses this policy, every one declares enforce-min-size or presentation:.",
  },
  {
    id: "viewport.presentation-mismatch",
    kind: "viewport",
    name: "receiver at a different presentation size",
    status: "typed-unsupported",
    reason: "presentation-mismatch",
    exactness: null,
    evidence: [
      ev(
        "gate6",
        "gate6-hd",
        "receiver-hd-half-at-logical",
        "presentation-hazard-measured",
      ),
    ],
    owner:
      "gate 7: several presentation sizes per session, receiver-advertised size negotiation",
    notes:
      "one presentation scale per capture session (gate6-design.md D2); this is the typing, not the feature -- serving several viewer sizes from one session is gate 7's.",
  },
  {
    id: "viewport.oversampling-mismatch",
    kind: "viewport",
    name: "receiver oversampling differs from the declared value",
    status: "typed-unsupported",
    reason: "oversampling-mismatch",
    exactness: null,
    evidence: [
      ev(
        "gate6",
        "gate6-hd",
        "receiver-hd-half-at-logical",
        "presentation-hazard-measured",
      ),
    ],
    owner:
      "gate 7: several presentation sizes per session, receiver-advertised size negotiation",
    notes: null,
  },
  {
    id: "viewport.stretch-mode-viewport",
    kind: "viewport",
    name: 'stretch.mode = "viewport"',
    status: "declared-unverified",
    reason: null,
    exactness: null,
    evidence: [],
    owner: "gate 8: stretch mode viewport census",
    notes:
      "stretch mode viewport evaluates nothing scale-dependent on the host, but no committed fixture proves it, so the receiver would type it stretch-mode if it occurred (gate6-design.md D2, Deferred).",
  },
  {
    id: "viewport.stretch-aspect-other-than-keep",
    kind: "viewport",
    name: 'stretch.aspect other than "keep" at an unequal ratio',
    status: "declared-unverified",
    reason: null,
    exactness: null,
    evidence: [],
    owner: "gate 8",
    notes:
      "the wire's stretch.aspect enum accepts ignore/keep/keep_width/keep_height/expand; every committed gate 6 fixture uses keep at an equal aspect ratio (gate6-hd 1920x1080 <-> 960x540), so the other values are unexercised (Q8 example).",
  },
  {
    id: "viewport.stretch-scale-mode-integer",
    kind: "viewport",
    name: 'stretch.scale_mode = "integer"',
    status: "declared-unverified",
    reason: null,
    exactness: null,
    evidence: [],
    owner: "gate 8",
    notes:
      "every committed gate 6 fixture uses scale_mode fractional (the default); integer is accepted by the wire schema but unexercised (Q8 example).",
  },
  {
    id: "viewport.non-root-viewport",
    kind: "viewport",
    name: "non-root Viewport / SubViewport",
    status: "typed-unsupported",
    reason: "non-root-viewport",
    exactness: null,
    evidence: [],
    owner:
      "gate 8: non-root Viewport/SubViewport census (typed since gate 0, never given a dedicated increment)",
    notes: null,
  },
  {
    id: "viewport.canvas-stacking-tie",
    kind: "viewport",
    name: "two attached canvases at an equal (layer, sublayer)",
    status: "declared-unverified",
    reason: "canvas-stacking-tie",
    exactness: null,
    evidence: [],
    owner: "gate 8: canvas RID-order tie-breaking census",
    notes:
      'the renderer breaks equal stacking keys by canvas RID (rv.h:125-130), which no receiver can reproduce; decoders accept and validate the shape (viewport-entry / canvas-stacking-tie-miss / -false, render-stream-6.md), but no committed gate 6 fixture produces it (gate6-design.md "As built (G6b)" 1: "No transaction of any capture carries a canvas-stacking-tie").',
  },
  {
    id: "viewport.global-canvas-transform",
    kind: "viewport",
    name: "Viewport.set_canvas_transform changed at runtime",
    status: "declared-unverified",
    reason: "global-canvas-transform",
    exactness: null,
    evidence: [],
    owner: "gate 8",
    notes:
      "calibrator 9 hooks viewport_set_global_canvas_transform and compares it with the arm-time stretch (gate6-design.md Q2); render-stream-6.md's golden-6 fixture exercises the wire shape, but no end-to-end gate 6 leg changes the root's global canvas transform at runtime.",
  },
  {
    id: "viewport.presentation-size-negotiation",
    kind: "viewport",
    name: "several presentation sizes per capture session",
    status: "unobserved",
    reason: null,
    exactness: null,
    evidence: [],
    owner:
      "gate 7: one host evaluation per size, a re-evaluating host, or resampled text/feathers with presentation-mismatch typed",
    notes:
      "gate 6 proves and measures the single-size contract and its hazard (G6b); negotiating several sizes from one session has no implementation at all.",
  },

  // -----------------------------------------------------------------------------------------
  // kind "material": shader policy and the typed material/shader reasons.
  // -----------------------------------------------------------------------------------------
  {
    id: "material.shader_policy",
    kind: "material",
    name: "shader delivery policy (source / params / exclude)",
    status: "supported",
    reason: null,
    exactness: "exact",
    evidence: [
      ev(
        "gate5.5",
        "gate55-shader",
        "capture-policy-params",
        "shader-policy-respected",
      ),
    ],
    owner: null,
    notes: null,
  },
  {
    id: "material.shader-withheld",
    kind: "material",
    name: "GRC_SHADER_POLICY=params: code withheld, a receiver with no library types it",
    status: "supported",
    reason: "shader-withheld",
    exactness: "exact",
    evidence: [
      ev(
        "gate5.5",
        "gate55-shader",
        "receiver-params-nolib",
        "shader-policy-respected",
      ),
    ],
    owner: null,
    notes: null,
  },
  {
    id: "material.shader-excluded",
    kind: "material",
    name: "GRC_SHADER_POLICY=exclude: shader refused outright",
    status: "supported",
    reason: "shader-excluded",
    exactness: "exact",
    evidence: [
      ev(
        "gate5.5",
        "gate55-shader",
        "capture-policy-exclude",
        "shader-policy-respected",
      ),
    ],
    owner: null,
    notes: null,
  },
  {
    id: "material.unsupported-material",
    kind: "material",
    name: "an item's effective material is itself unsupported",
    status: "typed-unsupported",
    reason: "unsupported-material",
    exactness: null,
    evidence: [REFUSED],
    owner:
      "post-gate-6 capabilities: shader TIME (gate6-design.md Deferred, unscheduled)",
    notes:
      'the refused fixture\'s TIME shader is the committed example (gate6-design.md "As built (G6b)" 9).',
  },
  {
    id: "material.unknown-material",
    kind: "material",
    name: "an item names a material RID the mirror never saw created",
    status: "typed-unsupported",
    reason: "unknown-material",
    exactness: null,
    evidence: [],
    owner: "unscheduled",
    notes:
      'proven at gate 5.5 by a golden-5 decoder vector (gate5_5-design.md "State 15"), not by an end-to-end gate 6 leg.',
  },
  {
    id: "material.param-type",
    kind: "material",
    name: "an instance shader parameter of an unsupported type",
    status: "typed-unsupported",
    reason: "param-type",
    exactness: null,
    evidence: [],
    owner: "unscheduled",
    notes:
      'proven at gate 5.5 by a golden-5 decoder vector (gate5_5-design.md "State 15"), not by an end-to-end gate 6 leg.',
  },
  {
    id: "material.param-range",
    kind: "material",
    name: "a material or instance parameter outside its supported range",
    status: "typed-unsupported",
    reason: "param-range",
    exactness: null,
    evidence: [],
    owner: "unscheduled",
    notes: "named in gate5_5-design.md D16; no committed fixture triggers it.",
  },
  {
    id: "material.unknown-shader",
    kind: "material",
    name: "a material names a shader RID the mirror never saw created",
    status: "typed-unsupported",
    reason: "unknown-shader",
    exactness: null,
    evidence: [],
    owner: "unscheduled",
    notes: "named in gate5_5-design.md D16; no committed fixture triggers it.",
  },
  {
    id: "material.late-join-materials",
    kind: "material",
    name: "materials and shaders already live when a receiver joins",
    status: "unobserved",
    reason: null,
    exactness: null,
    evidence: [],
    owner:
      "gate 8: late-join adoption pass (STS2 pre-arm materials; also measures per-frame material_set_param decode cost)",
    notes:
      "support landed at gate 5.5; no gate 6 fixture has a receiver join after materials already exist, so late-join adoption is unexercised.",
  },

  // -----------------------------------------------------------------------------------------
  // kind "text": glyph rasterization, RichTextLabel, deferred text-adjacent capabilities.
  // -----------------------------------------------------------------------------------------
  {
    id: "text.rasterization-and-atlas",
    kind: "text",
    name: "host-evaluated, host-rasterized glyph atlases",
    status: "supported",
    reason: null,
    exactness: "exact",
    evidence: [ev("gate6", "gate6-scene", "receiver-scene", "atlas-parity")],
    owner: null,
    notes:
      "glyph pixels and antialiasing bands are 'undecided' only in the independent hand model (gate6-design.md D7); the receiver is still checked whole-frame, budget 0, against the rendered reference.",
  },
  {
    id: "text.rich_text_label_scroll_and_lines",
    kind: "text",
    name: "RichTextLabel line height, scroll clamping and clip",
    status: "supported",
    reason: null,
    exactness: "exact",
    evidence: [SCENE_REPLAY],
    owner: null,
    notes:
      '23px regular/bold line height, image line 64px, scroll clamped to the new maximum on text replacement (gate6-design.md "As built (G6a)" 7).',
  },
  {
    id: "text.richtextlabel-effects-textedit-ime",
    kind: "text",
    name: "RichTextLabel BBCode effects, TextEdit and IME composition",
    status: "unobserved",
    reason: null,
    exactness: null,
    evidence: [],
    owner:
      "post-gate-6: a host-time contract like shader TIME (effects); gate 8's census (TextEdit/IME)",
    notes:
      "effects run on process time (gate6-design.md Q1f) and are kept out of every gate 6 fixture by construction.",
  },

  // -----------------------------------------------------------------------------------------
  // kind "control": Control-specific behaviors and higher-level deferred capabilities.
  // -----------------------------------------------------------------------------------------
  {
    id: "control.scroll_container_offset",
    kind: "control",
    name: "ScrollContainer offset and content clip",
    status: "supported",
    reason: null,
    exactness: "exact",
    evidence: [ev("gate6", "gate6-scene", "receiver-scene", "scroll-parity")],
    owner: null,
    notes: null,
  },
  {
    id: "control.progress_bar_value_and_fill",
    kind: "control",
    name: "ProgressBar per-frame value, text and fill width",
    status: "supported",
    reason: null,
    exactness: "exact",
    evidence: [SCENE_REPLAY],
    owner: null,
    notes:
      'redraws every frame (step 0.01); text int(ratio*100), fill round(ratio*(w-4)) (gate6-design.md "As built (G6a)" 4).',
  },
  {
    id: "control.line_edit_focus_selection_caret",
    kind: "control",
    name: "LineEdit focus box, selection and caret",
    status: "supported",
    reason: null,
    exactness: "exact",
    evidence: [
      ev("gate6", "gate6-hd", "receiver-hd-native", "receiver-vs-reference"),
    ],
    owner: null,
    notes:
      "one focus owner per viewport; deselect_on_focus_loss_enabled must be set false before the next LineEdit grabs focus (memory rs-g6h-hd-facts).",
  },
  {
    id: "control.animation_player_and_tween_sampling",
    kind: "control",
    name: "AnimationPlayer and Tween deterministic per-frame sampling",
    status: "supported",
    reason: null,
    exactness: "exact",
    evidence: [SCENE_REPLAY],
    owner: null,
    notes:
      "quarter-frame clocks (gate6-design.md D6) keep every sample a quarter frame from any key, loop end or rounding threshold.",
  },
  {
    id: "control.reference-repeatability-budget",
    kind: "control",
    name: "a same-build repeat of the rendered reference",
    status: "supported",
    reason: null,
    exactness: "repeat-budget",
    evidence: [
      ev(
        "gate6",
        "gate6-scene",
        "reference-scene-repeat",
        "reference-repeat-budget",
      ),
    ],
    owner: null,
    notes:
      '0 mismatched pixels of every shot on gate6-scene and gate6-hd, both presentations (gate6-design.md "As built (G6a/G6h)").',
  },
  {
    id: "control.stylebox_antialiasing_feather",
    kind: "control",
    name: "StyleBoxFlat antialiasing feather under canvas_items stretch",
    status: "supported",
    reason: null,
    exactness: "exact",
    evidence: [
      ev("gate6", "gate6-hd", "receiver-hd-half", "stylebox-aa-scale"),
    ],
    owner: null,
    notes:
      'aa_size / scale, band still aa_size/2 + 1 screen px; 768 triangle arrays matched the gate 5g port with 0 ulp, needing none of the 2-ulp allowance (gate6-design.md "As built (G6b)" 6).',
  },
  {
    id: "control.late-join-adoption",
    kind: "control",
    name: "a receiver joining after items/canvases/textures/meshes/materials already exist",
    status: "unobserved",
    reason: null,
    exactness: null,
    evidence: [],
    owner:
      "gate 8: late-join adoption pass (STS2: 46 pre-arm roots, 1302 items withheld; memories rs-sts2-shim-leg-findings, rs-unknown-item-skip)",
    notes:
      "gate 6's canvas-layer support is only the replay half; adoption of pre-arm layers is gate 8's.",
  },
  {
    id: "control.browser-receivers",
    kind: "control",
    name: "web export and GSW canvas receivers",
    status: "unobserved",
    reason: null,
    exactness: null,
    evidence: [],
    owner:
      "gate 7: own pacing, suspension, startup and memory gates, own manifests (render-stream-features/2)",
    notes:
      "gate 6's fixtures, expectations and render-stream-report/1 are their conformance and measurement baseline.",
  },
  {
    id: "control.arm-on-first-subscriber",
    kind: "control",
    name: "arm on first subscriber, disarm on last",
    status: "unobserved",
    reason: null,
    exactness: null,
    evidence: [],
    owner: "after gate 8's adoption pass (gate1-design.md D6)",
    notes:
      "gate 6's armed-idle arm measures what a permanently armed hook costs today (G6p).",
  },
  {
    id: "control.light2d_rendering",
    kind: "control",
    name: "Light2D rendering: shadows, normal/specular maps, occluders",
    status: "unobserved",
    reason: null,
    exactness: null,
    evidence: [],
    owner:
      'the handoff\'s later capabilities, unchanged from gate5_5-design.md and gate5-design.md "Deferred"',
    notes:
      "Light2D attachment itself is typed (material.unsupported via canvas-light); its rendering is not implemented at all.",
  },
  {
    id: "control.windows-and-macos",
    kind: "control",
    name: "Windows and macOS hosts/receivers",
    status: "unobserved",
    reason: null,
    exactness: null,
    evidence: [],
    owner: "after gate 6, per the handoff's platform scope",
    notes:
      "every gate 6 fixture, capture and receiver run on Linux; nothing here has been tried on Windows or macOS.",
  },

  // -----------------------------------------------------------------------------------------
  // kind "delivery": connections, rate control, transport, resource stability.
  // -----------------------------------------------------------------------------------------
  {
    id: "delivery.publication_rate_control",
    kind: "delivery",
    name: "GRC_PUBLISH_FPS target rate, coalescing missed ticks",
    status: "supported",
    reason: null,
    exactness: null,
    evidence: [ev("gate6", "gate6-scene", "rate-60", "rate-achieved-rate-60")],
    owner: null,
    notes:
      "at 60/60 the achieved rate is phase-dependent on the credit RTT (memory rs-g6c-60-60-phase-lock); the mechanism itself (a due tick that holds credit, carrying the newest state) is supported.",
  },
  {
    id: "delivery.multiple_live_connections",
    kind: "delivery",
    name: "GRC_LIVE_MAX_CONNECTIONS: two receivers at different rates",
    status: "supported",
    reason: null,
    exactness: null,
    evidence: [
      ev("gate6", "gate6-scene", "dual-60-15", "dual-independent-dual-60-15"),
    ],
    owner: null,
    notes: "one snapshot copy per host frame serves every open connection.",
  },
  {
    id: "delivery.constrained_transport",
    kind: "delivery",
    name: "delivery across a bandwidth- and latency-limited link",
    status: "supported",
    reason: null,
    exactness: null,
    evidence: [
      ev("gate6", "gate6-scene", "constrained", "host-unperturbed-constrained"),
    ],
    owner: null,
    notes:
      "a runner-side token-bucket TCP proxy (gate6-design.md D12), not tc; loopback only.",
  },
  {
    id: "delivery.receiver_resource_budgets",
    kind: "delivery",
    name: "receiver memory/disk cache budgets with LRU eviction",
    status: "supported",
    reason: null,
    exactness: null,
    evidence: [
      ev(
        "gate6",
        "gate6-scene",
        "soak-scene",
        "g6s-cache-budget-respected-soak-scene",
      ),
    ],
    owner: null,
    notes:
      "never evicts a hash in the needed set; a 300 s soak keeps residency bounded (gate6-design.md Q7e).",
  },
  {
    id: "delivery.non_loopback_serving",
    kind: "delivery",
    name: "the host and receiver on separate machines",
    status: "unobserved",
    reason: null,
    exactness: null,
    evidence: [],
    owner: "gate 8 (gate2-design.md D13)",
    notes:
      "gate 6's constrained transport is a loopback proxy, not a real network path.",
  },
  {
    id: "delivery.presented_timing",
    kind: "delivery",
    name: "presentation feedback (frame actually shown, not just applied)",
    status: "unobserved",
    reason: null,
    exactness: null,
    evidence: [],
    owner:
      "gate 7 for browsers (requestAnimationFrame, presentation feedback where exposed)",
    notes:
      "Godot exposes no presentation feedback and gamescope's own statistics are not wired (gate6-design.md D9); every report's rates.presented is status unavailable.",
  },

  // -----------------------------------------------------------------------------------------
  // kind "payload": payload formats, sizes, delivery mechanics, measured-not-implemented deltas.
  // -----------------------------------------------------------------------------------------
  {
    id: "payload.content_addressed_store_and_inline",
    kind: "payload",
    name: "content-addressed file store, HTTP-by-hash and inline live delivery",
    status: "supported",
    reason: null,
    exactness: "exact",
    evidence: [
      ev("gate6", "gate6-scene", "capture-scene", "recordings-decode"),
    ],
    owner: null,
    notes: null,
  },
  {
    id: "payload.size_and_format_limits",
    kind: "payload",
    name: "GRC_RESOURCE_MAX_PAYLOAD_BYTES / GRC_RESOURCE_FORMATS",
    status: "supported",
    reason: null,
    exactness: null,
    evidence: [
      ev("gate6", "gate6-scene", "capture-scene-inline", "recordings-decode"),
    ],
    owner: null,
    notes: null,
  },
  {
    id: "payload.compressed_and_float_texture_formats",
    kind: "payload",
    name: "DXT, BPTC and float texture payloads",
    status: "unobserved",
    reason: null,
    exactness: null,
    evidence: [],
    owner: "gate 8, decided together with gate 7's receiver manifests",
    notes:
      "STS2 has 940 of 1451 textures in these formats; the options are carrying compressed payloads for receivers that advertise them, or a host-side CPU decode. Gate 6 adds nothing here.",
  },
  {
    id: "payload.deltas_and_lazy_hashing",
    kind: "payload",
    name: "payload deltas, atlas/mesh-region deltas, parameter deltas, hash-at-publish, lazy hashing, spill-to-disk, parallel fetches",
    status: "unobserved",
    reason: null,
    exactness: null,
    evidence: [],
    owner:
      "the first optimization increment after gate 6, chosen from G6p's `optimizations` numbers (gate6-design.md D15)",
    notes:
      'measured offline by scripts/analyze-deltas.ts, not implemented; see the README "Gate 6 summary" for the measured whole-version-vs-delta figures.',
  },
];
