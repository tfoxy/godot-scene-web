extends Node
## Gate 0 fixture main scene. The root is a plain `Node`, not a `CanvasItem`: `GrcLoader`
## (autoload, `loader.gd`) arms the capture extension in its own `_enter_tree()`, which runs before
## this node's children enter the tree (see ../../protocol/gate0-design.md "Startup order on
## 4.5.1" -- route (a)), so every `CanvasItem` created below in `_ready()` is created strictly
## after arming and the mirror sees each one's `canvas_item_create`.
##
## `preexisting.tscn` reuses this same script on a scene that also declares a static
## `Preexisting` child node directly in the `.tscn`: that one is constructed while the scene is
## instantiated, which happens before arming, so it is deliberately NOT part of this script.
##
## See fixtures/gate0/README.md and ../../protocol/gate0-design.md "Q2. Fixture" / "Timeline" for
## the exact frames, positions and colours reproduced here; expected.json is the single source of
## truth for those numbers and this script's literals must match it exactly.

## A `Node2D` whose `_draw()` paints one axis-aligned rect and, when `circle` is set, one black
## circle on top -- the extra `canvas_item_add_circle` call the `unsupported` variant adds on the
## Marker (an op gate 0's mirror does not model; see render-stream-0.md).
class RectNode extends Node2D:
	var rect: Rect2
	var color: Color
	var circle: bool = false

	func _draw() -> void:
		draw_rect(rect, color)
		if circle:
			draw_circle(Vector2(16, 16), 8.0, Color(0, 0, 0, 1))


const QUIT_FRAME_DEFAULT: int = 52
const STEP_SPAN: int = 10
const SETTLE_OFFSET: int = 7
const LAST_STEP: int = 4

const SUBJECT_RECT: Rect2 = Rect2(0, 0, 96, 64)
const MARKER_RECT: Rect2 = Rect2(0, 0, 32, 32)
const MARKER_POSITION: Vector2 = Vector2(16, 16)

const SUBJECT_INITIAL_POSITION: Vector2 = Vector2(160, 96)
const SUBJECT_INITIAL_COLOR: Color = Color(1, 0.4, 0, 1)
const MARKER_INITIAL_COLOR: Color = Color(1, 1, 1, 1)

var subject: RectNode
var marker: RectNode

var _frame: int = 0
var _quit_frame: int = QUIT_FRAME_DEFAULT
var _variant: String = ""
var _shot_dir: String = ""
var _step_log_file: FileAccess


func _ready() -> void:
	var variant: String = ""
	if OS.has_environment("RS_FIXTURE_VARIANT"):
		variant = OS.get_environment("RS_FIXTURE_VARIANT")
	if variant != "" and variant != "unsupported":
		push_error("[fixture] unknown RS_FIXTURE_VARIANT=%s" % variant)
		get_tree().quit(2)
		return
	_variant = variant

	if OS.has_environment("RS_FIXTURE_QUIT_FRAME"):
		_quit_frame = int(OS.get_environment("RS_FIXTURE_QUIT_FRAME"))

	if OS.has_environment("RS_FIXTURE_STEP_LOG"):
		_step_log_file = FileAccess.open(OS.get_environment("RS_FIXTURE_STEP_LOG"), FileAccess.WRITE)

	if OS.has_environment("RS_FIXTURE_SHOT_DIR"):
		_shot_dir = OS.get_environment("RS_FIXTURE_SHOT_DIR")

	subject = RectNode.new()
	subject.name = "Subject"
	subject.rect = SUBJECT_RECT
	subject.color = SUBJECT_INITIAL_COLOR
	subject.position = SUBJECT_INITIAL_POSITION
	add_child(subject)

	marker = RectNode.new()
	marker.name = "Marker"
	marker.rect = MARKER_RECT
	marker.color = MARKER_INITIAL_COLOR
	marker.position = MARKER_POSITION
	add_child(marker)

	# Step 0 is the `_ready` state: it is "applied" here, not in `_process` (see
	# gate0-design.md "Timeline"), at the frame stamp the capture library assigns to everything
	# that runs during `initialize()`.
	_log_step(0, 1, 1 + SETTLE_OFFSET)


func _process(_delta: float) -> void:
	_frame += 1

	var apply_step: int = _step_for_applied_frame(_frame)
	if apply_step != -1:
		_apply_step(apply_step)
		_log_step(apply_step, _frame, _frame + SETTLE_OFFSET)

	var settle_step: int = _step_for_settle_frame(_frame)
	if settle_step != -1:
		_maybe_take_shot(settle_step)

	if _frame >= _quit_frame:
		print("[fixture] quitting frame=%d" % _frame)
		get_tree().quit(0)
		return


func _step_for_applied_frame(frame: int) -> int:
	if frame % STEP_SPAN != 1:
		return -1
	var step: int = frame / STEP_SPAN
	if step < 1 or step > LAST_STEP:
		return -1
	return step


func _step_for_settle_frame(frame: int) -> int:
	if frame < SETTLE_OFFSET or (frame - SETTLE_OFFSET) % STEP_SPAN != 1:
		return -1
	var step: int = (frame - SETTLE_OFFSET) / STEP_SPAN
	if step < 0 or step > LAST_STEP:
		return -1
	return step


func _apply_step(step: int) -> void:
	match step:
		1:
			subject.position = Vector2(288, 96)
		2:
			subject.color = Color(0, 0.6, 1, 1)
			subject.queue_redraw()
		3:
			subject.position = Vector2(416, 224)
			subject.color = Color(0.8, 0.2, 0.6, 1)
			subject.queue_redraw()
		4:
			pass

	marker.color = _marker_color_for_step(step)
	marker.queue_redraw()
	if _variant == "unsupported" and step >= 2:
		marker.circle = true


func _marker_color_for_step(step: int) -> Color:
	match step:
		1:
			return Color(1, 1, 0, 1)
		2:
			return Color(0, 1, 1, 1)
		3:
			return Color(1, 0, 1, 1)
		4:
			return Color(0, 1, 0, 1)
		_:
			return MARKER_INITIAL_COLOR


func _log_step(step: int, applied_frame: int, settle_frame: int) -> void:
	if _step_log_file == null:
		return
	var line: String = "{\"step\":%d,\"applied_frame\":%d,\"settle_frame\":%d}" % [step, applied_frame, settle_frame]
	_step_log_file.store_line(line)
	_step_log_file.flush()


## Rendered legs only: a truly headless run has no draw/present path to wait on (frame_post_draw
## is not relied upon there -- see fixtures/spike/README.md and spike.gd's own
## `_maybe_take_screenshot`, which this mirrors). Called without `await` from `_process`, so this
## coroutine keeps running in the background while `_process` keeps advancing frames.
func _maybe_take_shot(step: int) -> void:
	if _shot_dir == "":
		return
	if DisplayServer.get_name() == "headless":
		print("[fixture] shot skipped (headless)")
		return

	var out_path: String = _shot_dir.path_join("step-%d.png" % step)
	await RenderingServer.frame_post_draw
	var image: Image = get_viewport().get_texture().get_image()
	var err: Error = image.save_png(out_path)
	print("[fixture] shot saved=%s err=%d" % [out_path, err])
