extends SceneTree

const GodotSceneWebExport = preload("res://scripts/godot_scene_web_export.gd")

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	var fixtures := _parse_fixture_args(args)
	if fixtures.is_empty():
		push_error("Usage: godot --headless --path godot/project --script scripts/inspect_scene.gd -- --batch manifest.json")
		push_error("   or: godot --headless --path godot/project --script scripts/inspect_scene.gd -- --scene res://fixture.tscn --output out.json [--state-output state.json] [--viewport-width 1280 --viewport-height 720] [--screenshot out.png]")
		quit(2)
		return
	for fixture in fixtures:
		var exit_code := await _inspect_fixture(fixture)
		if exit_code != 0:
			quit(exit_code)
			return
	quit(0)

func _parse_fixture_args(args: PackedStringArray) -> Array:
	var batch_path := ""
	var scene_path := ""
	var output_path := ""
	var state_output_path := ""
	var screenshot_path := ""
	var viewport_width := 0
	var viewport_height := 0
	for i in range(args.size()):
		if args[i] == "--batch" and i + 1 < args.size():
			batch_path = args[i + 1]
		if args[i] == "--scene" and i + 1 < args.size():
			scene_path = args[i + 1]
		if args[i] == "--output" and i + 1 < args.size():
			output_path = args[i + 1]
		if args[i] == "--state-output" and i + 1 < args.size():
			state_output_path = args[i + 1]
		if args[i] == "--screenshot" and i + 1 < args.size():
			screenshot_path = args[i + 1]
		if args[i] == "--viewport-width" and i + 1 < args.size():
			viewport_width = int(args[i + 1])
		if args[i] == "--viewport-height" and i + 1 < args.size():
			viewport_height = int(args[i + 1])
	if batch_path != "":
		var batch_file := FileAccess.open(batch_path, FileAccess.READ)
		if batch_file == null:
			push_error("Could not open batch manifest: " + batch_path)
			return []
		var parsed: Variant = JSON.parse_string(batch_file.get_as_text())
		batch_file.close()
		if not parsed is Dictionary:
			push_error("Batch manifest must be a JSON object with a fixtures array: " + batch_path)
			return []
		var batch := parsed as Dictionary
		var manifest_fixtures: Variant = batch.get("fixtures")
		if not manifest_fixtures is Array:
			push_error("Batch manifest must be a JSON object with a fixtures array: " + batch_path)
			return []
		return manifest_fixtures
	if scene_path == "" or output_path == "":
		return []
	var fixture := {
		"scene": scene_path,
		"output": output_path,
		"stateOutput": state_output_path,
		"viewportWidth": viewport_width,
		"viewportHeight": viewport_height
	}
	if screenshot_path != "":
		fixture["screenshot"] = screenshot_path
	return [fixture]

func _inspect_fixture(fixture: Dictionary) -> int:
	var scene_path := str(fixture.get("scene", ""))
	var output_path := str(fixture.get("output", ""))
	var state_output_path := str(fixture.get("stateOutput", ""))
	var screenshot_path := str(fixture.get("screenshot", ""))
	var viewport_width := int(fixture.get("viewportWidth", 0))
	var viewport_height := int(fixture.get("viewportHeight", 0))
	if scene_path == "" or output_path == "":
		push_error("Batch fixture entries require scene and output.")
		return 2
	if viewport_width > 0 and viewport_height > 0:
		var viewport_size := Vector2i(viewport_width, viewport_height)
		DisplayServer.window_set_size(viewport_size)
		get_root().size = viewport_size
	var packed: Resource = load(scene_path)
	if packed == null or not packed is PackedScene:
		push_error("Could not load PackedScene: " + scene_path)
		return 3
	if state_output_path != "":
		var state_file: FileAccess = FileAccess.open(state_output_path, FileAccess.WRITE)
		if state_file == null:
			push_error("Could not open state output: " + state_output_path)
			return 4
		state_file.store_string(JSON.stringify(GodotSceneWebExport.scene_state_to_json(packed as PackedScene), "\t"))
		state_file.close()
	var root: Node = (packed as PackedScene).instantiate()
	get_root().add_child(root)
	await process_frame
	await process_frame
	var exported_tree := GodotSceneWebExport.scene_tree_to_json(root)
	var file: FileAccess = FileAccess.open(output_path, FileAccess.WRITE)
	if file == null:
		push_error("Could not open output: " + output_path)
		get_root().remove_child(root)
		root.queue_free()
		await process_frame
		return 4
	file.store_string(JSON.stringify(exported_tree, "\t"))
	file.close()
	if screenshot_path != "":
		var image := get_root().get_texture().get_image()
		if viewport_width > 0 and viewport_height > 0 and (image.get_width() != viewport_width or image.get_height() != viewport_height):
			image = image.get_region(Rect2i(0, 0, viewport_width, viewport_height))
		var screenshot_error := image.save_png(screenshot_path)
		if screenshot_error != OK:
			push_error("Could not write screenshot: " + screenshot_path)
			get_root().remove_child(root)
			root.queue_free()
			await process_frame
			return 5
	get_root().remove_child(root)
	root.queue_free()
	await process_frame
	return 0

func _collect_node(node: Node, path: String, parent_path: Variant, nodes: Array) -> void:
	var rect := {"x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0}
	var visible := true
	if node is Control:
		var control := node as Control
		var global_rect: Rect2 = control.get_global_rect()
		rect = {
			"x": global_rect.position.x,
			"y": global_rect.position.y,
			"width": global_rect.size.x,
			"height": global_rect.size.y
		}
		visible = control.visible
	elif node is Node2D:
		var node_2d := node as Node2D
		visible = (node as CanvasItem).visible
		var visual_rect := _node_2d_visual_rect(node_2d)
		if visual_rect.size.x != 0.0 or visual_rect.size.y != 0.0:
			rect = {
				"x": visual_rect.position.x,
				"y": visual_rect.position.y,
				"width": visual_rect.size.x,
				"height": visual_rect.size.y
			}
	var entry := {
		"path": path,
		"name": node.name,
		"type": node.get_class(),
		"parentPath": parent_path,
		"visible": visible,
		"rect": rect
	}
	if node is Control:
		var text_runs := _collect_text_runs(node as Control, rect)
		if not text_runs.is_empty():
			entry["textRuns"] = text_runs
		var font_metadata := _collect_font_metadata(node as Control)
		if not font_metadata.is_empty():
			entry["fontMetadata"] = font_metadata
	nodes.append(entry)
	for child in node.get_children():
		var child_path := str(child.name) if path == "." else path + "/" + str(child.name)
		_collect_node(child, child_path, path, nodes)

func _node_2d_visual_rect(node: Node2D) -> Rect2:
	if node is AnimatedSprite2D:
		return _node_2d_global_rect(node, _animated_sprite_2d_rect(node as AnimatedSprite2D))
	if node is Sprite2D:
		return _node_2d_global_rect(node, (node as Sprite2D).get_rect())
	if node is Line2D:
		var line := node as Line2D
		var points: PackedVector2Array = line.points
		if points.size() < 2:
			return Rect2()
		var min_x: float = points[0].x
		var min_y: float = points[0].y
		var max_x: float = points[0].x
		var max_y: float = points[0].y
		for point in points:
			min_x = min(min_x, point.x)
			min_y = min(min_y, point.y)
			max_x = max(max_x, point.x)
			max_y = max(max_y, point.y)
		var pad: float = max(1.0, line.width)
		return _node_2d_global_rect(node, Rect2(min_x - pad / 2.0, min_y - pad / 2.0, max(1.0, max_x - min_x + pad), max(1.0, max_y - min_y + pad)))
	if node is GPUParticles2D:
		return _node_2d_global_rect(node, (node as GPUParticles2D).visibility_rect)
	if node is CPUParticles2D:
		var texture: Texture2D = (node as CPUParticles2D).texture
		var texture_size: Vector2 = texture.get_size() if texture != null else Vector2(16.0, 16.0)
		var width: float = max(32.0, texture_size.x * 4.0)
		var height: float = max(32.0, texture_size.y * 4.0)
		return _node_2d_global_rect(node, Rect2(-width / 2.0, -height / 2.0, width, height))
	return Rect2()

func _animated_sprite_2d_rect(sprite: AnimatedSprite2D) -> Rect2:
	var frames := sprite.sprite_frames
	if frames == null or not frames.has_animation(sprite.animation):
		return Rect2()
	var frame_count := frames.get_frame_count(sprite.animation)
	if sprite.frame < 0 or sprite.frame >= frame_count:
		return Rect2()
	var texture := frames.get_frame_texture(sprite.animation, sprite.frame)
	if texture == null:
		return Rect2()
	var size := texture.get_size()
	var offset := sprite.offset
	if sprite.centered:
		offset -= size / 2.0
	if size == Vector2.ZERO:
		size = Vector2(1.0, 1.0)
	return Rect2(offset, size)

func _node_2d_global_rect(node: Node2D, local_rect: Rect2) -> Rect2:
	if local_rect.size.x == 0.0 and local_rect.size.y == 0.0:
		return Rect2()
	var transform := node.get_global_transform()
	var points: Array[Vector2] = [
		transform * local_rect.position,
		transform * (local_rect.position + Vector2(local_rect.size.x, 0.0)),
		transform * (local_rect.position + Vector2(0.0, local_rect.size.y)),
		transform * (local_rect.position + local_rect.size)
	]
	var min_x: float = points[0].x
	var min_y: float = points[0].y
	var max_x: float = points[0].x
	var max_y: float = points[0].y
	for point in points:
		min_x = min(min_x, point.x)
		min_y = min(min_y, point.y)
		max_x = max(max_x, point.x)
		max_y = max(max_y, point.y)
	return Rect2(min_x, min_y, max_x - min_x, max_y - min_y)

func _collect_text_runs(control: Control, rect: Dictionary) -> Array:
	if control is RichTextLabel:
		return _collect_rich_text_runs(control as RichTextLabel, rect)
	if control is Label:
		var text := str(control.get("text"))
		if text == "":
			return []
		var run := _text_run_metric(control, text, "", {"x": 0.0, "y": 0.0}, 0.0)
		run["rect"]["x"] = float(rect["x"]) + _horizontal_text_offset(control, float(run["rect"]["width"]), float(rect["width"]))
		run["rect"]["y"] = float(rect["y"]) + _vertical_text_offset(control, float(run["rect"]["height"]), float(rect["height"]))
		return [run]
	return []

func _collect_rich_text_runs(label: RichTextLabel, rect: Dictionary) -> Array:
	var text := str(label.get("text"))
	if text == "":
		return []
	var parsed_runs := _parse_rich_text_runs(text) if bool(label.get("bbcode_enabled")) else [{"text": text, "style": ""}]
	var runs: Array = []
	var cursor_x := 0.0
	var max_height := 0.0
	for run in parsed_runs:
		var run_text := str(run["text"])
		if run_text == "":
			continue
		var style := str(run["style"])
		runs.append(_text_run_metric(label, run_text, style, {"x": 0.0, "y": 0.0}, cursor_x))
		cursor_x += float(runs.back()["rect"]["width"])
		max_height = max(max_height, float(runs.back()["rect"]["height"]))
	var aligned_x := float(rect["x"]) + _horizontal_text_offset(label, cursor_x, float(rect["width"]))
	var aligned_y := float(rect["y"]) + _vertical_text_offset(label, max_height, float(rect["height"]))
	for run in runs:
		run["rect"]["x"] = aligned_x + float(run["rect"]["x"])
		run["rect"]["y"] = aligned_y
	return runs

func _parse_rich_text_runs(text: String) -> Array:
	var runs: Array = []
	var buffer := ""
	var style_stack: Array[String] = []
	var i := 0
	while i < text.length():
		if text.substr(i, 3) == "[b]":
			_flush_text_run(runs, buffer, style_stack)
			buffer = ""
			style_stack.push_back("bold")
			i += 3
		elif text.substr(i, 4) == "[/b]":
			_flush_text_run(runs, buffer, style_stack)
			buffer = ""
			_pop_style(style_stack, "bold")
			i += 4
		elif text.substr(i, 3) == "[i]":
			_flush_text_run(runs, buffer, style_stack)
			buffer = ""
			style_stack.push_back("italic")
			i += 3
		elif text.substr(i, 4) == "[/i]":
			_flush_text_run(runs, buffer, style_stack)
			buffer = ""
			_pop_style(style_stack, "italic")
			i += 4
		else:
			buffer += text.substr(i, 1)
			i += 1
	_flush_text_run(runs, buffer, style_stack)
	return runs

func _flush_text_run(runs: Array, text: String, style_stack: Array[String]) -> void:
	if text == "":
		return
	runs.append({
		"text": text,
		"style": _current_text_style(style_stack)
	})

func _current_text_style(style_stack: Array[String]) -> String:
	var has_bold := style_stack.has("bold")
	var has_italic := style_stack.has("italic")
	if has_bold and has_italic:
		return "bold_italic"
	if has_bold:
		return "bold"
	if has_italic:
		return "italic"
	return ""

func _pop_style(style_stack: Array[String], style: String) -> void:
	for index in range(style_stack.size() - 1, -1, -1):
		if style_stack[index] == style:
			style_stack.remove_at(index)
			return

func _text_run_metric(control: Control, text: String, style: String, rect: Dictionary, offset_x: float) -> Dictionary:
	var font := _text_run_font(control, style)
	var font_size := _text_run_font_size(control, style)
	var size := font.get_string_size(text, HORIZONTAL_ALIGNMENT_LEFT, -1, font_size)
	return {
		"text": text,
		"style": style,
		"fontSize": font_size,
		"rect": {
			"x": float(rect["x"]) + offset_x,
			"y": float(rect["y"]),
			"width": size.x,
			"height": size.y
		}
	}

func _horizontal_text_offset(control: Control, text_width: float, rect_width: float) -> float:
	var alignment := int(control.get("horizontal_alignment"))
	if alignment == HORIZONTAL_ALIGNMENT_CENTER:
		return max(0.0, (rect_width - text_width) / 2.0)
	if alignment == HORIZONTAL_ALIGNMENT_RIGHT:
		return max(0.0, rect_width - text_width)
	return 0.0

func _vertical_text_offset(control: Control, text_height: float, rect_height: float) -> float:
	var alignment := int(control.get("vertical_alignment"))
	if alignment == VERTICAL_ALIGNMENT_CENTER:
		return max(0.0, (rect_height - text_height) / 2.0)
	if alignment == VERTICAL_ALIGNMENT_BOTTOM:
		return max(0.0, rect_height - text_height)
	return 0.0

func _text_run_font(control: Control, style: String) -> Font:
	if control is RichTextLabel:
		if style == "bold":
			return control.get_theme_font("bold_font")
		if style == "italic":
			return control.get_theme_font("italics_font")
		if style == "bold_italic":
			return control.get_theme_font("bold_italics_font")
		return control.get_theme_font("normal_font")
	return control.get_theme_font("font")

func _text_run_font_size(control: Control, style: String = "") -> int:
	if control is RichTextLabel:
		var theme_name := _rich_text_font_size_theme_name(style)
		var font_size := control.get_theme_font_size(theme_name)
		if control.has_theme_font_size_override(theme_name) and not _rich_text_has_base_font(control as RichTextLabel):
			return int(round(font_size * 0.8))
		return font_size
	return control.get_theme_font_size("font_size")

func _rich_text_font_size_theme_name(style: String) -> String:
	if style == "bold":
		return "bold_font_size"
	if style == "italic":
		return "italics_font_size"
	if style == "bold_italic":
		return "bold_italics_font_size"
	return "normal_font_size"

func _collect_font_metadata(control: Control) -> Dictionary:
	var names: Array[String] = []
	if control is RichTextLabel:
		names = ["normal_font", "bold_font", "italics_font", "bold_italics_font"]
	elif control is Label:
		names = ["font"]
	var result := {}
	for theme_name in names:
		result[theme_name] = _font_metadata(control.get_theme_font(theme_name))
	return result

func _font_metadata(font: Font) -> Dictionary:
	if font == null:
		return {}
	var result := {
		"class": font.get_class(),
		"resource_path": font.resource_path
	}
	if font is FontVariation:
		var variation := font as FontVariation
		var base_font := variation.base_font
		result["base_font"] = _font_metadata(base_font) if base_font != null else {}
		result["variation_opentype"] = variation.variation_opentype
	elif font is FontFile:
		result["font_name"] = (font as FontFile).font_name
		result["style_name"] = (font as FontFile).style_name
		result["font_weight"] = (font as FontFile).font_weight
		result["font_stretch"] = (font as FontFile).font_stretch
	return result

func _rich_text_has_base_font(label: RichTextLabel) -> bool:
	var font := label.get_theme_font("normal_font")
	return font is FontVariation and (font as FontVariation).base_font != null
