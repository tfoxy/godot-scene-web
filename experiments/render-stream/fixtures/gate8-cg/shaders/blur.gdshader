shader_type canvas_item;

// The cover cell's screen reader: the back buffer two mip levels down, mixed into the reader's
// colour, as a full-screen blur reads it. Reading mipmaps makes GLES3 take the whole-target copy
// with its gaussian mip chain; the cell's opaque cover then hides the reader (README.md, COVER).
uniform sampler2D screen_tex : hint_screen_texture, filter_linear_mipmap;

void fragment() {
	COLOR = vec4(mix(COLOR.rgb, textureLod(screen_tex, SCREEN_UV, 2.0).rgb, 0.7), 1.0);
}
