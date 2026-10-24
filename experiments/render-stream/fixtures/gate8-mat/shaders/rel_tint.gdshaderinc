// gate8-mat (G8m): included by a path relative to rel.gdshader, which only resolves against the
// original resource's path (gate8-design.md Q5's shader-adopt-include case).
vec4 rel_tinted(vec4 c, vec4 t) {
	return vec4(c.rgb * t.rgb, 1.0);
}
