// gate8-mat (G8m): included by res:// path from main.gdshader and spare.gdshader, so the code the
// RenderingServer receives (preprocessed, with @@> / @@< markers) differs from Shader.get_code().
vec4 tinted(vec4 c, vec4 t) {
	return vec4(c.rgb * t.rgb, 1.0);
}
