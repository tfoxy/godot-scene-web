# Parser

The parser accepts Godot text resources such as `.tscn` and `.tres` and returns a Godot-like AST.

## Preserved Shape

The parser keeps Godot names and values close to the source file:

```ini
[node name="Panel" type="Control" parent="."]
layout_mode = 1
anchors_preset = 15
offset_left = 10.0
```

becomes properties named `layout_mode`, `anchors_preset`, and `offset_left`. The parser does not expand `anchors_preset = 15` into anchor fields.

## Supported Syntax

V1 supports:

- document headers: `[gd_scene ...]`, `[gd_resource ...]`
- sections: `[ext_resource ...]`, `[sub_resource ...]`, `[node ...]`, `[connection ...]`
- scalar values: strings, numbers, booleans, `null` / `nil`
- arrays and dictionaries
- common constructors: `Color(...)`, `Vector2(...)`, `Vector2i(...)`, `Rect2(...)`, `NodePath(...)`, `ExtResource(...)`, `SubResource(...)`

Unsupported syntax should produce diagnostics with line information where possible.

## Rule

If a value is layout- or renderer-specific, it belongs outside the parser.
