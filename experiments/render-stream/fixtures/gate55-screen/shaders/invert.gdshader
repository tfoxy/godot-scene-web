shader_type canvas_item;

// P3-ST: the inverse of the back buffer under the fragment (nearest: one texel, exact).
uniform sampler2D screen_tex : hint_screen_texture, filter_nearest;

void fragment() {
	COLOR = vec4(vec3(1.0) - texture(screen_tex, SCREEN_UV).rgb, 1.0);
}
