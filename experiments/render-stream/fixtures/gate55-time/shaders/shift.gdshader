shader_type canvas_item;
// P3-TM: TIME in vertex(): a whole-pixel shift down, clear of pixel-centre ties.
void vertex() {
	VERTEX.y += floor(TIME * 30.0 + 0.25);
}

void fragment() {
	COLOR = vec4(0.25, 0.8, 0.6, 1.0);
}
