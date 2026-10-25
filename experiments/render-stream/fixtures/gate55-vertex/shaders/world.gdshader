shader_type canvas_item;

// P3-VX (VW): world_vertex_coords: VERTEX is already model-transformed when vertex() runs, so +8
// is 8 canvas pixels, not 8 local units of a 2x node.
render_mode world_vertex_coords;

void vertex() {
	VERTEX.x += 8.0;
}

void fragment() {
	COLOR = vec4(0.35, 0.15, 0.85, 1.0);
}
