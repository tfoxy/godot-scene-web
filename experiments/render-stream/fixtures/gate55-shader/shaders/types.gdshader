shader_type canvas_item;

uniform bool on;
uniform int k;
uniform float f;
uniform vec2 v2;
uniform vec3 v3;
uniform ivec2 iv;
uniform float lv[4];

void fragment() {
	COLOR = on ? vec4(v2.x, v3.y, lv[k], 1.0) : vec4(f, float(iv.y) * 0.2, 0.0, 1.0);
}
