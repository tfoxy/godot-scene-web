shader_type canvas_item;

#include "res://inc/tint.gdshaderinc"

uniform vec4 tint = vec4(1.0);
uniform sampler2D pal : filter_nearest;
instance uniform vec4 inst = vec4(1.0);

void fragment() {
	COLOR = tinted(texture(pal, UV), tint) * inst;
}
