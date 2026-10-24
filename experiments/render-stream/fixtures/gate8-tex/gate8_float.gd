extends Node
## Gate 8 float fixture (G8f, gate8-design.md D9 and Q3 "Compressed and float textures"). It models
## the STS2 census' float textures: small curve and gradient textures (at most 256 px wide), most of
## them made on a loader thread, used as shader inputs. Everything is created after arm.
##
## Textures (all float; `*` = made on a loader Thread, the rest on the main thread):
##
##   curve_rf          CurveTexture, texture_mode RED          RF    256x1   engine, deferred update
##   curve_rgb         CurveTexture, texture_mode RGB          RGBF  256x1   engine, deferred update
##   curve_xyz         CurveXYZTexture                         RGBF  256x1   engine, deferred update
##   grad_hdr          GradientTexture1D use_hdr               RGBAF 256x1   engine, deferred update
##   img_rgf*          Image 16x16 (values < 0 and > 1)        RGF   16x16
##   img_rh*           Image 16x16                             RH    16x16
##   img_rgh*          Image 16x16                             RGH   16x16
##   img_rgbh*         Image 16x16 (one value 2.0)             RGBH  16x16
##   img_rgbaf_mip*    Image 16x16 with mipmaps                RGBAF 16x16 + 5 mips
##   img_rgbah*        Image 16x16                             RGBAH 16x16
##   img_rf_odd*       Image 5x3 with mipmaps                  RF    5x3 + 2 mips
##   hdr_bptc          the imported hdr.exr (BPTC_RGBFU)       decoded to RGBH 16x16 (BC6H)
##   hdr_astc          the imported hdr.exr (ASTC_4x4_HDR)     decoded to RGBAH 16x16
##
## Every texture is a shader input of a ColorRect (a canvas_item shader that samples it nearest and
## clamps), and three images are also drawn by a plain Sprite2D. Step 0 is frame S (`_ready`); step 1
## (frame S+N) changes the curves (CurveTexture/CurveXYZTexture texture_2d_update), the gradient's
## width (create + texture_replace) and ImageTexture.update on img_rh and img_rgbah. A step is
## settled at its frame + 7. The hdr textures need the imports (run-gate8.sh's import leg).
##
## The independent oracle: each texture's expected GRT1 payload is built here from the engine's
## GDScript-visible values (Curve.sample_baked, Gradient.sample, the image the fixture
## made, Image.decompress of the .ctex) by payload.gd, a second encoder, and its SHA-256 logged.
## check-gate8.ts compares these with the hashes the capture computed at the hook (`float-oracle`).
##
## Environment (all optional; the names are gate8_tex.gd's):
##   RS_FIXTURE_SOURCE       ctex (default): the hdr textures are the imported .ctex files (the
##                           capture decodes them); decoded: plain half-float ImageTextures made
##                           from RS_FIXTURE_DECODED_DIR/<hdr_bptc|hdr_astc>.grt1 (the `reference`)
##   RS_FIXTURE_DECODED_DIR  absolute dir: a ctex run's RS_FIXTURE_HDR_DUMP (RS_FIXTURE_SOURCE=decoded)
##   RS_FIXTURE_HDR_DUMP     absolute dir: write this process's own Image.decompress of each imported
##                           hdr image there as <name>.grt1 (a headless run: the engine's decoder)
##   RS_FIXTURE_STEP_LOG     absolute path: one JSONL line per step
##   RS_FIXTURE_TEXTURE_LOG  absolute path: one JSONL line per texture state per step
##   RS_FIXTURE_SHOT_DIR     absolute dir: step-<k>.png at each settle frame (rendered runs only)
##   RS_FIXTURE_START_FRAME  S >= 1, default 1
##   RS_FIXTURE_STEP_FRAMES  N >= 8, default 10
##   RS_FIXTURE_QUIT_FRAME   >= S+N+11 (the default)

const Textures := preload("res://textures.gd")
const Payload := preload("res://payload.gd")

const START_FRAME_DEFAULT: int = 1
const STEP_FRAMES_DEFAULT: int = 10
const SETTLE_OFFSET: int = 7
const LAST_STEP: int = 1
const CURVE_WIDTH: int = 256

const VIEW_SHADER_CODE: String = """shader_type canvas_item;
uniform sampler2D src : filter_nearest, repeat_disable;
uniform float gain = 1.0;
uniform int channel = 0;
void fragment() {
	vec4 c = texture(src, UV);
	vec3 v = channel == 1 ? vec3(c.a) : c.rgb;
	COLOR = vec4(clamp(v * gain, 0.0, 1.0), 1.0);
}
"""

var _source: String = "ctex"
var _decoded_dir: String = ""
var _hdr_dump_dir: String = ""
var _frame: int = 0
var _start_frame: int = START_FRAME_DEFAULT
var _step_frames: int = STEP_FRAMES_DEFAULT
var _quit_frame: int = 0
var _shot_dir: String = ""
var _step_log_file: FileAccess
var _texture_log_file: FileAccess
var _failed: bool = false
var _view_shader: Shader
## name -> Texture2D (current)
var _textures: Dictionary = {}
var _curve_rf: Curve
var _curve_rgb: Curve
var _curves_xyz: Array[Curve] = []
var _curve_xyz_texture: CurveXYZTexture
var _gradient: Gradient
var _gradient_texture: GradientTexture1D
var _loader_images: Dictionary = {}
var _loader_textures: Dictionary = {}
var _logged_step: Dictionary = {}


func _ready() -> void:
	if not _read_environment():
		_failed = true
		get_tree().quit(2)
		return
	_view_shader = Shader.new()
	_view_shader.code = VIEW_SHADER_CODE
	_make_engine_textures()
	_make_loader_textures()
	_make_hdr_textures()
	_build_scene()
	_log_step(0, 1, _start_frame + SETTLE_OFFSET)
	print("[fixture] gate8-float ready: S=%d N=%d quit=%d source=%s" % [_start_frame, _step_frames, _quit_frame, _source])


func _process(_delta: float) -> void:
	if _failed:
		return
	_frame += 1
	# The engine textures' deferred updates have run by frame 2: log what each was built from.
	if _frame == 2 and not _logged_step.has(0):
		_log_expected(0)
	if _frame == _start_frame + _step_frames:
		_apply_step_1()
		_log_step(1, _frame, _frame + SETTLE_OFFSET)
	if _frame == _start_frame + _step_frames + 2 and not _logged_step.has(1):
		_log_expected(1)
	if _frame == _start_frame + SETTLE_OFFSET:
		_maybe_take_shot("step-0.png")
	if _frame == _start_frame + _step_frames + SETTLE_OFFSET:
		_maybe_take_shot("step-1.png")
	if _frame >= _quit_frame:
		print("[fixture] quitting frame=%d" % _frame)
		get_tree().quit(0)


# ------------------------------------------------------------------------------ the textures

func _make_engine_textures() -> void:
	_curve_rf = Curve.new()
	_curve_rf.min_value = 0.0
	_curve_rf.max_value = 2.0  # values above 1 clamp when a receiver quantizes
	_curve_rf.add_point(Vector2(0.0, 0.0))
	_curve_rf.add_point(Vector2(0.5, 1.5))
	_curve_rf.add_point(Vector2(1.0, 0.25))
	var rf := CurveTexture.new()
	rf.width = CURVE_WIDTH
	rf.texture_mode = CurveTexture.TEXTURE_MODE_RED
	rf.curve = _curve_rf
	_textures["curve_rf"] = rf

	_curve_rgb = Curve.new()
	_curve_rgb.add_point(Vector2(0.0, 1.0))
	_curve_rgb.add_point(Vector2(1.0, 0.0))
	var rgb := CurveTexture.new()
	rgb.width = CURVE_WIDTH
	rgb.texture_mode = CurveTexture.TEXTURE_MODE_RGB
	rgb.curve = _curve_rgb
	_textures["curve_rgb"] = rgb

	var cx := Curve.new()
	cx.add_point(Vector2(0.0, 0.0))
	cx.add_point(Vector2(1.0, 1.0))
	var cy := Curve.new()
	cy.add_point(Vector2(0.0, 1.0))
	cy.add_point(Vector2(0.5, 0.0))
	cy.add_point(Vector2(1.0, 1.0))
	var cz := Curve.new()
	cz.min_value = -1.0
	cz.max_value = 1.0
	cz.add_point(Vector2(0.0, -1.0))
	cz.add_point(Vector2(1.0, 1.0))
	_curves_xyz = [cx, cy, cz]
	_curve_xyz_texture = CurveXYZTexture.new()
	_curve_xyz_texture.width = CURVE_WIDTH
	_curve_xyz_texture.curve_x = cx
	_curve_xyz_texture.curve_y = cy
	_curve_xyz_texture.curve_z = cz
	_textures["curve_xyz"] = _curve_xyz_texture

	_gradient = Gradient.new()
	_gradient.set_color(0, Color(2.0, 0.5, 0.1, 1.0))
	_gradient.set_color(1, Color(0.0, 1.0, 3.0, 0.5))
	_gradient_texture = GradientTexture1D.new()
	_gradient_texture.width = CURVE_WIDTH
	_gradient_texture.use_hdr = true
	_gradient_texture.gradient = _gradient
	_textures["grad_hdr"] = _gradient_texture


func _make_loader_textures() -> void:
	# The STS2 pattern: the images are built, and their ImageTextures created, on a loader thread
	# (texture_2d_create from a non-main thread); the main thread only collects them.
	var thread := Thread.new()
	thread.start(_loader_main)
	thread.wait_to_finish()
	for name: String in _loader_textures:
		_textures[name] = _loader_textures[name]


func _loader_main() -> void:
	for spec: Dictionary in _image_specs():
		var name: String = spec["name"]
		var image: Image = _build_image(spec)
		_loader_images[name] = image
		_loader_textures[name] = ImageTexture.create_from_image(image)


func _image_specs() -> Array[Dictionary]:
	return [
		{"name": "img_rgf", "format": Image.FORMAT_RGF, "w": 16, "h": 16, "mips": false},
		{"name": "img_rh", "format": Image.FORMAT_RH, "w": 16, "h": 16, "mips": false},
		{"name": "img_rgh", "format": Image.FORMAT_RGH, "w": 16, "h": 16, "mips": false},
		{"name": "img_rgbh", "format": Image.FORMAT_RGBH, "w": 16, "h": 16, "mips": false},
		{"name": "img_rgbaf_mip", "format": Image.FORMAT_RGBAF, "w": 16, "h": 16, "mips": true},
		{"name": "img_rgbah", "format": Image.FORMAT_RGBAH, "w": 16, "h": 16, "mips": false},
		{"name": "img_rf_odd", "format": Image.FORMAT_RF, "w": 5, "h": 3, "mips": true},
	]


## The image of `spec`; `phase` shifts the pattern so a step-1 update changes every texel.
func _build_image(spec: Dictionary, phase: float = 0.0) -> Image:
	var name: String = spec["name"]
	var width: int = spec["w"]
	var height: int = spec["h"]
	var mips: bool = spec["mips"]
	var format: Image.Format = spec["format"]
	var image := Image.create(width, height, false, format)
	for y: int in height:
		for x: int in width:
			var u: float = float(x) / float(maxi(width - 1, 1))
			var v: float = float(y) / float(maxi(height - 1, 1))
			image.set_pixel(x, y, _pixel(name, u, v, x, y, phase))
	if mips:
		image.generate_mipmaps()
	return image


func _pixel(name: String, u: float, v: float, x: int, y: int, phase: float) -> Color:
	match name:
		"img_rgf":
			return Color(u * 1.5, v - 0.25, 0.0, 1.0)  # r above 1, g below 0
		"img_rh":
			return Color(absf(fposmod(v + phase, 1.0)), 0.0, 0.0, 1.0)
		"img_rgh":
			return Color(u, 1.0 - v, 0.0, 1.0)
		"img_rgbh":
			if x == 15 and y == 15:
				return Color(2.0, 0.0, 0.5, 1.0)  # an HDR outlier
			return Color(u, v, 0.5 * (u + v), 1.0)
		"img_rgbaf_mip":
			return Color(u, v, 1.0 - u, 0.25 + 0.75 * u)
		"img_rgbah":
			var checker: float = 1.0 if (x + y) % 2 == 0 else 0.25
			return Color(checker * fposmod(u + phase, 1.0), checker * v, checker, u)
		_:
			return Color(u * 0.5 + v * 0.5, 0.0, 0.0, 1.0)  # img_rf_odd


func _make_hdr_textures() -> void:
	var hdr: Dictionary = {}
	for texture: Dictionary in Textures.TEXTURES:
		if texture["name"] == "hdr":
			hdr = texture
	for pair: Array in [["hdr_bptc", "desktop"], ["hdr_astc", "mobile"]]:
		var name: String = pair[0]
		var family: String = pair[1]
		var v: Dictionary = Textures.variant(hdr, family)
		if v.is_empty():
			_error("no %s import of hdr (run the import leg)" % family)
			continue
		var path: String = v["path"]
		var compressed := ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE) as CompressedTexture2D
		if compressed == null:
			_error("cannot load %s" % path)
			continue
		if _source == "decoded":
			# The reference: the half-float payload an earlier headless run of this fixture wrote
			# (RS_FIXTURE_HDR_DUMP: this fixture's own Image.decompress of the imported image),
			# drawn as a plain texture. A rendered GLES3 run cannot be asked to decode it: its
			# CompressedTexture2D.get_image() is what the GPU path kept (ASTC HDR is not
			# sampleable on desktop), not the creation-time image.
			var payload_path: String = _decoded_dir.path_join("%s.grt1" % name)
			var decoded: Dictionary = Payload.decode(FileAccess.get_file_as_bytes(payload_path))
			var ok: bool = decoded["ok"]
			if not ok:
				_error("cannot read the decoded payload %s" % payload_path)
				continue
			var decoded_image: Image = decoded["image"]
			_textures[name] = ImageTexture.create_from_image(decoded_image)
		else:
			_textures[name] = compressed


# ------------------------------------------------------------------------------ the scene

func _build_scene() -> void:
	var strips: Array[Dictionary] = [
		{"name": "curve_rf", "channel": 0, "gain": 0.6},
		{"name": "curve_rgb", "channel": 0, "gain": 1.0},
		{"name": "curve_xyz", "channel": 0, "gain": 1.0},
		{"name": "grad_hdr", "channel": 0, "gain": 0.5},
		{"name": "grad_hdr", "channel": 1, "gain": 1.0},
	]
	var y: int = 8
	for strip: Dictionary in strips:
		var name: String = strip["name"]
		var channel: int = strip["channel"]
		var gain: float = strip["gain"]
		_add_view("%s_%d" % [name, channel], name, Vector2(8, y), Vector2(256, 16), channel, gain)
		y += 22
	var squares: Array[String] = ["img_rgf", "img_rh", "img_rgh", "img_rgbh", "img_rgbaf_mip", "img_rgbah", "img_rf_odd", "hdr_bptc", "hdr_astc"]
	var x: int = 8
	for name: String in squares:
		if _textures.has(name):
			_add_view("v_" + name, name, Vector2(x, 130), Vector2(48, 48), 0, 1.0)
		x += 56
	x = 8
	for name: String in ["img_rgbah", "img_rgbh", "hdr_astc", "hdr_bptc"]:
		if _textures.has(name):
			var sprite := Sprite2D.new()
			sprite.name = "S_" + name
			sprite.texture = _textures[name]
			sprite.centered = false
			sprite.position = Vector2(x, 196)
			sprite.scale = Vector2(3, 3)
			add_child(sprite)
		x += 56


func _add_view(node_name: String, texture_name: String, position: Vector2, size: Vector2, channel: int, gain: float) -> void:
	var rect := ColorRect.new()
	rect.name = node_name
	rect.position = position
	rect.size = size
	var material := ShaderMaterial.new()
	material.shader = _view_shader
	material.set_shader_parameter("src", _textures[texture_name])
	material.set_shader_parameter("gain", gain)
	material.set_shader_parameter("channel", channel)
	rect.material = material
	add_child(rect)


# ------------------------------------------------------------------------------ step 1

func _apply_step_1() -> void:
	# CurveTexture/CurveXYZTexture: the same width and mode -> texture_2d_update of the float image.
	_curve_rf.set_point_value(1, 0.25)
	_curve_rgb.set_point_value(0, 0.5)
	_curves_xyz[1].set_point_value(1, 1.0)
	# GradientTexture1D: a new width -> texture_2d_create + texture_replace.
	_gradient.set_color(1, Color(1.0, 0.0, 0.25, 1.0))
	_gradient_texture.width = 192
	# ImageTexture.update on the loader-made textures (texture_2d_update, a float payload).
	for spec: Dictionary in _image_specs():
		var name: String = spec["name"]
		if name == "img_rh" or name == "img_rgbah":
			var image: Image = _build_image(spec, 0.25)
			_loader_images[name] = image
			var texture: ImageTexture = _textures[name]
			texture.update(image)


# ------------------------------------------------------------------------------ the oracle log

func _log_expected(step: int) -> void:
	_logged_step[step] = true
	var width: int = 192 if step == 1 else CURVE_WIDTH
	# CurveTexture: RF (or RGBF in RGB mode) samples at t = i / width (curve_texture.cpp:100-110).
	var rf := PackedFloat32Array()
	var rgb := PackedFloat32Array()
	for i: int in CURVE_WIDTH:
		var t: float = float(i) / float(CURVE_WIDTH)
		rf.append(_curve_rf.sample_baked(t))
		var s: float = _curve_rgb.sample_baked(t)
		rgb.append_array(PackedFloat32Array([s, s, s]))
	_log_texture(step, "curve_rf", "curve", _from_floats(rf, CURVE_WIDTH, Image.FORMAT_RF))
	_log_texture(step, "curve_rgb", "curve", _from_floats(rgb, CURVE_WIDTH, Image.FORMAT_RGBF))
	var xyz := PackedFloat32Array()
	for i: int in CURVE_WIDTH:
		var t: float = float(i) / float(CURVE_WIDTH)
		xyz.append_array(PackedFloat32Array([_curves_xyz[0].sample_baked(t), _curves_xyz[1].sample_baked(t), _curves_xyz[2].sample_baked(t)]))
	_log_texture(step, "curve_xyz", "curve", _from_floats(xyz, CURVE_WIDTH, Image.FORMAT_RGBF))
	# GradientTexture1D hdr: RGBAF, offset i / (width - 1) (gradient_texture.cpp:95-100).
	var grad := PackedFloat32Array()
	for i: int in width:
		var c: Color = _gradient.sample(float(i) / float(width - 1))
		grad.append_array(PackedFloat32Array([c.r, c.g, c.b, c.a]))
	_log_texture(step, "grad_hdr", "gradient", _from_floats(grad, width, Image.FORMAT_RGBAF))
	for spec: Dictionary in _image_specs():
		var name: String = spec["name"]
		var image: Image = _loader_images[name]
		_log_texture(step, name, "image", image)
	if step == 0:
		for pair: Array in [["hdr_bptc", "desktop"], ["hdr_astc", "mobile"]]:
			_log_hdr(step, pair[0], pair[1])


func _from_floats(values: PackedFloat32Array, width: int, format: Image.Format) -> Image:
	return Image.create_from_data(width, 1, false, format, values.to_byte_array())


func _log_hdr(step: int, name: String, family: String) -> void:
	var hdr: Dictionary = {}
	for texture: Dictionary in Textures.TEXTURES:
		if texture["name"] == "hdr":
			hdr = texture
	var v: Dictionary = Textures.variant(hdr, family)
	if v.is_empty():
		return
	var path: String = v["path"]
	var compressed := ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE) as CompressedTexture2D
	if compressed == null:
		return
	var image: Image = compressed.get_image()
	var source_format: String = Payload.format_name(image)
	var copy: Image = image.duplicate()
	copy.decompress()
	if _hdr_dump_dir != "":
		var dump := FileAccess.open(_hdr_dump_dir.path_join("%s.grt1" % name), FileAccess.WRITE)
		if dump != null:
			dump.store_buffer(Payload.encode(copy))
			dump.close()
	_log_texture(step, name, "hdr", copy, source_format)


func _log_texture(step: int, name: String, kind: String, image: Image, source_format: String = "") -> void:
	if _texture_log_file == null:
		return
	var line: Dictionary = Payload.describe(image)
	line["step"] = step
	line["frame"] = _frame
	line["name"] = name
	line["kind"] = kind
	line["source"] = _source
	line["source_format"] = source_format if source_format != "" else null
	_texture_log_file.store_line(JSON.stringify(line, "", false))
	_texture_log_file.flush()


# ------------------------------------------------------------------------------ plumbing

func _read_environment() -> bool:
	if OS.has_environment("RS_FIXTURE_SOURCE"):
		_source = OS.get_environment("RS_FIXTURE_SOURCE")
		if _source != "ctex" and _source != "decoded":
			_error("RS_FIXTURE_SOURCE must be ctex or decoded (got %s)" % JSON.stringify(_source))
			return false
	if _source == "decoded":
		_decoded_dir = _path_env("RS_FIXTURE_DECODED_DIR")
		if _decoded_dir == "" or _decoded_dir == "!":
			_error("RS_FIXTURE_SOURCE=decoded needs RS_FIXTURE_DECODED_DIR (a capture leg's hdr/ dump)")
			return false
	_hdr_dump_dir = _path_env("RS_FIXTURE_HDR_DUMP")
	if _hdr_dump_dir == "!":
		return false
	if _hdr_dump_dir != "":
		DirAccess.make_dir_recursive_absolute(_hdr_dump_dir)
	_start_frame = _int_env("RS_FIXTURE_START_FRAME", START_FRAME_DEFAULT, 1)
	_step_frames = _int_env("RS_FIXTURE_STEP_FRAMES", STEP_FRAMES_DEFAULT, SETTLE_OFFSET + 1)
	var quit_default: int = _start_frame + _step_frames * LAST_STEP + 11
	_quit_frame = _int_env("RS_FIXTURE_QUIT_FRAME", quit_default, quit_default)
	var step_log: String = _path_env("RS_FIXTURE_STEP_LOG")
	_shot_dir = _path_env("RS_FIXTURE_SHOT_DIR")
	var texture_log: String = _path_env("RS_FIXTURE_TEXTURE_LOG")
	if step_log == "!" or _shot_dir == "!" or texture_log == "!" or _failed:
		return false
	if step_log != "":
		_step_log_file = FileAccess.open(step_log, FileAccess.WRITE)
		if _step_log_file == null:
			_error("cannot open RS_FIXTURE_STEP_LOG=%s" % step_log)
			return false
	if texture_log != "":
		_texture_log_file = FileAccess.open(texture_log, FileAccess.WRITE)
		if _texture_log_file == null:
			_error("cannot open RS_FIXTURE_TEXTURE_LOG=%s" % texture_log)
			return false
	return true


func _int_env(name: String, fallback: int, minimum: int) -> int:
	if not OS.has_environment(name):
		return fallback
	var text: String = OS.get_environment(name).strip_edges()
	if not text.is_valid_int() or text.to_int() < minimum:
		_error("%s must be an integer >= %d (got %s)" % [name, minimum, JSON.stringify(text)])
		_failed = true
		return fallback
	return text.to_int()


## "" when unset, "!" when set but not absolute.
func _path_env(name: String) -> String:
	if not OS.has_environment(name):
		return ""
	var text: String = OS.get_environment(name)
	if not text.is_absolute_path():
		_error("%s must be an absolute path (got %s)" % [name, JSON.stringify(text)])
		return "!"
	return text


func _error(text: String) -> void:
	printerr("[fixture] error: " + text)


func _log_step(step: int, applied_frame: int, settle_frame: int) -> void:
	if _step_log_file == null:
		return
	_step_log_file.store_line("{\"step\":%d,\"applied_frame\":%d,\"settle_frame\":%d}" % [step, applied_frame, settle_frame])
	_step_log_file.flush()


## Rendered runs only: headless has no draw path, so frame_post_draw never fires there.
func _maybe_take_shot(file_name: String) -> void:
	if _shot_dir == "":
		return
	if DisplayServer.get_name() == "headless":
		print("[fixture] shot skipped (headless)")
		return
	var out_path: String = _shot_dir.path_join(file_name)
	await RenderingServer.frame_post_draw
	var image: Image = get_viewport().get_texture().get_image()
	var err: Error = image.save_png(out_path)
	print("[fixture] shot saved=%s err=%d" % [out_path, err])
