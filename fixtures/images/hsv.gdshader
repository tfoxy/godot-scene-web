// HSV tint shader: rotate hue, scale saturation, scale value, preserving alpha.
// This is the canonical shader that `packages/html/src/material.ts` (`applyHsv`)
// is a statement-for-statement port of, so a Godot render of this shader and the
// browser's baked feColorMatrix agree pixel-for-pixel. h=s=v=1.0 is identity.
shader_type canvas_item;

uniform float h = 1.0;
uniform float s = 1.0;
uniform float v = 1.0;

void fragment() {
	const mat3 rgb_to_yiq = mat3(
		vec3(0.2989, 0.5959, 0.2115),
		vec3(0.5870, -0.2774, -0.5229),
		vec3(0.1140, -0.3216, 0.3114));

	vec4 col = texture(TEXTURE, UV);

	col.rgb = rgb_to_yiq * col.rgb;

	float hue = mix(0.0, TAU, 1.0 - h);
	mat3 hue_shift = mat3(
		vec3(1.0, 0.0, 0.0),
		vec3(0.0, cos(hue), -sin(hue)),
		vec3(0.0, sin(hue), cos(hue)));
	col.rgb *= hue_shift;

	mat3 sat_shift = mat3(
		vec3(1.0, 0.0, 0.0),
		vec3(0.0, s, 0.0),
		vec3(0.0, 0.0, s));
	col.rgb = sat_shift * col.rgb;

	col.rgb = mix(vec3(0.0), col.rgb, v);

	col.rgb = inverse(rgb_to_yiq) * col.rgb;

	COLOR = col;
}
