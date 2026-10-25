shader_type canvas_item;

// P3-VX (VS1): skip_vertex_transform without vertex(): GLES3 never applies the model matrix, so
// the rect lands at its item-local coordinates.
render_mode skip_vertex_transform;

void fragment() {
	COLOR = vec4(0.85, 0.35, 0.15, 1.0);
}
