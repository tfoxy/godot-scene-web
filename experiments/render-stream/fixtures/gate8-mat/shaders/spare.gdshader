shader_type canvas_item;

#include "res://inc/tint.gdshaderinc"

uniform vec4 tint = vec4(1.0);
uniform sampler2D pal : filter_nearest;

void fragment() {
	COLOR = tinted(texture(pal, UV), tint);
}
