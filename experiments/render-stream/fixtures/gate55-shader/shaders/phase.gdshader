shader_type canvas_item;

uniform int phase;

void fragment() {
	int p = phase % 6;
	COLOR = vec4(float(p) * 0.2, float(5 - p) * 0.2, 0.4, 1.0);
}
