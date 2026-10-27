shader_type canvas_item;
// P3-CK: the shader time as bytes. v = floor(TIME * 1024) (1/1024 s units), written as
// (v >> 16, v >> 8, v) & 255 in RGB; every step is exact in binary32 (powers of two).

void fragment() {
	float v = floor(TIME * 1024.0);
	float r = mod(floor(v / 65536.0), 256.0);
	float g = mod(floor(v / 256.0), 256.0);
	float b = mod(v, 256.0);
	COLOR = vec4(r / 255.0, g / 255.0, b / 255.0, 1.0);
}
