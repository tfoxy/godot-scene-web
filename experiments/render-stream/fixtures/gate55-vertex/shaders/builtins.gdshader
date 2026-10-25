shader_type canvas_item;

// P3-VX (VT): TEXTURE_PIXEL_SIZE (1/32 for the 32x32 texture) moves the rect 4 px right;
// AT_LIGHT_PASS is false and INSTANCE_CUSTOM zero for a draw that is not an instanced multimesh.
void vertex() {
	VERTEX.x += 4.0 / (TEXTURE_PIXEL_SIZE.x * 32.0);
	COLOR.rgb *= AT_LIGHT_PASS ? 0.0 : 1.0;
	COLOR.a += INSTANCE_CUSTOM.x;
}

void fragment() {
	COLOR = vec4(TEXTURE_PIXEL_SIZE * 20.0, 0.75, 1.0) * COLOR.a;
}
