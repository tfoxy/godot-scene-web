shader_type canvas_item;

uniform sampler2D pal : filter_nearest;
uniform vec4 mul = vec4(1.0);

void fragment() {
	COLOR = texture(pal, UV) * mul;
}
