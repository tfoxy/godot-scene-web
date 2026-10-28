extends Node
## Gate 8 multimesh fixture (PM1, render-stream-11.md "As built (PM1)", README.md). Nine cells, each
## multimesh with its own instance count (the checker finds a cell's multimesh in the hook log by
## its last allocation's count; CPUParticles2D's constructor first allocates 8, so no cell uses 8):
##
##   A_XFORM    (40,40)    MultiMeshInstance2D, 5 instances, transforms only, set per instance
##                         (multimesh_instance_set_transform_2d); step 1 moves instance 2
##   B_CUSTOM   (240,40)   MultiMeshInstance2D, 6 instances, colour and custom data, one set_buffer
##                         in _ready, then instance 0's custom data = (fixture frame, 0, 0, 0) set
##                         in _process every frame (multimesh_instance_set_custom_data); a canvas
##                         shader reads INSTANCE_CUSTOM (frame pairing)
##   C_FLIP     (460,70)   CPUParticles2D, 7 particles, use_fixed_seed, local coordinates, a 4x1
##                         flipbook through a CanvasItemMaterial (particles_animation)
##   D_GLOBAL   (40..98,180) CPUParticles2D, 9 particles, use_fixed_seed, global coordinates
##                         (local_coords=false) under a parent Node2D moved every frame
##   E_VISIBLE  (240,150)  MultiMeshInstance2D, 10 instances with colours, visible_instance_count 4
##                         and a custom AABB; step 2 shows 6
##   F_REPLACE  (460,150)  MultiMeshInstance2D, 3 instances with colours; step 1 replaces the buffer
##                         (`multimesh.buffer = ...`), step 2 sets the same floats again (idle)
##   G_HIDDEN   (40,280)   CPUParticles2D, 11 particles, emitting but hidden: never draws, never
##                         calls multimesh_set_buffer
##   H_FREE     (240,270)  a raw RenderingServer multimesh (2 instances) on a raw canvas item; step 1
##                         sends a wrong-size multimesh_set_buffer (the engine rejects it); step 2
##                         frees the multimesh while the item still names it (a `freed` tombstone);
##                         the frame after, the item is cleared (the entry leaves the table)
##   I_PREDRAW  (440,270)  MultiMeshInstance2D, 12 instances with custom data only; its buffer is
##                         set from RenderingServer.frame_pre_draw (CPUParticles2D's own timing)
##                         with instance 0's custom.x = the fixture frame
##
## Timeline (fixture frames, --fixed-fps 60): checkpoint 0 is _ready's scene (applied 1, settles 4);
## step 1 at 20 (settles 27); step 2 at 40 (settles 47); H's item cleared at 41; quit at 90. The
## step log holds {"step", "applied_frame", "settle_frame"} per checkpoint. RS_FIXTURE_MM_LOG
## gets one line per frame-carrying buffer of B and I: {"cell", "frame", "value", "sha256"} (the
## SHA-256 of the cell's whole buffer as little-endian f32 after the change, the floats the
## fixture itself set). Environment (all optional): RS_FIXTURE_STEP_LOG, RS_FIXTURE_MM_LOG,
## RS_FIXTURE_SHOT_DIR (rendered runs only, shots step-<k>.png at each settle frame and, PM2,
## step-<k>-prev.png the frame before), RS_FIXTURE_QUIT_FRAME (>= 90).

const CHECKPOINTS: Array[Array] = [[1, 4], [20, 27], [40, 47]]
const H_CLEAR_FRAME: int = 41
const QUIT_DEFAULT: int = 90
## The custom.x of a frame-carrying instance before its first frame: never a frame number.
const SENTINEL: float = -1.0

const B_SHADER: String = """shader_type canvas_item;

varying vec4 v_custom;

void vertex() {
	v_custom = INSTANCE_CUSTOM;
}

void fragment() {
	float odd = mod(v_custom.x, 2.0);
	COLOR = vec4(COLOR.rgb * (0.5 + 0.5 * odd) + vec3(0.0, v_custom.y, 0.0), 1.0);
}
"""

var _frame: int = 0
var _quit_frame: int = QUIT_DEFAULT
var _shot_dir: String = ""
var _step_log_file: FileAccess
var _mm_log_file: FileAccess
var _failed: bool = false
var _root: Node2D
var _quad: ArrayMesh
var _a: MultiMesh
var _b: MultiMesh
var _b_buffer: PackedFloat32Array
var _d_parent: Node2D
var _e: MultiMesh
var _f: MultiMesh
var _f_step1: PackedFloat32Array
var _h_mm: RID
var _h_item: RID
var _i: MultiMesh
var _i_buffer: PackedFloat32Array


func _ready() -> void:
	if not _read_environment():
		_failed = true
		get_tree().quit(2)
		return
	_root = Node2D.new()
	add_child(_root)
	_quad = _quad_mesh(8.0)

	# A_XFORM: transforms only, set per instance.
	_a = _multimesh(5, false, false)
	for k: int in range(5):
		_a.set_instance_transform_2d(k, _xform(k, 0.25 * k, 2.0, Vector2(32.0 * k, 20.0)))
	_instance(_a, Vector2(40, 40), null)

	# B_CUSTOM: colour and custom data, read by a canvas shader.
	_b = _multimesh(6, true, true)
	_b_buffer = PackedFloat32Array()
	for k: int in range(6):
		_append_xform(_b_buffer, _xform(k, 0.0, 2.0, Vector2(28.0 * k, 20.0)))
		_b_buffer.append_array(PackedFloat32Array([0.3 + 0.1 * k, 0.9 - 0.1 * k, 0.5, 1.0]))
		var custom_x: float = SENTINEL if k == 0 else float(k)
		_b_buffer.append_array(PackedFloat32Array([custom_x, 0.05 * k, 0.0, 0.0]))
	_b.buffer = _b_buffer
	var shader := Shader.new()
	shader.code = B_SHADER
	var b_material := ShaderMaterial.new()
	b_material.shader = shader
	_instance(_b, Vector2(240, 40), b_material)

	# C_FLIP: a fixed-seed CPUParticles2D with a 4x1 flipbook.
	var c := _particles(7, 4242, true)
	c.texture = ImageTexture.create_from_image(_flipbook())
	var c_material := CanvasItemMaterial.new()
	c_material.particles_animation = true
	c_material.particles_anim_h_frames = 4
	c_material.particles_anim_v_frames = 1
	c_material.particles_anim_loop = true
	c.material = c_material
	c.anim_speed_min = 1.0
	c.anim_speed_max = 1.0
	c.position = Vector2(460, 70)
	_root.add_child(c)

	# D_GLOBAL: global coordinates under a moving parent.
	_d_parent = Node2D.new()
	_d_parent.position = Vector2(40, 180)
	_root.add_child(_d_parent)
	var d := _particles(9, 777, false)
	_d_parent.add_child(d)

	# E_VISIBLE: 4 of 10 instances visible, a custom AABB.
	_e = _multimesh(10, true, false)
	var e_buffer := PackedFloat32Array()
	for k: int in range(10):
		_append_xform(e_buffer, _xform(k, 0.0, 1.5, Vector2(18.0 * k, 20.0)))
		e_buffer.append_array(PackedFloat32Array([0.1 * k, 0.6, 1.0 - 0.1 * k, 1.0]))
	_e.buffer = e_buffer
	_e.visible_instance_count = 4
	_e.custom_aabb = AABB(Vector3(-8, -8, 0), Vector3(196, 48, 0))
	_instance(_e, Vector2(240, 150), null)

	# F_REPLACE: a buffer replaced at step 1, the same floats again at step 2.
	_f = _multimesh(3, true, false)
	var f_buffer := PackedFloat32Array()
	_f_step1 = PackedFloat32Array()
	for k: int in range(3):
		_append_xform(f_buffer, _xform(k, 0.0, 3.0, Vector2(40.0 * k, 20.0)))
		f_buffer.append_array(PackedFloat32Array([1.0, 0.2 * k, 0.2, 1.0]))
		_append_xform(_f_step1, _xform(k, 0.5, 3.0, Vector2(40.0 * k, 40.0)))
		_f_step1.append_array(PackedFloat32Array([0.2, 1.0, 0.2 * k, 1.0]))
	_f.buffer = f_buffer
	_instance(_f, Vector2(460, 150), null)

	# G_HIDDEN: emitting, hidden.
	var g := _particles(11, 99, true)
	g.position = Vector2(40, 280)
	g.visible = false
	_root.add_child(g)

	# H_FREE: a raw RenderingServer multimesh on a raw canvas item.
	_h_mm = RenderingServer.multimesh_create()
	RenderingServer.multimesh_allocate_data(_h_mm, 2, RenderingServer.MULTIMESH_TRANSFORM_2D, false, false)
	RenderingServer.multimesh_set_mesh(_h_mm, _quad.get_rid())
	var h_buffer := PackedFloat32Array()
	for k: int in range(2):
		_append_xform(h_buffer, _xform(k, 0.0, 4.0, Vector2(48.0 * k, 20.0)))
	RenderingServer.multimesh_set_buffer(_h_mm, h_buffer)
	_h_item = RenderingServer.canvas_item_create()
	RenderingServer.canvas_item_set_parent(_h_item, _root.get_canvas_item())
	RenderingServer.canvas_item_set_transform(_h_item, Transform2D(0.0, Vector2(240, 270)))
	RenderingServer.canvas_item_add_multimesh(_h_item, _h_mm, RID())

	# I_PREDRAW: custom data only, the buffer set from frame_pre_draw.
	_i = _multimesh(12, false, true)
	_i_buffer = _i_frame_buffer(SENTINEL)
	_i.buffer = _i_buffer
	_instance(_i, Vector2(440, 270), null)
	RenderingServer.frame_pre_draw.connect(_on_frame_pre_draw)

	print("[fixture] gate8-mm ready: quit=%d" % _quit_frame)


func _process(_delta: float) -> void:
	if _failed:
		return
	_frame += 1
	# B_CUSTOM: the frame number in instance 0's custom data, every frame.
	var custom := Color(float(_frame), 0.0, 0.0, 0.0)
	_b.set_instance_custom_data(0, custom)
	_b_buffer[12] = custom.r
	_b_buffer[13] = custom.g
	_b_buffer[14] = custom.b
	_b_buffer[15] = custom.a
	_log_buffer("B_CUSTOM", _b_buffer)
	# D_GLOBAL: the parent moves 2 px a frame, back every 30 frames.
	_d_parent.position = Vector2(40.0 + 2.0 * float(_frame % 30), 180.0)
	for k: int in range(CHECKPOINTS.size()):
		var applied: int = CHECKPOINTS[k][0]
		var settle: int = CHECKPOINTS[k][1]
		if _frame == applied:
			if k == 1:
				_step_1()
			elif k == 2:
				_step_2()
			_log_step(k, applied, settle)
		# PM2: the frame before each settle frame too (mm-reference-moving: the particle cells
		# move frame to frame, so a receiver one frame off cannot equal the reference).
		if _frame == settle - 1:
			_maybe_take_shot("step-%d-prev.png" % k)
		if _frame == settle:
			_maybe_take_shot("step-%d.png" % k)
	if _frame == H_CLEAR_FRAME:
		RenderingServer.canvas_item_clear(_h_item)
	if _frame >= _quit_frame:
		print("[fixture] quitting frame=%d" % _frame)
		get_tree().quit(0)


func _exit_tree() -> void:
	if _h_item.is_valid():
		RenderingServer.free_rid(_h_item)


func _step_1() -> void:
	_a.set_instance_transform_2d(2, _xform(2, 1.0, 2.0, Vector2(64.0, 44.0)))
	_f.buffer = _f_step1
	# The engine refuses a buffer whose size is not instances x stride (2 x 8 = 16 floats).
	RenderingServer.multimesh_set_buffer(_h_mm, PackedFloat32Array([1.0, 2.0, 3.0]))


func _step_2() -> void:
	_e.visible_instance_count = 6
	_f.buffer = _f_step1
	RenderingServer.free_rid(_h_mm)


func _on_frame_pre_draw() -> void:
	if _failed or _frame < 1:
		return
	_i_buffer = _i_frame_buffer(float(_frame))
	_i.buffer = _i_buffer
	_log_buffer("I_PREDRAW", _i_buffer)


func _i_frame_buffer(custom_x: float) -> PackedFloat32Array:
	var out := PackedFloat32Array()
	for k: int in range(12):
		_append_xform(out, _xform(k, 0.0, 1.0 + 0.25 * float(k % 3), Vector2(14.0 * k, 20.0)))
		var x: float = custom_x if k == 0 else float(k)
		out.append_array(PackedFloat32Array([x, 0.1 * float(k % 4), 0.0, 1.0]))
	return out


func _multimesh(count: int, colors: bool, custom: bool) -> MultiMesh:
	var mm := MultiMesh.new()
	mm.transform_format = MultiMesh.TRANSFORM_2D
	mm.use_colors = colors
	mm.use_custom_data = custom
	mm.instance_count = count
	mm.mesh = _quad
	return mm


func _instance(mm: MultiMesh, at: Vector2, material: Material) -> MultiMeshInstance2D:
	var node := MultiMeshInstance2D.new()
	node.multimesh = mm
	node.position = at
	if material != null:
		node.material = material
	_root.add_child(node)
	return node


func _particles(amount: int, particle_seed: int, local: bool) -> CPUParticles2D:
	var p := CPUParticles2D.new()
	p.amount = amount
	p.lifetime = 1.0
	p.use_fixed_seed = true
	p.seed = particle_seed
	p.local_coords = local
	p.direction = Vector2(1, 0)
	p.spread = 30.0
	p.initial_velocity_min = 30.0
	p.initial_velocity_max = 60.0
	p.gravity = Vector2(0, 20)
	p.scale_amount_min = 3.0
	p.scale_amount_max = 3.0
	return p


## Instance k's transform: rotation `angle`, uniform scale, at `offset`.
static func _xform(_k: int, angle: float, scale_factor: float, offset: Vector2) -> Transform2D:
	return Transform2D(angle, Vector2(scale_factor, scale_factor), 0.0, offset)


## Godot's TRANSFORM_2D buffer layout (MultiMesh / CPUParticles2D): [xx, yx, 0, ox, xy, yy, 0, oy].
static func _append_xform(out: PackedFloat32Array, t: Transform2D) -> void:
	out.append_array(PackedFloat32Array([t.x.x, t.y.x, 0.0, t.origin.x, t.x.y, t.y.y, 0.0, t.origin.y]))


## A 32x8 RGBA8 flipbook of four 8x8 frames, one opaque colour each.
static func _flipbook() -> Image:
	var image: Image = Image.create_empty(32, 8, false, Image.FORMAT_RGBA8)
	var colors: Array[Color] = [Color8(230, 60, 40), Color8(60, 200, 60), Color8(50, 90, 230), Color8(240, 220, 50)]
	for y: int in range(8):
		for x: int in range(32):
			image.set_pixel(x, y, colors[x / 8])
	return image


static func _quad_mesh(side: float) -> ArrayMesh:
	var h: float = side / 2.0
	var arrays: Array = []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = PackedVector2Array([Vector2(-h, -h), Vector2(h, -h), Vector2(h, h), Vector2(-h, h)])
	arrays[Mesh.ARRAY_TEX_UV] = PackedVector2Array([Vector2(0, 0), Vector2(1, 0), Vector2(1, 1), Vector2(0, 1)])
	arrays[Mesh.ARRAY_INDEX] = PackedInt32Array([0, 1, 2, 0, 2, 3])
	var mesh := ArrayMesh.new()
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	return mesh


func _log_buffer(cell: String, buffer: PackedFloat32Array) -> void:
	if _mm_log_file == null:
		return
	var ctx := HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	ctx.update(buffer.to_byte_array())
	var digest: String = ctx.finish().hex_encode()
	_mm_log_file.store_line("{\"cell\":\"%s\",\"frame\":%d,\"value\":%d,\"sha256\":\"%s\"}" % [cell, _frame, _frame, digest])
	_mm_log_file.flush()


func _read_environment() -> bool:
	if OS.has_environment("RS_FIXTURE_QUIT_FRAME"):
		var text: String = OS.get_environment("RS_FIXTURE_QUIT_FRAME").strip_edges()
		if not text.is_valid_int() or text.to_int() < QUIT_DEFAULT:
			_error("RS_FIXTURE_QUIT_FRAME must be an integer >= %d (got %s)" % [QUIT_DEFAULT, JSON.stringify(text)])
			return false
		_quit_frame = text.to_int()
	var step_log: String = _path_env("RS_FIXTURE_STEP_LOG")
	var mm_log: String = _path_env("RS_FIXTURE_MM_LOG")
	_shot_dir = _path_env("RS_FIXTURE_SHOT_DIR")
	if step_log == "!" or mm_log == "!" or _shot_dir == "!":
		return false
	if step_log != "":
		_step_log_file = FileAccess.open(step_log, FileAccess.WRITE)
		if _step_log_file == null:
			_error("cannot open RS_FIXTURE_STEP_LOG=%s" % step_log)
			return false
	if mm_log != "":
		_mm_log_file = FileAccess.open(mm_log, FileAccess.WRITE)
		if _mm_log_file == null:
			_error("cannot open RS_FIXTURE_MM_LOG=%s" % mm_log)
			return false
	return true


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
