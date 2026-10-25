shader_type canvas_item;

// P3-VX (VD): VERTEX displaced in item-local space, before the model transform: the right edge
// moves down 8 local units (the node is scaled 2x), so the top and bottom edges slope 1/4.
void vertex() {
	VERTEX.y += floor(VERTEX.x / 32.0) * 8.0;
}
