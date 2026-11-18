extends Node2D
## VS5 viewport-perf `draw` scene: the drawing-surface case. `MapDrawing` is one transparent
## 960x1620 SubViewport (update `always`, 3D off) shown by an expand `TextureRect` (600x1012, a
## premultiplied-alpha `CanvasItemMaterial`) through a scene `ViewportTexture` (`viewport_path`),
## over an opaque map pane. Inside it: three finished strokes (`Line2D`, 300 points each), an
## eraser `Line2D` (a `blend_sub` ShaderMaterial over a synthetic 32x32 radial falloff in tile
## mode) and `LiveStroke`.
##
##   phase `active`  LiveStroke gains one point per 1/60 s of game time and restarts on a new curve
##                   every 300 points (5 s), so the surface's canvas changes on every host frame and
##                   a receiver re-renders the whole surface every frame (the worst case)
##   phase `idle`    LiveStroke is a finished 300-point stroke and nothing inside the surface ever
##                   changes after the first frame (the idempotent skip should make the surface
##                   cost about nothing; only the root heartbeat moves)

const SIZE: Vector2 = Vector2(960, 1620)
const POINTS: int = 300
const TICKS_PER_SECOND: float = 60.0
## Per stroke: x frequency, y frequency, x phase (turns). LiveStroke cycles through LIVE_CURVES.
const STATIC_CURVES: Array[Vector3] = [Vector3(1.0, 2.0, 0.0), Vector3(3.0, 1.0, 0.25), Vector3(2.0, 3.0, 0.5)]
const LIVE_CURVES: Array[Vector3] = [Vector3(1.0, 3.0, 0.1), Vector3(2.0, 1.0, 0.6), Vector3(3.0, 2.0, 0.35)]
const ERASER_CURVE: Vector3 = Vector3(1.0, 1.0, 0.125)
const ERASER_POINTS: int = 60

var phase: String = "active"

var _live: Line2D
var _live_cycle: int = -1


static func curve_point(curve: Vector3, u: float) -> Vector2:
	var c: Vector2 = SIZE * 0.5
	return c + Vector2(
		0.42 * SIZE.x * sin(TAU * (curve.x * u + curve.z)),
		0.46 * SIZE.y * sin(TAU * curve.y * u))


static func curve_points(curve: Vector3, count: int, total: int) -> PackedVector2Array:
	var out: PackedVector2Array = PackedVector2Array()
	for i: int in range(count):
		out.append(curve_point(curve, float(i) / float(total - 1)))
	return out


func _ready() -> void:
	for i: int in range(STATIC_CURVES.size()):
		var stroke: Line2D = get_node("MapDrawing/Stroke%d" % i)
		stroke.points = curve_points(STATIC_CURVES[i], POINTS, POINTS)
	var eraser: Line2D = $MapDrawing/Eraser
	eraser.texture = ImageTexture.create_from_image(_falloff(32))
	eraser.points = curve_points(ERASER_CURVE, ERASER_POINTS, ERASER_POINTS)
	_live = $MapDrawing/LiveStroke
	if phase == "idle":
		_live.points = curve_points(LIVE_CURVES[0], POINTS, POINTS)


## Called by main.gd every frame with the game time.
func tick(t: float) -> void:
	if phase != "active":
		return
	var k: int = int(floorf(t * TICKS_PER_SECOND))
	var cycle: int = k / POINTS
	var want: int = k % POINTS + 1
	var curve: Vector3 = LIVE_CURVES[cycle % LIVE_CURVES.size()]
	if cycle != _live_cycle:
		_live_cycle = cycle
		_live.points = curve_points(curve, want, POINTS)
		return
	for i: int in range(_live.get_point_count(), want):
		_live.add_point(curve_point(curve, float(i) / float(POINTS - 1)))


## A radial alpha falloff (white, alpha 1 at the centre to 0 at the rim): the eraser's brush.
func _falloff(side: int) -> Image:
	var image: Image = Image.create_empty(side, side, false, Image.FORMAT_RGBA8)
	var c: float = (side - 1) * 0.5
	for y: int in range(side):
		for x: int in range(side):
			var d: float = Vector2(x - c, y - c).length() / c
			image.set_pixel(x, y, Color(1, 1, 1, clampf(1.0 - d * d, 0.0, 1.0)))
	return image
