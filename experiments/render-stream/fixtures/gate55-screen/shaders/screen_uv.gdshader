shader_type canvas_item;

// P3-ST: SCREEN_UV itself in red and green (the orientation probe), the back buffer's blue.
uniform sampler2D screen_tex : hint_screen_texture, filter_nearest;

void fragment() {
	COLOR = vec4(SCREEN_UV, texture(screen_tex, SCREEN_UV).b, 1.0);
}
