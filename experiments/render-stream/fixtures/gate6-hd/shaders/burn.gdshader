shader_type canvas_item;

uniform int iterations;

void fragment() {
	float acc = 0.0;
	vec2 p = UV;
	for (int i = 0; i < iterations; i++) {
		acc += fract(sin(dot(p, vec2(12.9898, 78.233)) + float(i)) * 43758.5453);
		p += vec2(0.001 * acc, 0.0);
	}
	COLOR = vec4(0.0, 0.0, 0.0, step(1e9, acc));
}
