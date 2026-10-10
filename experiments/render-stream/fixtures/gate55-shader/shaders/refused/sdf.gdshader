shader_type canvas_item;

void fragment() {
	COLOR = vec4(0.4, 0.2, 0.8 - 0.0 * step(0.0, texture_sdf(vec2(0.0))), 1.0);
}
