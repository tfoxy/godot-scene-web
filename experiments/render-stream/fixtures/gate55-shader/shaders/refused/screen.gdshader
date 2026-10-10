shader_type canvas_item;

uniform sampler2D screen_tex : hint_screen_texture, filter_nearest;

void fragment() {
	COLOR = vec4(vec3(1.0) - texture(screen_tex, SCREEN_UV).rgb, 1.0);
}
