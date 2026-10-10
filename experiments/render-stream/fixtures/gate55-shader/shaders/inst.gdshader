shader_type canvas_item;

instance uniform vec4 inst_color = vec4(1.0);

void fragment() {
	COLOR = vec4(inst_color.rgb, 1.0);
}
