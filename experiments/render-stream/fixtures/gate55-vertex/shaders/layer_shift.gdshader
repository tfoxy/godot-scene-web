shader_type canvas_item;

// P3-VX (VLD, in the scaled CanvasLayer): 4 local units right, before the model and canvas
// transforms.
void vertex() {
	VERTEX.x += 4.0;
}

void fragment() {
	COLOR = vec4(0.25, 0.8, 0.8, 1.0);
}
