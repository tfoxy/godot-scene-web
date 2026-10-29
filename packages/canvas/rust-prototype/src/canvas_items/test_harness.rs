//! `canvas-items-test` only: wasm-bindgen exports that drive a [`CanvasItemsExecutor`] from a page,
//! for `packages/test-harness/test/canvasItemsRustPixel.test.ts` (byte-identical against G7c's
//! TypeScript executor). Lists arrive as `PDL1` dumps; texture uploads beside them. Never enable
//! this feature in a module that ships: these exports would land in it.
use super::{CanvasItemsExecutor, ExecOptions, FenceState, Sabotage, replace_marking_changes};
use gsw_canvas_draw_list::{DrawList, pdl1};
use wasm_bindgen::prelude::*;

fn js(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}

#[wasm_bindgen]
pub struct CanvasItemsTestHarness {
    executor: CanvasItemsExecutor,
    list: DrawList,
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

    /// [`CanvasItemsTestHarness::new`] with [`ExecOptions::godot_orientation`] set as given (G7t:
    /// the item-space program cases run in both orientations, read back in design rows).
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
            },
        )
        .map_err(js)?;
        Ok(CanvasItemsTestHarness {
            executor,
            list: DrawList::default(),
        })
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

    /// G7s: register item-space program `id` from an `@godot-scene-web/effects`
    /// `transpileGodotItemShader` module; a compile failure is the error (GL's log).
    pub fn define_program(&mut self, id: u32, module: &str) -> Result<(), JsValue> {
        self.executor.define_program(id, module).map_err(js)
    }

    /// P3-VX: [`define_program`](Self::define_program) for a program with its own vertex stage
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

    /// G7s: binding slot `slot` of the held list (draws name it `slot + 1`) from JSON
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
