shader_type canvas_item;

// P3-ST: the back buffer under the fragment with its channels rotated (nearest: exact).
uniform sampler2D screen_tex : hint_screen_texture, filter_nearest;

void fragment() {
	COLOR = vec4(texture(screen_tex, SCREEN_UV).gbr, 1.0);
}
