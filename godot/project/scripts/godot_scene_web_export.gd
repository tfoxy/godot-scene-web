extends RefCounted

static func variant_to_godot_value(value: Variant) -> Variant:
	match typeof(value):
		TYPE_NIL:
			return null
		TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING:
			return value
		TYPE_STRING_NAME:
			return {"kind": "StringName", "name": str(value)}
		TYPE_VECTOR2:
			return {"kind": "Vector2", "values": [value.x, value.y]}
		TYPE_VECTOR2I:
			return {"kind": "Vector2i", "values": [value.x, value.y]}
		TYPE_VECTOR3:
			return {"kind": "Vector3", "values": [value.x, value.y, value.z]}
		TYPE_VECTOR3I:
			return {"kind": "Vector3i", "values": [value.x, value.y, value.z]}
		TYPE_VECTOR4:
			return {"kind": "Vector4", "values": [value.x, value.y, value.z, value.w]}
		TYPE_VECTOR4I:
			return {"kind": "Vector4i", "values": [value.x, value.y, value.z, value.w]}
		TYPE_COLOR:
			return {"kind": "Color", "values": [value.r, value.g, value.b, value.a]}
		TYPE_RECT2:
			return {"kind": "Rect2", "values": [value.position.x, value.position.y, value.size.x, value.size.y]}
		TYPE_RECT2I:
			return {"kind": "Rect2i", "values": [value.position.x, value.position.y, value.size.x, value.size.y]}
		TYPE_NODE_PATH:
			return {"kind": "NodePath", "path": str(value)}
		TYPE_ARRAY:
			var array_result := []
			for item in value:
				array_result.append(variant_to_godot_value(item))
			return array_result
		TYPE_DICTIONARY:
			var dictionary_result := {}
			for key in value.keys():
				dictionary_result[str(key)] = variant_to_godot_value(value[key])
			return dictionary_result
		TYPE_OBJECT:
			return _object_to_godot_value(value)
		TYPE_PACKED_VECTOR2_ARRAY:
			return _packed_vector_array("PackedVector2Array", value)
		TYPE_PACKED_VECTOR3_ARRAY:
			return _packed_vector_array("PackedVector3Array", value)
		TYPE_PACKED_COLOR_ARRAY:
			return _packed_color_array(value)
		TYPE_PACKED_STRING_ARRAY:
			return Array(value)
		TYPE_PACKED_INT32_ARRAY, TYPE_PACKED_INT64_ARRAY, TYPE_PACKED_FLOAT32_ARRAY, TYPE_PACKED_FLOAT64_ARRAY:
			return Array(value)
	return str(value)

static func scene_state_to_json(packed: PackedScene) -> Dictionary:
	var state := packed.get_state()
	var nodes := []
	for node_index in range(state.get_node_count()):
		var properties := []
		for property_index in range(state.get_node_property_count(node_index)):
			properties.append({
				"name": str(state.get_node_property_name(node_index, property_index)),
				"value": variant_to_godot_value(state.get_node_property_value(node_index, property_index))
			})
		var parent_path := str(state.get_node_path(node_index, true))
		var node_entry := {
			"index": node_index,
			"name": str(state.get_node_name(node_index)),
			"parent": "." if parent_path == "" else parent_path,
			"groups": Array(state.get_node_groups(node_index)),
			"properties": properties
		}
		var type_name := str(state.get_node_type(node_index))
		if type_name != "":
			node_entry["type"] = type_name
		var owner_path := str(state.get_node_owner_path(node_index))
		if owner_path != "":
			node_entry["owner"] = owner_path
		var instance := state.get_node_instance(node_index)
		if instance != null:
			node_entry["instance"] = _resource_to_ref(instance)
		if state.is_node_instance_placeholder(node_index):
			node_entry["instancePlaceholder"] = state.get_node_instance_placeholder(node_index)
		nodes.append(node_entry)

	var connections := []
	for connection_index in range(state.get_connection_count()):
		connections.append({
			"signal": str(state.get_connection_signal(connection_index)),
			"from": str(state.get_connection_source(connection_index)),
			"to": str(state.get_connection_target(connection_index)),
			"method": str(state.get_connection_method(connection_index)),
			"flags": state.get_connection_flags(connection_index),
			"binds": variant_to_godot_value(state.get_connection_binds(connection_index)),
			"unbinds": state.get_connection_unbinds(connection_index)
		})

	var resource_tables := _resource_tables_from_packed_scene(packed)
	var result := {
		"kind": "scene",
		"nodes": nodes,
		"connections": connections,
		"extResources": resource_tables.extResources,
		"subResources": resource_tables.subResources,
		"diagnostics": []
	}
	var base_path := state.get_path()
	if base_path != "":
		result["basePath"] = base_path
	return result

static func scene_tree_to_json(root: Node) -> Dictionary:
	var nodes := []
	_collect_node(root, ".", null, nodes)
	var viewport_size := Vector2.ZERO
	if root.get_viewport() != null:
		viewport_size = root.get_viewport().get_visible_rect().size
	return {
		"viewport": {"x": 0.0, "y": 0.0, "width": viewport_size.x, "height": viewport_size.y},
		"nodes": nodes,
		"diagnostics": []
	}

static func _collect_node(node: Node, path: String, parent_path: Variant, nodes: Array) -> void:
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
		visible = (node as CanvasItem).visible
		var visual_rect := _node_2d_visual_rect(node as Node2D)
		if visual_rect.size.x != 0.0 or visual_rect.size.y != 0.0:
			rect = {
				"x": visual_rect.position.x,
				"y": visual_rect.position.y,
				"width": visual_rect.size.x,
				"height": visual_rect.size.y
			}

	var child_paths := []
	for child in node.get_children():
		child_paths.append(str(child.name) if path == "." else path + "/" + str(child.name))
	var properties := _collect_properties(node)
	var entry := {
		"path": path,
		"name": str(node.name),
		"type": node.get_class(),
		"parentPath": parent_path,
		"children": child_paths,
		"rect": rect,
		"visible": visible,
		"zIndex": _node_z_index(node),
		"drawOrder": nodes.size(),
		"zAsRelative": _node_z_as_relative(node),
		"showBehindParent": _node_show_behind_parent(node),
		"clipContents": _node_clip_contents(node),
		"textAlign": _node_text_align(node),
		"textVerticalAlign": _node_text_vertical_align(node),
		"scale": _node_scale(node),
		"pivotOffset": _node_pivot_offset(node),
		"properties": properties,
		"resourceRefs": _collect_resource_refs(properties)
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

static func _collect_properties(node: Node) -> Dictionary:
	var properties := {}
	for property_info in node.get_property_list():
		var name := str(property_info.get("name", ""))
		var usage := int(property_info.get("usage", 0))
		if name == "" or (usage & PROPERTY_USAGE_STORAGE) == 0:
			continue
		properties[name] = variant_to_godot_value(node.get(name))
	return properties

static func _object_to_godot_value(value: Object) -> Variant:
	if value == null:
		return null
	if value is Resource:
		return _resource_to_ref(value as Resource)
	return str(value)

static func _resource_to_ref(resource: Resource) -> Dictionary:
	if resource.resource_path != "":
		return {"kind": "ExtResource", "id": resource.resource_path}
	var unique_id := resource.resource_scene_unique_id
	return {"kind": "SubResource", "id": unique_id if unique_id != "" else str(resource.get_instance_id())}

static func _resource_tables_from_packed_scene(packed: PackedScene) -> Dictionary:
	var ext_resources := []
	var sub_resources := []
	var seen := {}
	var bundled: Dictionary = packed.get("_bundled")
	for value in bundled.get("variants", []):
		if value is Resource:
			var resource := value as Resource
			var ref := _resource_to_ref(resource)
			var key := str(ref.kind) + ":" + str(ref.id)
			if seen.has(key):
				continue
			seen[key] = true
			var entry := {
				"id": str(ref.id),
				"type": resource.get_class(),
				"attributes": {"id": str(ref.id), "type": resource.get_class()},
				"properties": {}
			}
			if ref.kind == "ExtResource":
				entry["path"] = resource.resource_path
				entry["attributes"]["path"] = resource.resource_path
				ext_resources.append(entry)
			else:
				sub_resources.append(entry)
	return {"extResources": ext_resources, "subResources": sub_resources}

static func _collect_resource_refs(value: Variant) -> Array:
	var refs := []
	_collect_resource_refs_into(value, refs)
	return refs

static func _collect_resource_refs_into(value: Variant, refs: Array) -> void:
	if value is Dictionary:
		if (value.get("kind") == "ExtResource" or value.get("kind") == "SubResource") and value.has("id"):
			refs.append({"kind": value.get("kind"), "id": str(value.get("id"))})
			return
		for nested in value.values():
			_collect_resource_refs_into(nested, refs)
	elif value is Array:
		for nested in value:
			_collect_resource_refs_into(nested, refs)

static func _packed_vector_array(name: String, value: Variant) -> Dictionary:
	var args := []
	for vector in value:
		args.append(vector.x)
		args.append(vector.y)
		if name == "PackedVector3Array":
			args.append(vector.z)
	return {"kind": "Call", "name": name, "args": args}

static func _packed_color_array(value: Variant) -> Dictionary:
	var args := []
	for color in value:
		args.append(color.r)
		args.append(color.g)
		args.append(color.b)
		args.append(color.a)
	return {"kind": "Call", "name": "PackedColorArray", "args": args}

static func _node_z_index(node: Node) -> int:
	return int((node as CanvasItem).z_index) if node is CanvasItem else 0

static func _node_z_as_relative(node: Node) -> bool:
	return bool((node as CanvasItem).z_as_relative) if node is CanvasItem else true

static func _node_show_behind_parent(node: Node) -> bool:
	return bool((node as CanvasItem).show_behind_parent) if node is CanvasItem else false

static func _node_clip_contents(node: Node) -> bool:
	if node is Control:
		return bool((node as Control).clip_contents) or int((node as Control).clip_children) > 0
	return false

static func _node_text_align(node: Node) -> String:
	if node is Control and node.has_method("get"):
		var alignment := int(node.get("horizontal_alignment")) if _has_property(node, "horizontal_alignment") else 0
		if alignment == HORIZONTAL_ALIGNMENT_CENTER:
			return "center"
		if alignment == HORIZONTAL_ALIGNMENT_RIGHT:
			return "right"
		if alignment == HORIZONTAL_ALIGNMENT_FILL:
			return "fill"
	return "left"

static func _node_text_vertical_align(node: Node) -> String:
	if node is Control and node.has_method("get"):
		var alignment := int(node.get("vertical_alignment")) if _has_property(node, "vertical_alignment") else 0
		if alignment == VERTICAL_ALIGNMENT_CENTER:
			return "center"
		if alignment == VERTICAL_ALIGNMENT_BOTTOM:
			return "bottom"
		if alignment == VERTICAL_ALIGNMENT_FILL:
			return "fill"
	return "top"

static func _node_scale(node: Node) -> Dictionary:
	if node is Node2D:
		var scale_2d := (node as Node2D).scale
		return {"x": scale_2d.x, "y": scale_2d.y}
	if node is Control:
		var scale_control := (node as Control).scale
		return {"x": scale_control.x, "y": scale_control.y}
	return {"x": 1.0, "y": 1.0}

static func _node_pivot_offset(node: Node) -> Dictionary:
	if node is Control:
		var pivot := (node as Control).pivot_offset
		return {"x": pivot.x, "y": pivot.y}
	return {"x": 0.0, "y": 0.0}

static func _has_property(object: Object, property_name: String) -> bool:
	for property_info in object.get_property_list():
		if str(property_info.get("name", "")) == property_name:
			return true
	return false

static func _node_2d_visual_rect(node: Node2D) -> Rect2:
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

static func _animated_sprite_2d_rect(sprite: AnimatedSprite2D) -> Rect2:
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

static func _node_2d_global_rect(node: Node2D, local_rect: Rect2) -> Rect2:
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

static func _collect_text_runs(control: Control, rect: Dictionary) -> Array:
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

static func _collect_rich_text_runs(label: RichTextLabel, rect: Dictionary) -> Array:
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

static func _parse_rich_text_runs(text: String) -> Array:
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

static func _flush_text_run(runs: Array, text: String, style_stack: Array[String]) -> void:
	if text == "":
		return
	runs.append({"text": text, "style": _current_text_style(style_stack)})

static func _current_text_style(style_stack: Array[String]) -> String:
	var has_bold := style_stack.has("bold")
	var has_italic := style_stack.has("italic")
	if has_bold and has_italic:
		return "bold_italic"
	if has_bold:
		return "bold"
	if has_italic:
		return "italic"
	return ""

static func _pop_style(style_stack: Array[String], style: String) -> void:
	for index in range(style_stack.size() - 1, -1, -1):
		if style_stack[index] == style:
			style_stack.remove_at(index)
			return

static func _text_run_metric(control: Control, text: String, style: String, rect: Dictionary, offset_x: float) -> Dictionary:
	var font := _text_run_font(control, style)
	var font_size := _text_run_font_size(control, style)
	var size := font.get_string_size(text, HORIZONTAL_ALIGNMENT_LEFT, -1, font_size)
	return {
		"text": text,
		"style": style,
		"fontSize": font_size,
		"rect": {"x": float(rect["x"]) + offset_x, "y": float(rect["y"]), "width": size.x, "height": size.y}
	}

static func _horizontal_text_offset(control: Control, text_width: float, rect_width: float) -> float:
	var alignment := int(control.get("horizontal_alignment")) if _has_property(control, "horizontal_alignment") else HORIZONTAL_ALIGNMENT_LEFT
	if alignment == HORIZONTAL_ALIGNMENT_CENTER:
		return max(0.0, (rect_width - text_width) / 2.0)
	if alignment == HORIZONTAL_ALIGNMENT_RIGHT:
		return max(0.0, rect_width - text_width)
	return 0.0

static func _vertical_text_offset(control: Control, text_height: float, rect_height: float) -> float:
	var alignment := int(control.get("vertical_alignment")) if _has_property(control, "vertical_alignment") else VERTICAL_ALIGNMENT_TOP
	if alignment == VERTICAL_ALIGNMENT_CENTER:
		return max(0.0, (rect_height - text_height) / 2.0)
	if alignment == VERTICAL_ALIGNMENT_BOTTOM:
		return max(0.0, rect_height - text_height)
	return 0.0

static func _text_run_font(control: Control, style: String) -> Font:
	if control is RichTextLabel:
		if style == "bold":
			return control.get_theme_font("bold_font")
		if style == "italic":
			return control.get_theme_font("italics_font")
		if style == "bold_italic":
			return control.get_theme_font("bold_italics_font")
		return control.get_theme_font("normal_font")
	return control.get_theme_font("font")

static func _text_run_font_size(control: Control, style: String = "") -> int:
	if control is RichTextLabel:
		var theme_name := _rich_text_font_size_theme_name(style)
		var font_size := control.get_theme_font_size(theme_name)
		if control.has_theme_font_size_override(theme_name) and not _rich_text_has_base_font(control as RichTextLabel):
			return int(round(font_size * 0.8))
		return font_size
	return control.get_theme_font_size("font_size")

static func _rich_text_font_size_theme_name(style: String) -> String:
	if style == "bold":
		return "bold_font_size"
	if style == "italic":
		return "italics_font_size"
	if style == "bold_italic":
		return "bold_italics_font_size"
	return "normal_font_size"

static func _collect_font_metadata(control: Control) -> Dictionary:
	var names: Array[String] = []
	if control is RichTextLabel:
		names = ["normal_font", "bold_font", "italics_font", "bold_italics_font"]
	elif control is Label:
		names = ["font"]
	var result := {}
	for theme_name in names:
		result[theme_name] = _font_metadata(control.get_theme_font(theme_name))
	return result

static func _font_metadata(font: Font) -> Dictionary:
	if font == null:
		return {}
	var result := {"class": font.get_class(), "resource_path": font.resource_path}
	if font is FontVariation:
		var variation := font as FontVariation
		var base_font := variation.base_font
		result["base_font"] = _font_metadata(base_font) if base_font != null else {}
		result["variation_opentype"] = variant_to_godot_value(variation.variation_opentype)
	elif font is FontFile:
		result["font_name"] = (font as FontFile).font_name
		result["style_name"] = (font as FontFile).style_name
		result["font_weight"] = (font as FontFile).font_weight
		result["font_stretch"] = (font as FontFile).font_stretch
	return result

static func _rich_text_has_base_font(label: RichTextLabel) -> bool:
	var font := label.get_theme_font("normal_font")
	return font is FontVariation and (font as FontVariation).base_font != null
