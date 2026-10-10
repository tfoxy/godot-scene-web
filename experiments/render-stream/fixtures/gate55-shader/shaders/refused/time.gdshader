shader_type canvas_item;

void fragment() {
	COLOR = vec4(0.2, 0.4, 0.6 - 0.0 * step(0.0, TIME), 1.0);
}
