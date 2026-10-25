shader_type canvas_item;

// P3-VX (VU): UV transposed and flipped in vertex(); fragment() is Godot's default.
void vertex() {
	UV = vec2(1.0) - UV.yx;
}
