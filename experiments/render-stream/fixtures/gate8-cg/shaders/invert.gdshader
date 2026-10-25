shader_type canvas_item;

// CG1: the inverse of the back buffer under the fragment (fixtures/gate55-screen's invert, at level
// 0: the screen sampler's own state is linear, so the copy is read at texel centres, exact).
uniform sampler2D screen_tex : hint_screen_texture, filter_nearest;

void fragment() {
	COLOR = vec4(vec3(1.0) - textureLod(screen_tex, SCREEN_UV, 0.0).rgb, 1.0);
}
