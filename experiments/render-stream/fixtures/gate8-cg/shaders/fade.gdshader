shader_type canvas_item;

// The ALPHA0 cell's fading screen reader: the inverse of the back buffer under the fragment (at
// level 0, as invert.gdshader reads it), at the alpha the material's `threshold` sets. At 0 it is
// invisible but still reads the screen; step 2 raises it to 0.5 (README.md, ALPHA0).
uniform float threshold : hint_range(0,1) = 0.0;
uniform sampler2D screen_tex : hint_screen_texture, filter_nearest;

void fragment() {
	COLOR = vec4(vec3(1.0) - textureLod(screen_tex, SCREEN_UV, 0.0).rgb, 1.0);
	COLOR.a = threshold;
}
