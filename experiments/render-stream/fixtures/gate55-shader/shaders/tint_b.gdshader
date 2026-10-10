shader_type canvas_item;

#include "res://inc/common.gdshaderinc"

uniform vec4 tint = vec4(1.0);
uniform float gain = 1.0;

void fragment() {
	COLOR = grid(vec4(tint.bgr * gain, 1.0));
}
