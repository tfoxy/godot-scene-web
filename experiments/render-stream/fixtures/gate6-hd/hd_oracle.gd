extends RefCounted
## The gate 6 HD oracle (../../protocol/gate6-design.md "Q6f", G6h; `render-stream-gate6-hd-oracle/1`).
##
## Reference legs only (gate6_hd.gd refuses it when a GRC_* capture variable is set). At each
## settle frame's `frame_post_draw` it writes one JSON line read back from the rendered engine:
##   - `oversampling`: the root viewport's `get_oversampling()` (1 at `native`, 0.5 at `half`);
##   - `viewport`: the window size, the visible rect, the stretch scale and the canvas transform;
##   - `grid`: the GridContainer's position and size;
##   - `cells`: per cell, the Cell Control's position and size, the Scene's global position and,
##     through the synced scene_oracle.gd's own readers, everything gate6-scene's oracle reads for
##     one copy (scroll, the HUD layer, SM's and CM's material state, PB's value, the
##     RichTextLabel's layout and the LineEdit's selection and caret rects) plus LE's focus;
##   - `pages`: every atlas page of the fonts the scene uses (shared by all cells), as
##     scene_oracle.gd hashes them.

const SceneOracle := preload("res://scene_oracle.gd")

var _file: FileAccess
var _scene: SceneOracle = SceneOracle.new()


func open(path: String) -> bool:
	_file = FileAccess.open(path, FileAccess.WRITE)
	return _file != null


func record(step: int, frame: int, grid: Control, cells: Array[Control], insts: Array, viewport: Viewport) -> void:
	var window: Window = viewport as Window
	var stretch: Vector2 = window.get_stretch_transform().get_scale() if window != null else Vector2.ONE
	var window_size: Vector2i = window.size if window != null else Vector2i.ZERO
	var visible: Rect2 = viewport.get_visible_rect()
	var xform: Transform2D = viewport.canvas_transform
	var out_cells: Array = []
	var fonts: Array[Dictionary] = []
	for c: int in range(insts.size()):
		var inst: RefCounted = insts[c]
		var cell: Control = cells[c]
		var scene: Control = inst.get("scene")
		var sc: ScrollContainer = inst.get("sc")
		var vbox: Control = inst.get("vbox")
		var hud: CanvasLayer = inst.get("hud")
		var pb: ProgressBar = inst.get("pb")
		var rt: RichTextLabel = inst.get("rt")
		var le: LineEdit = inst.get("le")
		var sm_material: ShaderMaterial = inst.get("sm_material")
		var cm_material: CanvasItemMaterial = inst.get("cm_material")
		if c == 0:
			fonts = [
				{"key": "default", "font": ThemeDB.fallback_font},
				{"key": "bold", "font": rt.get_theme_font("bold_font")},
			]
		var params: Array = []
		for name: String in ["phase", "tint"]:
			var view: Dictionary = SceneOracle.variant_view(RenderingServer.material_get_param(sm_material.get_rid(), name))
			view["name"] = name
			params.append(view)
		var code: String = RenderingServer.shader_get_code(sm_material.shader.get_rid())
		out_cells.append({
			"cell": c,
			"position": [cell.position.x, cell.position.y],
			"size": [cell.size.x, cell.size.y],
			"scene_global_position": [scene.global_position.x, scene.global_position.y],
			"scroll": {
				"v_scroll": sc.scroll_vertical,
				"content_position": [vbox.position.x, vbox.position.y],
			},
			"canvas_layers": [{
				"name": "HUD",
				"layer": hud.layer,
				"sublayer": hud.get_index(),
				"visible": hud.visible,
			}],
			"materials": {
				"SM": {"shader_sha256": SceneOracle._sha256(SceneOracle.grp1(code)), "params": params},
				"CM": {"blend_mode": int(cm_material.blend_mode)},
			},
			"pb_value": pb.value,
			"rich_text": _scene._rich_text(rt),
			"line_edit": _scene._line_edit(le),
			"le_focus": le.has_focus(),
		})
	var line: Dictionary = {
		"schema": "render-stream-gate6-hd-oracle/1",
		"step": step,
		"frame": frame,
		"oversampling": viewport.get_oversampling(),
		"viewport": {
			"window_size": [window_size.x, window_size.y],
			"visible_size": [visible.size.x, visible.size.y],
			"stretch_scale": [stretch.x, stretch.y],
			"canvas_transform": [xform.x.x, xform.x.y, xform.y.x, xform.y.y, xform.origin.x, xform.origin.y],
		},
		"grid": {"position": [grid.position.x, grid.position.y], "size": [grid.size.x, grid.size.y]},
		"cells": out_cells,
		"pages": _scene._pages(fonts),
	}
	_file.store_line(JSON.stringify(line, "", false, true))
	_file.flush()
