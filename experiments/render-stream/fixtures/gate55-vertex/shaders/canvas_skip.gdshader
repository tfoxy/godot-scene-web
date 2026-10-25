shader_type canvas_item;

// P3-VX (VC, in the scaled CanvasLayer): skip_vertex_transform, MODEL_MATRIX applied by the code,
// then an eighth of CANVAS_MATRIX's translation; the canvas transform still follows the code.
render_mode skip_vertex_transform;

void vertex() {
	VERTEX = (MODEL_MATRIX * vec4(VERTEX, 0.0, 1.0)).xy + CANVAS_MATRIX[3].xy * 0.125;
}

void fragment() {
	COLOR = vec4(0.8, 0.8, 0.25, 1.0);
}
