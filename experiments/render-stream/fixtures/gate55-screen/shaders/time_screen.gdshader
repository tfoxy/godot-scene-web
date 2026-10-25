shader_type canvas_item;

// P3-ST: a screen reader the capture refuses (it reads TIME: shader-time). The reference draws the
// inverse of the back buffer (TIME contributes nothing); a receiver drops the item, per
// gate5_5-design.md "Refused materials", so the back buffer itself shows there.
uniform sampler2D screen_tex : hint_screen_texture, filter_nearest;

void fragment() {
	COLOR = vec4(vec3(1.0) - texture(screen_tex, SCREEN_UV).rgb + vec3(0.0 * TIME), 1.0);
}
