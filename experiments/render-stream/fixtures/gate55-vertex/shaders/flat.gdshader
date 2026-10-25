shader_type canvas_item;

// P3-VX (VF): flat varyings take the provoking (last) vertex of each triangle. GLES3 draws a rect
// through the indexed quad {0, 2, 1, 3, 2, 0} over vertex_base (0,0) (0,1) (1,1) (1,0)
// (rasterizer_canvas_gles3.cpp:2819), so the lower-left triangle ends on (0, 1) and the
// upper-right one on (0, 0): two solid triangles, (0, .75, .25) and (0, 0, .25).
varying flat vec4 corner;
varying flat int column;

void vertex() {
	corner = vec4(VERTEX / 64.0 * 0.75, 0.25, 1.0);
	column = int(VERTEX.x) / 64;
}

void fragment() {
	COLOR = corner;
	COLOR.b += float(column) * 0.375;
}
