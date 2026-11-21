//! `canvas-items-test` only: wasm-bindgen exports that drive a [`CanvasItemsExecutor`] from a page,
//! for `packages/test-harness/test/canvasItemsRustPixel.test.ts` (byte-identical against the
//! TypeScript executor). Lists arrive as `PDL1` dumps; texture uploads beside them. Never enable
//! this feature in a module that ships: these exports would land in it.
use super::{
    CanvasItemsExecutor, ExecOptions, FenceState, Sabotage, SurfacePass, replace_marking_changes,
};
use gsw_canvas_draw_list::{DrawList, TextureOp, pdl1};
use wasm_bindgen::prelude::*;

fn js(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}

#[wasm_bindgen]
pub struct CanvasItemsTestHarness {
    executor: CanvasItemsExecutor,
    list: DrawList,
    surface_list: DrawList,
}

#[wasm_bindgen]
impl CanvasItemsTestHarness {
    /// An executor on `canvas` (which must have no context yet). `sabotage`: `""`, `"drop-draws"`
    /// or `"stale-item-row"`.
    #[wasm_bindgen(constructor)]
    pub fn new(
        canvas: web_sys::HtmlCanvasElement,
        sabotage: &str,
    ) -> Result<CanvasItemsTestHarness, JsValue> {
        Self::with_options(canvas, sabotage, false)
    }

    /// [`CanvasItemsTestHarness::new`] with [`ExecOptions::godot_orientation`] set as given (the
    /// item-space program cases run in both orientations, read back in design rows).
    pub fn with_options(
        canvas: web_sys::HtmlCanvasElement,
        sabotage: &str,
        godot_orientation: bool,
    ) -> Result<CanvasItemsTestHarness, JsValue> {
        let sabotage = Sabotage::parse(sabotage).map_err(js)?;
        let executor = CanvasItemsExecutor::new(
            canvas,
            ExecOptions {
                sabotage,
                godot_orientation,
                ..ExecOptions::default()
            },
        )
        .map_err(js)?;
        Ok(CanvasItemsTestHarness {
            executor,
            list: DrawList::default(),
            surface_list: DrawList::default(),
        })
    }

    /// Context-only construction for preparation lifecycle tests.
    pub fn begin(canvas: web_sys::HtmlCanvasElement) -> Result<CanvasItemsTestHarness, JsValue> {
        Ok(Self {
            executor: CanvasItemsExecutor::begin(canvas, ExecOptions::default()).map_err(js)?,
            list: DrawList::default(),
            surface_list: DrawList::default(),
        })
    }

    pub fn prepare_step(&mut self) -> Result<bool, JsValue> {
        self.executor.prepare_step().map_err(js)
    }

    pub fn is_prepared(&self) -> bool { self.executor.is_prepared() }

    pub fn set_draw_batching(&mut self, mask: u32) {
        let mut options = self.executor.options();
        options.batching = mask;
        self.executor.set_options(options);
    }

    pub fn set_damage(&mut self, on: bool) {
        let mut options = self.executor.options();
        options.damage = on;
        self.executor.set_options(options);
    }

    pub fn set_sabotage(&mut self, name: &str) -> Result<(), JsValue> {
        let mut options = self.executor.options();
        options.sabotage = Sabotage::parse(name).map_err(js)?;
        self.executor.set_options(options);
        Ok(())
    }

    pub fn alias_surface(&mut self, texture: u32, surface: u32) {
        self.list.texture_ops.push(TextureOp::Surface {
            id: texture,
            surface,
        });
    }

    /// Draw one surface pass before the held root, consuming the root on success.
    pub fn execute_surface(&mut self, surface: u32, pdl: &[u8]) -> Result<String, JsValue> {
        let mut list = pdl1::decode(pdl).map_err(js)?;
        list.target.surface = surface;
        let pass = SurfacePass { list: &list, clear: true };
        let stats = self.executor
            .execute_frame(&self.list, &[pass], &[])
            .map_err(js)?;
        self.list.consumed();
        Ok(stats.to_json())
    }

    /// Update geometry with explicit shared indices before computing retained dirty ranges.
    pub fn update_with_indices(&mut self, pdl: &[u8], indices: &[u32]) -> Result<(), JsValue> {
        let mut next = pdl1::decode(pdl).map_err(js)?;
        next.indices = indices.to_vec();
        replace_marking_changes(&mut self.list, next);
        Ok(())
    }

    /// Update and consume a retained surface list, just like the root's `update`/`execute` pair.
    pub fn execute_retained_surface(&mut self, surface: u32, pdl: &[u8], indices: &[u32]) -> Result<String, JsValue> {
        let mut next = pdl1::decode(pdl).map_err(js)?;
        next.target.surface = surface;
        next.indices = indices.to_vec();
        replace_marking_changes(&mut self.surface_list, next);
        let pass = SurfacePass { list: &self.surface_list, clear: true };
        let stats = self.executor.execute_frame(&self.list, &[pass], &[]).map_err(js)?;
        self.list.consumed();
        self.surface_list.consumed();
        Ok(stats.to_json())
    }

    /// Free the named surfaces and draw the unchanged held root.
    pub fn execute_freed(&mut self, freed: &[u32]) -> Result<String, JsValue> {
        let stats = self.executor
            .execute_frame(&self.list, &[], freed)
            .map_err(js)?;
        self.list.consumed();
        Ok(stats.to_json())
    }

    pub fn free_all_surfaces(&mut self) {
        self.executor.free_all_surfaces();
    }

    /// Replace the list with a `PDL1` dump, everything dirty. Queued texture ops are kept.
    pub fn load(&mut self, pdl: &[u8]) -> Result<(), JsValue> {
        let mut next = pdl1::decode(pdl).map_err(js)?;
        next.texture_ops = std::mem::take(&mut self.list.texture_ops);
        next.texture_bytes = std::mem::take(&mut self.list.texture_bytes);
        next.texture_shared = std::mem::take(&mut self.list.texture_shared);
        self.list = next;
        Ok(())
    }

    /// Replace the list with a `PDL1` dump, marking dirty only the elements that differ from the
    /// held list (every array whose length changed is re-sent whole).
    pub fn update(&mut self, pdl: &[u8]) -> Result<(), JsValue> {
        let next = pdl1::decode(pdl).map_err(js)?;
        replace_marking_changes(&mut self.list, next);
        Ok(())
    }

    /// Set the held list's depth tables (`DrawList::depth_tiles`, `DrawList::depth_draws`):
    /// `tiles` as `x, y, w, h, level` quintuples, `draws` as `draw, level` pairs. Empty slices
    /// clear them. A `load` replaces them with the dump's (none).
    pub fn set_depth(&mut self, tiles: &[i32], draws: &[u32]) {
        self.list.depth_tiles = tiles
            .chunks_exact(5)
            .map(|t| gsw_canvas_draw_list::DepthTile {
                rect: [t[0], t[1], t[2], t[3]],
                level: t[4] as u32,
            })
            .collect();
        self.list.depth_draws = draws
            .chunks_exact(2)
            .map(|d| gsw_canvas_draw_list::DepthDraw {
                draw: d[0],
                level: d[1],
            })
            .collect();
    }

    /// Test-only replay tables alongside the PDL1 geometry (which has no screen operations).
    pub fn set_replay_tables(&mut self, json: &str) -> Result<(), JsValue> {
        use gsw_canvas_draw_list::{ScreenOp, ScreenOpKind, Instance, InstancedDraw};
        let v: serde_json::Value = serde_json::from_str(json).map_err(js)?;
        if let Some(flags) = v["flags"].as_array() {
            for (draw, flags) in self.list.draws.iter_mut().zip(flags) {
                draw.flags |= flags.as_u64().unwrap_or(0) as u32;
            }
        }
        self.list.screen_ops.clear();
        if let Some(ops) = v["ops"].as_array() {
            for op in ops {
                let n = |i: usize| op[i].as_i64().unwrap_or(0) as i32;
                self.list.screen_ops.push(ScreenOp {
                    before: n(0) as u32,
                    kind: match n(1) { 0 => ScreenOpKind::Copy, 1 => ScreenOpKind::Clear, _ => ScreenOpKind::Mipmaps },
                    region: [n(2), n(3), n(4), n(5)], mipmaps: n(6) != 0, sample_mips: n(7) != 0,
                });
            }
        }
        if let Some(draw) = v["instanceDraw"].as_u64() {
            self.list.instances = vec![Instance::IDENTITY, Instance {
                xform: [1.0, 0.0, 0.0, 20.0, 0.0, 1.0, 0.0, 0.0],
                ..Instance::IDENTITY
            }];
            self.list.instanced = vec![InstancedDraw { draw: draw as u32, first: 0, count: 2 }];
            self.list.dirty.instances.add(0, 2);
        }
        Ok(())
    }

    /// Mark everything dirty (after a restored context).
    pub fn mark_all(&mut self) {
        self.list.dirty.all = true;
    }

    /// Queue an upload of straight RGBA8 pixels for the next `execute`.
    pub fn upload_texture(
        &mut self,
        id: u32,
        width: u32,
        height: u32,
        rgba: &[u8],
    ) -> Result<(), JsValue> {
        if rgba.len() != 4 * width as usize * height as usize {
            return Err(js("upload_texture: rgba length is not 4·w·h"));
        }
        self.list.upload_texture(id, width, height, rgba);
        Ok(())
    }

    pub fn free_texture(&mut self, id: u32) {
        self.list.free_texture(id);
    }

    /// Register item-space program `id` from an `@godot-scene-web/effects`
    /// `transpileGodotItemShader` module; a compile failure is the error (GL's log).
    pub fn define_program(&mut self, id: u32, module: &str) -> Result<(), JsValue> {
        self.executor.define_program(id, module).map_err(js)
    }

    /// [`define_program`](Self::define_program) for a program with its own vertex stage
    /// (`vertex`: the transpiler's `vertexGlsl`).
    pub fn define_program_vertex(
        &mut self,
        id: u32,
        module: &str,
        vertex: &str,
    ) -> Result<(), JsValue> {
        self.executor
            .define_program_with_vertex(id, module, Some(vertex))
            .map_err(js)
    }

    /// [`CanvasItemsExecutor::begin_program`]: compile and link without reading the status
    /// (`vertex` empty: the builtin vertex stage). The program draws once `poll_programs` settles
    /// it.
    pub fn begin_program(&mut self, id: u32, module: &str, vertex: &str) -> Result<(), JsValue> {
        let vertex = (!vertex.is_empty()).then_some(vertex);
        self.executor.begin_program(id, module, vertex).map_err(js)
    }

    /// [`CanvasItemsExecutor::poll_programs`] as JSON: `[[id, null | "<log>"], ..]`.
    pub fn poll_programs(&mut self) -> String {
        let done = self.executor.poll_programs();
        let rows: Vec<serde_json::Value> = done
            .into_iter()
            .map(|(id, r)| serde_json::json!([id, r.err()]))
            .collect();
        serde_json::Value::Array(rows).to_string()
    }

    /// Whether program `id`'s link is begun and not settled.
    pub fn program_pending(&self, id: u32) -> bool {
        self.executor.program_pending(id)
    }

    /// Whether program `id` is registered and compiled (its draws run).
    pub fn has_program(&self, id: u32) -> bool {
        self.executor.has_program(id)
    }

    /// Binding slot `slot` of the held list (draws name it `slot + 1`) from JSON
    /// `{"program": n, "post_modulate": [r, g, b, a], "uniforms": [{"name": s, "float": [..]} |
    /// {"name": s, "int": [..]}], "samplers": [{"name": s, "texture": n, "sampler": bits}]}`.
    pub fn set_binding(&mut self, slot: u32, json: &str) -> Result<(), JsValue> {
        use gsw_canvas_draw_list::{Binding, SamplerUniform, Uniform, UniformValue};
        let v: serde_json::Value = serde_json::from_str(json).map_err(js)?;
        let nums = |x: &serde_json::Value| -> Vec<f64> {
            x.as_array()
                .map(|a| a.iter().filter_map(|n| n.as_f64()).collect())
                .unwrap_or_default()
        };
        let pm = nums(&v["post_modulate"]);
        let mut post_modulate = [1.0f32; 4];
        for (i, c) in pm.iter().take(4).enumerate() {
            post_modulate[i] = *c as f32;
        }
        let uniforms = v["uniforms"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|u| Uniform {
                        name: u["name"].as_str().unwrap_or_default().into(),
                        value: if u.get("int").is_some() {
                            UniformValue::Int(nums(&u["int"]).iter().map(|x| *x as i32).collect())
                        } else {
                            UniformValue::Float(
                                nums(&u["float"]).iter().map(|x| *x as f32).collect(),
                            )
                        },
                    })
                    .collect()
            })
            .unwrap_or_default();
        let samplers = v["samplers"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|s| SamplerUniform {
                        name: s["name"].as_str().unwrap_or_default().into(),
                        texture: s["texture"].as_u64().unwrap_or(0) as u32,
                        sampler: s["sampler"].as_u64().unwrap_or(0) as u32,
                    })
                    .collect()
            })
            .unwrap_or_default();
        self.list.set_binding(
            slot,
            Binding {
                program: v["program"].as_u64().unwrap_or(0) as u32,
                post_modulate,
                uniforms,
                samplers,
            },
        );
        Ok(())
    }

    /// `"ready"`, `"lost"` or `"restored"` (see `CanvasItemsExecutor::context_state`).
    pub fn context_state(&mut self) -> String {
        format!("{:?}", self.executor.context_state()).to_lowercase()
    }

    /// One frame; the list is consumed on success. Returns `ExecStats` as JSON.
    pub fn execute(&mut self) -> Result<String, JsValue> {
        let stats = self.executor.execute(&self.list).map_err(js)?;
        self.list.consumed();
        Ok(stats.to_json())
    }

    /// The merged draw-call count `gsw-canvas-draw-list` predicts for the held list.
    pub fn merged_draw_count(&self) -> u32 {
        self.list.merged_draw_count() as u32
    }

    /// The shot: the target read back RGBA8, rows top-down.
    pub fn read_target(&mut self) -> Result<Vec<u8>, JsValue> {
        let (w, h) = self
            .executor
            .target_size()
            .ok_or_else(|| js("no target yet"))?;
        let mut out = vec![0u8; 4 * w as usize * h as usize];
        self.executor.read_target(&mut out).map_err(js)?;
        Ok(out)
    }

    /// The canvas's drawing buffer after the blit (same task), rows top-down.
    pub fn read_canvas(&mut self) -> Result<Vec<u8>, JsValue> {
        let (w, h) = self
            .executor
            .target_size()
            .ok_or_else(|| js("no target yet"))?;
        let mut out = vec![0u8; 4 * w as usize * h as usize];
        self.executor.read_canvas(&mut out).map_err(js)?;
        Ok(out)
    }

    /// -1: no fence outstanding; 0: pending; 1: it signalled (and is now released).
    pub fn poll_fence(&mut self) -> i32 {
        match self.executor.poll_fence() {
            FenceState::None => -1,
            FenceState::Pending { .. } => 0,
            FenceState::Complete { .. } => 1,
        }
    }

    pub fn gl_error(&self) -> u32 {
        self.executor.gl_error()
    }
}
