shader_type canvas_item;

// P3-ST: a blur-and-tint post effect, the shape of a menu backdrop: the back buffer's blurred
// mip level `lod` (a mipmap filter makes GLES3 build the back buffer's gaussian mip chain), mixed
// toward `tint` by `mix_amount`.
uniform sampler2D screen_tex : hint_screen_texture, filter_linear_mipmap;
uniform float lod = 2.0;
uniform vec4 tint : source_color = vec4(0.2, 0.4, 0.6, 1.0);
uniform float mix_amount = 0.0;

void fragment() {
	vec3 blurred = textureLod(screen_tex, SCREEN_UV, lod).rgb;
	COLOR = vec4(mix(blurred, tint.rgb, mix_amount), 1.0);
}
