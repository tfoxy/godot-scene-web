shader_type canvas_item;

// The ALPHA0 cell's full-screen overlay, as a game ships it: its alpha is the material's
// `threshold`, never set here (Godot's unset float, 0), so it draws a whole screen of nothing
// (README.md, ALPHA0).
uniform float threshold : hint_range(0,1);

void fragment() {
	COLOR.a = threshold;
}
