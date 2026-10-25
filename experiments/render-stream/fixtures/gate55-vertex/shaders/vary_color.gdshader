shader_type canvas_item;

// P3-VX (VP): per-vertex COLOR (times the modulate) through a smooth varying, interpolated.
varying vec4 vc;

void vertex() {
	vc = COLOR;
}

void fragment() {
	COLOR = vc * vec4(0.9, 0.8, 1.0, 1.0);
}
