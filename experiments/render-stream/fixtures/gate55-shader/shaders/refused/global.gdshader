shader_type canvas_item;

global uniform vec4 g_tint;

void fragment() {
	COLOR = vec4(g_tint.rgb, 1.0);
}
