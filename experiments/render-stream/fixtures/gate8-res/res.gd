extends Node
## Gate 8 late-arm pre-arm resources fixture (LATE-RES, fidelity gap #5): a capture armed LATE at
## fixture frame 12 (loader.gd), then a post-arm draw referencing resources that existed BEFORE the
## arm but were first drawn only after it. Three 64x64 cells:
##
##   TEX   (40,40)   a post-arm Sprite2D drawing a PRE-ARM ImageTexture (adopt_texture_ref, G8r)
##   PPM   (136,40)  a PRE-ARM GPUParticles2D (detached, not in the tree at arm) whose
##                   ParticleProcessMaterial was also made pre-arm (adopt_particles_ref, PM7)
##   ITEM  (232,40)  a PRE-ARM Node2D (detached) whose `_draw` draws a plain rect, added to the
##                   tree after the arm (adopt_item_node, LATE-RES: the pooled-node case)
##
## The root is a plain `Node`: every resource is made in `_ready`, before the loader's `_process`
## arms at frame 12. The pre-arm nodes enter the tree at frame 15 (after the arm), so the capture
## must adopt each at its first post-arm reference. At frame 22 (FREE_FRAME) the fixture frees the
## adopted TEX sprite and texture, the PPM emitter and the ITEM node (the capture must record them
## freed, res-free). Timeline: quit at 30.
##
## LAR6 (late-arm-registry-design.md R4 "Off-main references"): at frame 16 a worker `Thread` draws
## a fifth pre-arm ImageTexture (`_pre_tex_thread`) into an RS-only canvas item and clears it again,
## inside one `_process` (the main thread waits for it), so no transaction ever holds the draw. The
## thread's reference is the texture's only one: the capture must queue it and adopt it at the frame
## boundary (res-late-adopt's second texture); GRC_ADOPT_FAULT=registry-queue-drop loses it.

const QUIT_DEFAULT: int = 30
const FREE_FRAME: int = 22

var _frame: int = 0
var _quit_frame: int = QUIT_DEFAULT
var _failed: bool = false
var _root: Node2D
var _pre_tex: ImageTexture
var _pre_emitter: GPUParticles2D
var _pre_item: Node2D
var _pre_pm9: ParticleProcessMaterial
var _sprite: Sprite2D
var _pre_tex_thread: ImageTexture
var _thread_item: RID


func _ready() -> void:
	if not _read_environment():
		_failed = true
		get_tree().quit(2)
		return
	_root = Node2D.new()
	add_child(_root)

	# PRE-ARM resources (none in the tree at arm): the TEX texture, the PPM cell's emitter and
	# process material, the ITEM cell's draw node, and the PPM9 cell's orphan process material.
	_pre_tex = ImageTexture.create_from_image(_pattern(1))
	_pre_tex_thread = ImageTexture.create_from_image(_pattern(3))  # LAR6: drawn from a thread only

	var pm := ParticleProcessMaterial.new()
	pm.particle_flag_disable_z = true
	pm.emission_shape = ParticleProcessMaterial.EMISSION_SHAPE_SPHERE
	pm.emission_sphere_radius = 12.0
	pm.gravity = Vector3(0, 20, 0)
	pm.initial_velocity_min = 20.0
	pm.initial_velocity_max = 40.0
	_pre_emitter = GPUParticles2D.new()
	_pre_emitter.amount = 9
	_pre_emitter.lifetime = 1.0
	_pre_emitter.use_fixed_seed = true
	_pre_emitter.seed = 1901
	_pre_emitter.local_coords = true
	_pre_emitter.process_material = pm
	_pre_emitter.texture = ImageTexture.create_from_image(_dot_image())
	# Detached: never added to the tree until frame 15 (the arm at 12 walks only the root's tree).

	# PPM9 (the emitter-9 shape): a pre-arm process material whose shader is forced by a temporary
	# emitter that is never added to the tree; a post-arm emitter is given it at frame 15.
	_pre_pm9 = ParticleProcessMaterial.new()
	_pre_pm9.particle_flag_disable_z = true
	_pre_pm9.emission_shape = ParticleProcessMaterial.EMISSION_SHAPE_SPHERE_SURFACE
	var tmp := GPUParticles2D.new()
	tmp.process_material = _pre_pm9
	# tmp is a local, freed here; _pre_pm9 keeps its RID and shared shader resident.

	_pre_item = preload("res://item_draw.gd").new()
	# Detached, as the emitter.

	print("[fixture] gate8-res ready: quit=%d" % _quit_frame)


func _process(_delta: float) -> void:
	if _failed:
		return
	_frame += 1
	if _frame == 15:
		# Post-arm: draw the pre-arm resources. TEX draws a pre-arm texture through a post-arm item;
		# PPM and ITEM enter the tree with their pre-arm canvas items (the pooled-node shape); PPM9
		# gives a post-arm emitter the pre-arm process material (the emitter-9 shape).
		_sprite = Sprite2D.new()
		var sprite := _sprite
		sprite.texture = _pre_tex
		sprite.centered = false
		sprite.position = Vector2(40, 40)
		sprite.scale = Vector2(4.0, 4.0)
		_root.add_child(sprite)

		_pre_emitter.position = Vector2(136, 40)
		_root.add_child(_pre_emitter)

		_pre_item.position = Vector2(232, 40)
		_root.add_child(_pre_item)

		var p9 := GPUParticles2D.new()
		p9.amount = 9
		p9.lifetime = 1.0
		p9.use_fixed_seed = true
		p9.seed = 1909
		p9.local_coords = true
		p9.process_material = _pre_pm9
		p9.texture = ImageTexture.create_from_image(_dot_image())
		p9.position = Vector2(328, 40)
		_root.add_child(p9)
		print("[fixture] gate8-res cells added at frame %d" % _frame)
	if _frame == 16:
		# LAR6: the loader-thread reference (drawn and cleared by the worker before the frame ends).
		_thread_item = RenderingServer.canvas_item_create()
		var worker := Thread.new()
		worker.start(_thread_draw.bind(_thread_item, _pre_tex_thread.get_rid()))
		worker.wait_to_finish()
		print("[fixture] gate8-res thread reference at frame %d" % _frame)
	if _frame == FREE_FRAME:
		# Free the adopted cells (not PPM9): the node frees the items and the particles; dropping the
		# script's own references lets the texture and process material resources go too.
		_sprite.queue_free()
		_pre_emitter.queue_free()
		_pre_item.queue_free()
		_sprite = null
		_pre_emitter = null
		_pre_item = null
		_pre_tex = null
		RenderingServer.free_rid(_thread_item)
		print("[fixture] gate8-res cells freed at frame %d" % _frame)
	if _frame >= _quit_frame:
		print("[fixture] quitting frame=%d" % _frame)
		get_tree().quit(0)


## The worker's draw: a reference from a non-main thread (the item is never shown with it).
static func _thread_draw(item: RID, texture: RID) -> void:
	RenderingServer.canvas_item_add_texture_rect(item, Rect2(0, 0, 16, 16), texture)
	RenderingServer.canvas_item_clear(item)


## A 16x16 opaque RGBA8 image of 4x4-texel blocks, every channel in 10..239 (never white, so a
## texture drawn as Godot's white default cannot pass for it).
static func _pattern(seed: int) -> Image:
	var image: Image = Image.create_empty(16, 16, false, Image.FORMAT_RGBA8)
	for y: int in range(16):
		for x: int in range(16):
			var i: int = x / 4
			var j: int = y / 4
			image.set_pixel(x, y, Color8(
				10 + (20 + 11 * seed + 40 * i) % 230,
				10 + (60 + 17 * seed + 45 * j) % 230,
				10 + (200 + 23 * seed + 35 * (i + j)) % 230,
				255))
	return image


## A 4x4 opaque white dot (the emitter's particles texture).
static func _dot_image() -> Image:
	var image: Image = Image.create_empty(4, 4, false, Image.FORMAT_RGBA8)
	image.fill(Color(1, 1, 1, 1))
	return image


func _read_environment() -> bool:
	if OS.has_environment("RS_FIXTURE_QUIT_FRAME"):
		var text: String = OS.get_environment("RS_FIXTURE_QUIT_FRAME").strip_edges()
		if not text.is_valid_int() or text.to_int() < QUIT_DEFAULT:
			_error("RS_FIXTURE_QUIT_FRAME must be an integer >= %d (got %s)" % [QUIT_DEFAULT, JSON.stringify(text)])
			return false
		_quit_frame = text.to_int()
	return true


func _error(text: String) -> void:
	printerr("[fixture] error: " + text)
