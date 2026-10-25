shader_type canvas_item;
// P3-TM: a sine pulse in TIME, read through a helper (TIME in this comment is not a use).
uniform vec4 tint = vec4(1.0, 0.5, 0.25, 1.0);

float pulse() {
	return 0.5 + 0.5 * sin(TIME * 3.0);
}

void fragment() {
	float p = pulse();
	COLOR = vec4(tint.r * p, tint.g, tint.b * (1.0 - p), 1.0);
}
