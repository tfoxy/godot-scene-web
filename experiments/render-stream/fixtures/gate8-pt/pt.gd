extends Node
## Gate 8 GPU particles fixture (PM5, render-stream-12.md "Fixture and checks (gate 8 group
## g8pt)", README.md). Nine cells, each a GPUParticles2D with its own ParticleProcessMaterial and
## its own `amount` (the checker finds a cell's emitter in the hook log by its last
## particles_set_amount; GPUParticles2D's constructor first sets 8, so no cell uses 8). Every
## emitter has use_fixed_seed and its own seed.
##
##   A_BOX      (106,60)   box emitter, local coordinates, 3 particles; two emit_particle calls
##                         at each of steps 1 and 2 (the emit list)
##   B_SPHERE   (260..318,60) sphere emitter, global coordinates (local_coords = false), 5
##                         particles, under a Node2D moved 2 px a frame (back every 30)
##   C_RING     (533,60)   ring emitter, 6 particles; step 1 request_particles_process(0.5), step 2
##                         a new seed
##   D_ONESHOT  (106,180)  one-shot, emitting = false, 7 particles; restart() at steps 1 and 2
##   E_FLIP     (320,180)  9 particles, a 32x8 four-frame flipbook through a CanvasItemMaterial
##                         with particles_animation
##   F_CURVES   (533,180)  10 particles, scale_curve (CurveTexture) and color_ramp
##                         (GradientTexture1D, use_hdr: a float texture)
##   G_TURB     (106,300)  11 particles, turbulence
##   H_SUB      (320,300)  12 particles, sub_emitter_mode AT_END naming its child emitter (2
##                         particles, emitting = false)
##   I_TRAILS   (533,300)  13 particles, trails (4 sections: 5 bind poses)
##
## Timeline (fixture frames, --fixed-fps 60): checkpoint 0 is _ready's scene (applied 1, settles
## 4); step 1 at 20 (settles 27); step 2 at 40 (settles 47); quit at 90. The step log holds
## {"step", "applied_frame", "settle_frame"} per checkpoint. Environment (all optional):
## RS_FIXTURE_STEP_LOG, RS_FIXTURE_QUIT_FRAME (>= 90).

const CHECKPOINTS: Array[Array] = [[1, 4], [20, 27], [40, 47]]
const QUIT_DEFAULT: int = 90

var _frame: int = 0
var _quit_frame: int = QUIT_DEFAULT
var _step_log_file: FileAccess
var _failed: bool = false
var _root: Node2D
var _dot: ImageTexture
var _a: GPUParticles2D
var _b_parent: Node2D
var _c: GPUParticles2D
var _d: GPUParticles2D


func _ready() -> void:
	if not _read_environment():
		_failed = true
		get_tree().quit(2)
		return
	_root = Node2D.new()
	add_child(_root)
	_dot = ImageTexture.create_from_image(_dot_image())

	# A_BOX: a box emitter, local coordinates.
	var a_pm := _process_material()
	a_pm.emission_shape = ParticleProcessMaterial.EMISSION_SHAPE_BOX
	a_pm.emission_box_extents = Vector3(40, 20, 0)
	_a = _particles(3, 1001, true, a_pm)
	_a.position = Vector2(106, 60)
	_root.add_child(_a)

	# B_SPHERE: a sphere emitter, global coordinates, under a moving parent.
	var b_pm := _process_material()
	b_pm.emission_shape = ParticleProcessMaterial.EMISSION_SHAPE_SPHERE
	b_pm.emission_sphere_radius = 15.0
	_b_parent = Node2D.new()
	_b_parent.position = Vector2(260, 60)
	_root.add_child(_b_parent)
	var b := _particles(5, 1002, false, b_pm)
	_b_parent.add_child(b)

	# C_RING: a ring emitter.
	var c_pm := _process_material()
	c_pm.emission_shape = ParticleProcessMaterial.EMISSION_SHAPE_RING
	c_pm.emission_ring_axis = Vector3(0, 0, 1)
	c_pm.emission_ring_height = 0.0
	c_pm.emission_ring_radius = 30.0
	c_pm.emission_ring_inner_radius = 20.0
	_c = _particles(6, 1003, true, c_pm)
	_c.position = Vector2(533, 60)
	_root.add_child(_c)

	# D_ONESHOT: one-shot, not emitting until restarted.
	var d_pm := _process_material()
	_d = _particles(7, 1004, true, d_pm)
	_d.one_shot = true
	_d.explosiveness = 1.0
	_d.emitting = false
	_d.position = Vector2(106, 180)
	_root.add_child(_d)

	# E_FLIP: a flipbook through a CanvasItemMaterial.
	var e_pm := _process_material()
	e_pm.anim_speed_min = 1.0
	e_pm.anim_speed_max = 1.0
	var e := _particles(9, 1005, true, e_pm)
	e.texture = ImageTexture.create_from_image(_flipbook())
	var e_material := CanvasItemMaterial.new()
	e_material.particles_animation = true
	e_material.particles_anim_h_frames = 4
	e_material.particles_anim_v_frames = 1
	e_material.particles_anim_loop = true
	e.material = e_material
	e.position = Vector2(320, 180)
	_root.add_child(e)

	# F_CURVES: a scale curve and a colour ramp (both float textures).
	var f_pm := _process_material()
	var curve := Curve.new()
	curve.add_point(Vector2(0, 1))
	curve.add_point(Vector2(1, 0.25))
	var scale_curve := CurveTexture.new()
	scale_curve.width = 64
	scale_curve.curve = curve
	f_pm.scale_curve = scale_curve
	var gradient := Gradient.new()
	gradient.set_color(0, Color(1.0, 0.9, 0.2, 1.0))
	gradient.set_color(1, Color(0.9, 0.1, 0.6, 0.0))
	var ramp := GradientTexture1D.new()
	ramp.width = 64
	ramp.use_hdr = true
	ramp.gradient = gradient
	f_pm.color_ramp = ramp
	var f := _particles(10, 1006, true, f_pm)
	f.position = Vector2(533, 180)
	_root.add_child(f)

	# G_TURB: turbulence.
	var g_pm := _process_material()
	g_pm.turbulence_enabled = true
	g_pm.turbulence_noise_strength = 2.0
	g_pm.turbulence_noise_scale = 4.0
	var g := _particles(11, 1007, true, g_pm)
	g.position = Vector2(106, 300)
	_root.add_child(g)

	# H_SUB: a sub-emitter at the end of each particle's life, naming the cell's child emitter.
	var h_pm := _process_material()
	h_pm.sub_emitter_mode = ParticleProcessMaterial.SUB_EMITTER_AT_END
	h_pm.sub_emitter_amount_at_end = 1
	var h := _particles(12, 1008, true, h_pm)
	h.position = Vector2(320, 300)
	var h_child := _particles(2, 1009, true, _process_material())
	h_child.name = "SubEmitter"
	h_child.emitting = false
	h.add_child(h_child)
	h.sub_emitter = NodePath("SubEmitter")
	_root.add_child(h)

	# I_TRAILS: trails.
	var i_pm := _process_material()
	var i := _particles(13, 1010, true, i_pm)
	i.trail_enabled = true
	i.trail_lifetime = 0.3
	i.trail_sections = 4
	i.trail_section_subdivisions = 2
	i.position = Vector2(533, 300)
	_root.add_child(i)

	print("[fixture] gate8-pt ready: quit=%d" % _quit_frame)


func _process(_delta: float) -> void:
	if _failed:
		return
	_frame += 1
	# B_SPHERE: the parent moves 2 px a frame, back every 30 frames.
	_b_parent.position = Vector2(260.0 + 2.0 * float(_frame % 30), 60.0)
	for k: int in range(CHECKPOINTS.size()):
		var applied: int = CHECKPOINTS[k][0]
		var settle: int = CHECKPOINTS[k][1]
		if _frame == applied:
			if k == 1:
				_step_1()
			elif k == 2:
				_step_2()
			_log_step(k, applied, settle)
	if _frame >= _quit_frame:
		print("[fixture] quitting frame=%d" % _frame)
		get_tree().quit(0)


func _step_1() -> void:
	_emit_two(Vector2(0, 0))
	_c.request_particles_process(0.5)
	_d.restart()


func _step_2() -> void:
	_emit_two(Vector2(10, 5))
	_c.seed = 2003
	_d.restart()


## A_BOX: two emit_particle calls (position, velocity and colour flags).
func _emit_two(at: Vector2) -> void:
	var flags: int = GPUParticles2D.EMIT_FLAG_POSITION | GPUParticles2D.EMIT_FLAG_VELOCITY | GPUParticles2D.EMIT_FLAG_COLOR
	_a.emit_particle(Transform2D(0.0, at), Vector2(20, 0), Color(1, 0.2, 0.2, 1), Color(0, 0, 0, 0), flags)
	_a.emit_particle(Transform2D(0.5, at + Vector2(4, 4)), Vector2(0, 20), Color(0.2, 1, 0.2, 1), Color(0.25, 0, 0, 0), flags)


## A 2D ParticleProcessMaterial: disable_z and an explicit 2D gravity (so set_process_material
## does not rewrite it), a direction, a spread, velocities and a scale.
func _process_material() -> ParticleProcessMaterial:
	var pm := ParticleProcessMaterial.new()
	pm.particle_flag_disable_z = true
	pm.gravity = Vector3(0, 20, 0)
	pm.direction = Vector3(1, 0, 0)
	pm.spread = 30.0
	pm.initial_velocity_min = 30.0
	pm.initial_velocity_max = 60.0
	pm.scale_min = 3.0
	pm.scale_max = 3.0
	return pm


func _particles(amount: int, particle_seed: int, local: bool, pm: ParticleProcessMaterial) -> GPUParticles2D:
	var p := GPUParticles2D.new()
	p.amount = amount
	p.lifetime = 1.0
	p.use_fixed_seed = true
	p.seed = particle_seed
	p.local_coords = local
	p.process_material = pm
	p.texture = _dot
	return p


## A 4x4 opaque white dot.
static func _dot_image() -> Image:
	var image: Image = Image.create_empty(4, 4, false, Image.FORMAT_RGBA8)
	image.fill(Color(1, 1, 1, 1))
	return image


## A 32x8 RGBA8 flipbook of four 8x8 frames, one opaque colour each.
static func _flipbook() -> Image:
	var image: Image = Image.create_empty(32, 8, false, Image.FORMAT_RGBA8)
	var colors: Array[Color] = [Color8(230, 60, 40), Color8(60, 200, 60), Color8(50, 90, 230), Color8(240, 220, 50)]
	for y: int in range(8):
		for x: int in range(32):
			image.set_pixel(x, y, colors[x / 8])
	return image


func _read_environment() -> bool:
	if OS.has_environment("RS_FIXTURE_QUIT_FRAME"):
		var text: String = OS.get_environment("RS_FIXTURE_QUIT_FRAME").strip_edges()
		if not text.is_valid_int() or text.to_int() < QUIT_DEFAULT:
			_error("RS_FIXTURE_QUIT_FRAME must be an integer >= %d (got %s)" % [QUIT_DEFAULT, JSON.stringify(text)])
			return false
		_quit_frame = text.to_int()
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
