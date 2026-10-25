shader_type canvas_item;
// P3-TM: a sampler left unset: GLES3 binds its default texture
// (material_storage.cpp:928-953). Every default is told apart: alpha goes to green.
uniform sampler2D s;

void fragment() {
	vec4 t = texture(s, UV);
	COLOR = vec4(t.r, t.g * 0.5 + t.a * 0.5, t.b, 1.0);
}
