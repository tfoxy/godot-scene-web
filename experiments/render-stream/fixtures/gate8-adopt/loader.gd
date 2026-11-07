extends Node
## Gate 8 adoption autoload (`GrcLoader`, see project.godot). Gate 1's loader (`fixtures/gate1/loader.gd`)
## plus a late arm: it loads the capture GDExtension through `GDExtensionManager.load_extension`
##
##   RS_FIXTURE_ARM=born        in `_enter_tree`, before the main scene creates anything (the
##                              `born` leg, main scene res://born.tscn: every object is created
##                              armed, gate 0's rule)
##   RS_FIXTURE_ARM=late        (default) in `_process` at fixture frame K = RS_FIXTURE_ARM_FRAME
##                              (default 12), after adopt.tscn has drawn, moved, raised top-level
##                              items, hidden a subtree and changed a filter (the `late` leg: the
##                              capture adopts the scene, GRC_ADOPT=arm)
##   RS_FIXTURE_ARM=thread      at frame K too, but from a worker Thread (the `late-thread` leg:
##                              adoption refuses `adopt-thread`)
##   RS_FIXTURE_ARM=deferred    in `_enter_tree`, as `born`, but with adopt.tscn as the main scene
##                              (the `deferred` leg, LAR0): the hooks
##                              see every object created, and the capture itself defers its arm to
##                              frame K (the runner sets GRC_ARM_DEFER_FRAMES=K-1: the arm runs in
##                              the frame callback ending iteration K-1, so the walk is dated K).
##                              The loader also creates a texture, a mesh, a shader, a material and
##                              a canvas texture at frame 4 and frees them at frame 6, through
##                              RenderingServer, before the arm and outside the scene: the registry
##                              must see pre-arm frees (registry-live-bound); nothing reaches the
##                              stream, so the leg still equals `born` from K on
##   RS_FIXTURE_ARM=standby     as `deferred`, for a capture under GRC_MODE=standby:
## loaded at birth, the standby table
##                              published, never armed. The same frame-4 creates and frame-6 frees
##                              run, and the loader prints its own counts (`[fixture]
##                              registry-churn {...}`, also under `deferred`): the registry must
##                              record at least those creates (registry-live-bound against the
##                              fixture's own create count)
##
## An autoload enters the tree, and processes, ahead of the main scene, so at frame K the capture
## arms before the scene's own `_process` of that frame. `GRC_EXTENSION` unset: nothing is loaded
## (the `reference` leg).

const ARM_FRAME_DEFAULT: int = 12

var arm_mode: String = "late"
var arm_frame: int = ARM_FRAME_DEFAULT
var _frame: int = 0
var _armed: bool = false
var _thread: Thread
var _churn: Array[RID] = []


func _enter_tree() -> void:
	if OS.has_environment("RS_FIXTURE_ARM"):
		arm_mode = OS.get_environment("RS_FIXTURE_ARM")
	if OS.has_environment("RS_FIXTURE_ARM_FRAME"):
		var text: String = OS.get_environment("RS_FIXTURE_ARM_FRAME").strip_edges()
		if text.is_valid_int() and text.to_int() >= 8:
			arm_frame = text.to_int()
		else:
			printerr("[fixture] error: RS_FIXTURE_ARM_FRAME must be an integer >= 8 (got %s)" % JSON.stringify(text))
	if arm_mode != "born" and arm_mode != "late" and arm_mode != "thread" and arm_mode != "deferred" and arm_mode != "standby":
		printerr("[fixture] error: RS_FIXTURE_ARM must be born, late, thread, deferred or standby (got %s)" % JSON.stringify(arm_mode))
		arm_mode = "late"
	if arm_mode == "born" or arm_mode == "deferred" or arm_mode == "standby":
		_load(arm_mode)


func _process(_delta: float) -> void:
	_frame += 1
	if arm_mode == "deferred" or arm_mode == "standby":
		_registry_churn()
	if arm_mode == "late" and _frame == arm_frame:
		_load("late frame=%d" % _frame)
	elif arm_mode == "thread" and _frame == arm_frame:
		_thread = Thread.new()
		_thread.start(_load.bind("thread frame=%d" % _frame))
		_thread.wait_to_finish()


## LAR0: tracked creates and frees before the deferred arm.
func _registry_churn() -> void:
	if _frame == 4:
		var image: Image = Image.create(2, 2, false, Image.FORMAT_RGBA8)
		image.fill(Color8(40, 80, 160, 255))
		var shader: RID = RenderingServer.shader_create()
		_churn = [RenderingServer.texture_2d_create(image), RenderingServer.mesh_create(), shader,
			RenderingServer.material_create(), RenderingServer.canvas_texture_create()]
		RenderingServer.material_set_shader(_churn[3], shader)
	elif _frame == 6:
		var frees: int = 0
		for rid: RID in _churn:
			if rid.is_valid():
				RenderingServer.free_rid(rid)
				frees += 1
		_churn.clear()
		# LS1: the fixture's own tracked creates and frees, per registry family.
		print("[fixture] registry-churn " + JSON.stringify({
			"own_creates": {"texture": 1, "mesh": 1, "shader": 1, "material": 1, "canvas_texture": 1},
			"own_frees": frees,
		}))


func _load(when: String) -> void:
	if _armed:
		return
	_armed = true
	if not OS.has_environment("GRC_EXTENSION"):
		print("[fixture] extension load status=skipped (GRC_EXTENSION not set) arm=%s" % when)
		return
	var extension_path: String = OS.get_environment("GRC_EXTENSION")
	var status: GDExtensionManager.LoadStatus = GDExtensionManager.load_extension(extension_path)
	print("[fixture] extension load status=%s (%d) arm=%s path=%s" % [_status_name(status), status, when, extension_path])


func _status_name(status: GDExtensionManager.LoadStatus) -> String:
	match status:
		GDExtensionManager.LOAD_STATUS_OK:
			return "OK"
		GDExtensionManager.LOAD_STATUS_FAILED:
			return "FAILED"
		GDExtensionManager.LOAD_STATUS_ALREADY_LOADED:
			return "ALREADY_LOADED"
		GDExtensionManager.LOAD_STATUS_NOT_LOADED:
			return "NOT_LOADED"
		GDExtensionManager.LOAD_STATUS_NEEDS_RESTART:
			return "NEEDS_RESTART"
		_:
			return "UNKNOWN"
