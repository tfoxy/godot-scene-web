extends Node
## Gate 8 particle colour fixture (PFB, render-stream-12.md "As built (PFB)", README.md). Three
## cells, each one GPUParticles2D particle (amount 1, explosiveness 1, lifetime 100 s, no velocity,
## no gravity, scale 1) drawing a 32x32 opaque white texture at the cell centre, so the cell's
## centre pixel is the particle's colour on the clear colour (0.2 grey):
##
##   C_MIX   (160,180)  ParticleProcessMaterial.color (0.5, 0.25, 0.75, 1), blend mix
##   C_ADD   (320,180)  ParticleProcessMaterial.color (0.6, 0.4, 0.2, 0.5), a CanvasItemMaterial
##                      with blend add
##   C_RAMP  (480,180)  color white, color_ramp a GradientTexture1D of (0.5, 0.25, 0.75, 1) at both
##                      stops (the control: a texture, not a colour uniform)
##
## A RendererRD host (forward_plus, mobile) uploads a particles material's colour uniforms through
## Color::srgb_to_linear() and a gl_compatibility host does not, so C_MIX and C_ADD differ between
## the two backends and C_RAMP does not.
##
## Timeline (fixture frames, --fixed-fps 60): checkpoint 0 is _ready's scene (applied 1, settles
## 4); checkpoint 1 at 20 (settles 27), nothing changes (a second shot of the same state); quit at
## 40. Environment (all optional): RS_FIXTURE_STEP_LOG ({"step", "applied_frame",
## "settle_frame"} per checkpoint), RS_FIXTURE_QUIT_FRAME (>= 40), RS_FIXTURE_SHOT_DIR (rendered
## runs only: step-<k>.png at each settle frame). The fixture prints
## `[fixture] rendering_method=<m>` (RenderingServer.get_current_rendering_method()).

const CHECKPOINTS: Array[Array] = [[1, 4], [20, 27]]
const QUIT_DEFAULT: int = 40

var _frame: int = 0
var _quit_frame: int = QUIT_DEFAULT
var _step_log_file: FileAccess
var _shot_dir: String = ""
var _failed: bool = false


func _ready() -> void:
	if not _read_environment():
		_failed = true
		get_tree().quit(2)
		return
	print("[fixture] rendering_method=%s" % RenderingServer.get_current_rendering_method())
	var root := Node2D.new()
	add_child(root)
	var white := ImageTexture.create_from_image(_white_image())

	var mix_pm := _process_material()
	mix_pm.color = Color(0.5, 0.25, 0.75, 1.0)
	root.add_child(_particles(2101, mix_pm, white, Vector2(160, 180)))

	var add_pm := _process_material()
	add_pm.color = Color(0.6, 0.4, 0.2, 0.5)
	var add := _particles(2102, add_pm, white, Vector2(320, 180))
	var add_material := CanvasItemMaterial.new()
	add_material.blend_mode = CanvasItemMaterial.BLEND_MODE_ADD
	add.material = add_material
	root.add_child(add)

	var ramp_pm := _process_material()
	var gradient := Gradient.new()
	gradient.set_color(0, Color(0.5, 0.25, 0.75, 1.0))
	gradient.set_color(1, Color(0.5, 0.25, 0.75, 1.0))
	var ramp := GradientTexture1D.new()
	ramp.width = 16
	ramp.gradient = gradient
	ramp_pm.color_ramp = ramp
	root.add_child(_particles(2103, ramp_pm, white, Vector2(480, 180)))

	print("[fixture] gate8-ptc ready: quit=%d" % _quit_frame)


func _process(_delta: float) -> void:
	if _failed:
		return
	_frame += 1
	for k: int in range(CHECKPOINTS.size()):
		var applied: int = CHECKPOINTS[k][0]
		var settle: int = CHECKPOINTS[k][1]
		if _frame == applied:
			_log_step(k, applied, settle)
		if _frame == settle:
			_maybe_take_shot("step-%d.png" % k)
	if _frame >= _quit_frame:
		print("[fixture] quitting frame=%d" % _frame)
		get_tree().quit(0)


## A 2D ParticleProcessMaterial that holds its particle still: disable_z, an explicit zero gravity
## (so set_process_material does not rewrite it), no velocity, scale 1.
func _process_material() -> ParticleProcessMaterial:
	var pm := ParticleProcessMaterial.new()
	pm.particle_flag_disable_z = true
	pm.gravity = Vector3(0, 0, 0)
	pm.initial_velocity_min = 0.0
	pm.initial_velocity_max = 0.0
	pm.scale_min = 1.0
	pm.scale_max = 1.0
	return pm


func _particles(particle_seed: int, pm: ParticleProcessMaterial, texture: Texture2D, at: Vector2) -> GPUParticles2D:
	var p := GPUParticles2D.new()
	p.amount = 1
	p.lifetime = 100.0
	p.explosiveness = 1.0
	p.use_fixed_seed = true
	p.seed = particle_seed
	p.process_material = pm
	p.texture = texture
	p.position = at
	return p


## A 32x32 opaque white image.
static func _white_image() -> Image:
	var image: Image = Image.create_empty(32, 32, false, Image.FORMAT_RGBA8)
	image.fill(Color(1, 1, 1, 1))
	return image


func _read_environment() -> bool:
	if OS.has_environment("RS_FIXTURE_QUIT_FRAME"):
		var text: String = OS.get_environment("RS_FIXTURE_QUIT_FRAME").strip_edges()
		if not text.is_valid_int() or text.to_int() < QUIT_DEFAULT:
			_error("RS_FIXTURE_QUIT_FRAME must be an integer >= %d (got %s)" % [QUIT_DEFAULT, JSON.stringify(text)])
			return false
		_quit_frame = text.to_int()
	if OS.has_environment("RS_FIXTURE_SHOT_DIR"):
		_shot_dir = OS.get_environment("RS_FIXTURE_SHOT_DIR")
		if not _shot_dir.is_absolute_path():
			_error("RS_FIXTURE_SHOT_DIR must be an absolute path (got %s)" % JSON.stringify(_shot_dir))
			return false
	if OS.has_environment("RS_FIXTURE_STEP_LOG"):
		var step_log: String = OS.get_environment("RS_FIXTURE_STEP_LOG")
		if not step_log.is_absolute_path():
			_error("RS_FIXTURE_STEP_LOG must be an absolute path (got %s)" % JSON.stringify(step_log))
			return false
		_step_log_file = FileAccess.open(step_log, FileAccess.WRITE)
		if _step_log_file == null:
			_error("cannot open RS_FIXTURE_STEP_LOG=%s" % step_log)
			return false
	return true


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
