extends Node2D
## Gate -1 spike: a small, fixed scene that drives engine-internal draws (ColorRect, Label glyphs)
## and direct RenderingServer calls (this script's own `_draw()`) every frame, so the capture
## library has one fixture that exercises both paths at once. See `expected.json` for the exact
## values this emits and `README.md` for how the runner drives it.

const SCRIPT_RECT: Rect2 = Rect2(213.25, 27.5, 101.125, 49.75)
const SCRIPT_RECT_COLOR: Color = Color(0.125, 0.5, 0.75, 1.0)
# `PackedVector2Array`/`PackedColorArray` built from an array of constructor calls are not constant
# expressions to the GDScript parser (only literal-only array constants are), so these are `var`
# rather than `const`; both are set once here and never reassigned.
var _polygon_points: PackedVector2Array = PackedVector2Array([
	Vector2(400.5, 40.25),
	Vector2(480.75, 60.5),
	Vector2(440.125, 120.875),
])
var _polygon_colors: PackedColorArray = PackedColorArray([
	Color(0.25, 0.5, 0.75, 1),
	Color(0.5, 0.25, 0.125, 1),
	Color(0.875, 0.625, 0.375, 1),
])

const RELABEL_FRAME: int = 30
const QUIT_FRAME: int = 400
const DEFAULT_SCREENSHOT_FRAME: int = 60

@onready var label: Label = $Label

var frame_count: int = 0
var draw_count: int = 0
var _screenshot_frame: int = DEFAULT_SCREENSHOT_FRAME
var _screenshot_taken: bool = false


func _ready() -> void:
	if OS.has_environment("GRC_SCREENSHOT_FRAME"):
		_screenshot_frame = int(OS.get_environment("GRC_SCREENSHOT_FRAME"))
	queue_redraw()


func _process(_delta: float) -> void:
	frame_count += 1

	if frame_count == RELABEL_FRAME:
		label.text = "Spike Ag Qz!"

	if frame_count == _screenshot_frame and not _screenshot_taken:
		_screenshot_taken = true
		_maybe_take_screenshot()

	if frame_count >= QUIT_FRAME:
		print("[fixture] draws=%d frames=%d" % [draw_count, frame_count])
		get_tree().quit(0)
		return

	queue_redraw()


func _draw() -> void:
	draw_count += 1
	RenderingServer.canvas_item_add_rect(get_canvas_item(), SCRIPT_RECT, SCRIPT_RECT_COLOR)
	RenderingServer.canvas_item_add_polygon(get_canvas_item(), _polygon_points, _polygon_colors)


## Rendered legs only: a truly headless run has no draw/present path to wait on (frame_post_draw
## is not relied upon there -- see experiments/render-stream fixtures/spike/README.md).
func _maybe_take_screenshot() -> void:
	if not OS.has_environment("GRC_SCREENSHOT"):
		return
	if DisplayServer.get_name() == "headless":
		print("[fixture] screenshot skipped (headless)")
		return

	var out_path: String = OS.get_environment("GRC_SCREENSHOT")
	await RenderingServer.frame_post_draw
	var image: Image = get_viewport().get_texture().get_image()
	var err: Error = image.save_png(out_path)
	print("[fixture] screenshot saved=%s err=%d" % [out_path, err])
