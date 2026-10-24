shader_type canvas_item;

#include "rel_tint.gdshaderinc"

uniform vec4 tint = vec4(1.0);

void fragment() {
	COLOR = rel_tinted(COLOR, tint);
}
