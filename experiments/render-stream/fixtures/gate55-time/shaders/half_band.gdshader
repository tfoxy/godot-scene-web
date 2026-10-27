shader_type canvas_item;
// P3-CK: a fine band over a half-float alpha ramp (COLOR.a is the RGBAH texel's alpha), phased by
// TIME, as a mod() over a half-float distance field draws a glow ring.

void fragment() {
	float band = fract(COLOR.a * 32.0 + TIME * 0.5);
	COLOR = vec4(band, 0.5, 1.0 - band, 1.0);
}
