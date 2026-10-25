shader_type canvas_item;

// P3-VX (VS2): skip_vertex_transform, the code applying MODEL_MATRIX itself and shifting 8 down.
render_mode skip_vertex_transform;

void vertex() {
	VERTEX = (MODEL_MATRIX * vec4(VERTEX, 0.0, 1.0)).xy + vec2(0.0, 8.0);
}

void fragment() {
	COLOR = vec4(0.15, 0.85, 0.35, 1.0);
}
