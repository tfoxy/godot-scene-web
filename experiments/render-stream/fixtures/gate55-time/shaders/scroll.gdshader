shader_type canvas_item;
// P3-TM: UV scrolling with TIME over a repeating, linearly filtered texture.
uniform sampler2D stripes : repeat_enable, filter_linear;

void fragment() {
	COLOR = texture(stripes, UV * 3.0 + vec2(TIME * 0.37, TIME * 0.11));
}
