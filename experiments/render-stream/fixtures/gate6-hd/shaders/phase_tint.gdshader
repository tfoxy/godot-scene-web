shader_type canvas_item;

uniform int phase;
uniform vec4 tint;

void fragment() {
	COLOR = vec4(tint.rgb * (float(phase % 6) * 0.2), 1.0);
}
