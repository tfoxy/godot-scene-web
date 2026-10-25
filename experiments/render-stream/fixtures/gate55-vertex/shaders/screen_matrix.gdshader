shader_type canvas_item;

// P3-VX (VM): the clip-space position SCREEN_MATRIX * CANVAS_MATRIX * MODEL_MATRIX gives, through
// a smooth varying, as red and green.
varying vec2 clip;

void vertex() {
	clip = (SCREEN_MATRIX * CANVAS_MATRIX * MODEL_MATRIX * vec4(VERTEX, 0.0, 1.0)).xy;
}

void fragment() {
	COLOR = vec4(clip * 0.5 + 0.5, 0.5, 1.0);
}
