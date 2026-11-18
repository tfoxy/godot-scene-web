extends Node2D
## VS5 viewport-perf `vfx6` scene: six SubViewports with update `always`, sized like the 2D effect
## surfaces of a real game's combat screen, each with 2D content that moves on every frame (several
## items with an additive `CanvasItemMaterial`), all shown by the root at once:
##
##   Doom           687x687  transparent  disc, rotating 12-point star (add), 8 orbiting spears (add)
##   CardIntent     256x256  transparent  a wobbling card shape and a circling glow (add)
##   PlayerIntentA  180x225  transparent  a bobbing marker and a rotating ring
##   PlayerIntentB  180x225  transparent  the same, the ring additive
##   Epoch          324x200  opaque       six stripes scrolling sideways (an RGB10A2 surface)
##   Enchant        144x108  transparent  six sparkles on Lissajous paths (add)
##
## Doom, CardIntent, Epoch and Enchant are shown by expand `TextureRect`s through scene
## `ViewportTexture`s (`viewport_path`), the transparent ones with a premultiplied-alpha material;
## PlayerIntentA and PlayerIntentB through `SubViewportContainer`s (stretch), whose viewport
## texture is the constructor's proxy. Motion is a function of game time only.

var _add: CanvasItemMaterial
## [node, kind, a, b]: kind 0 spin (a rad/s), 1 orbit (a rad/s, b radius, phase in meta), 2 bob
## (a amplitude), 3 scroll (a px/s, b wrap width), 4 lissajous (a, b frequencies), 5 pulse (a rate)
var _anim: Array[Array] = []


func _ready() -> void:
	_add = CanvasItemMaterial.new()
	_add.blend_mode = CanvasItemMaterial.BLEND_MODE_ADD
	_build_doom($Doom as SubViewport)
	_build_card($CardIntent as SubViewport)
	_build_intent($IntentBoxA/PlayerIntentA as SubViewport, false)
	_build_intent($IntentBoxB/PlayerIntentB as SubViewport, true)
	_build_epoch($Epoch as SubViewport)
	_build_enchant($Enchant as SubViewport)


## Called by main.gd every frame with the game time.
func tick(t: float) -> void:
	for entry: Array in _anim:
		var node: Node2D = entry[0]
		var kind: int = entry[1]
		var a: float = entry[2]
		var b: float = entry[3]
		var base: Vector2 = node.get_meta("base")
		var phase: float = node.get_meta("phase")
		match kind:
			0:
				node.rotation = phase + a * t
			1:
				var ang: float = phase + a * t
				node.position = base + Vector2(cos(ang), sin(ang)) * b
				node.rotation = ang
			2:
				node.position = base + Vector2(0, a * sin(TAU * 0.8 * t + phase))
			3:
				node.position = Vector2(fposmod(base.x + a * t, b) - b * 0.25, base.y)
			4:
				node.position = base + Vector2(40 * sin(a * t + phase), 30 * sin(b * t))
			5:
				var s: float = 1.0 + 0.12 * sin(a * t + phase)
				node.scale = Vector2(s, s)


func _build_doom(vp: SubViewport) -> void:
	var c: Vector2 = Vector2(vp.size) * 0.5
	var disc: Polygon2D = _poly(vp, _circle(220, 64), Color(0.35, 0.05, 0.4, 0.85), c)
	_animate(disc, 5, 2.0, 0)
	var star: Polygon2D = _poly(vp, _star(12, 300, 120), Color(0.6, 0.15, 0.7, 0.6), c, true)
	_animate(star, 0, 0.7, 0)
	for i: int in range(8):
		var spear: Polygon2D = _poly(vp, PackedVector2Array([Vector2(-6, -60), Vector2(6, -60), Vector2(2, 60), Vector2(-2, 60)]),
			Color(0.9, 0.4, 1.0, 0.8), c, true)
		spear.set_meta("phase", TAU * i / 8.0)
		_animate(spear, 1, 1.3, 260)


func _build_card(vp: SubViewport) -> void:
	var c: Vector2 = Vector2(vp.size) * 0.5
	var card: Polygon2D = _poly(vp, _rect(Vector2(150, 200)), Color(0.75, 0.7, 0.55, 1), c)
	card.set_meta("phase", 0.0)
	_animate(card, 5, 3.0, 0)
	var glow: Polygon2D = _poly(vp, _circle(40, 24), Color(0.3, 0.6, 1.0, 0.7), c, true)
	_animate(glow, 1, 2.1, 70)


func _build_intent(vp: SubViewport, additive_ring: bool) -> void:
	var c: Vector2 = Vector2(vp.size) * 0.5
	var ring: Polygon2D = _poly(vp, _star(16, 80, 64), Color(1.0, 0.75, 0.2, 0.7), c, additive_ring)
	_animate(ring, 0, -1.1 if additive_ring else 0.9, 0)
	var marker: Polygon2D = _poly(vp, PackedVector2Array([Vector2(-30, -20), Vector2(30, -20), Vector2(0, 34)]),
		Color(0.9, 0.2, 0.2, 1), c)
	_animate(marker, 2, 14.0, 0)


func _build_epoch(vp: SubViewport) -> void:
	_poly(vp, _rect(Vector2(vp.size)), Color(0.1, 0.12, 0.2, 1), Vector2(vp.size) * 0.5)
	var wrap: float = 324.0 * 1.5
	for i: int in range(6):
		var stripe: Polygon2D = _poly(vp, _rect(Vector2(40, 200)), Color.from_hsv(i / 6.0, 0.6, 0.8, 1),
			Vector2(i * wrap / 6.0, 100))
		_animate(stripe, 3, 90.0, wrap)


func _build_enchant(vp: SubViewport) -> void:
	var c: Vector2 = Vector2(vp.size) * 0.5
	for i: int in range(6):
		var spark: Polygon2D = _poly(vp, _star(4, 10, 3), Color(0.5, 1.0, 0.7, 0.9), c, true)
		spark.set_meta("phase", TAU * i / 6.0)
		_animate(spark, 4, 1.7 + 0.2 * i, 2.3 + 0.1 * i)


func _poly(parent: Node, points: PackedVector2Array, color: Color, at: Vector2, additive: bool = false) -> Polygon2D:
	var p: Polygon2D = Polygon2D.new()
	p.polygon = points
	p.color = color
	p.position = at
	if additive:
		p.material = _add
	p.set_meta("base", at)
	if not p.has_meta("phase"):
		p.set_meta("phase", 0.0)
	parent.add_child(p)
	return p


func _animate(node: Node2D, kind: int, a: float, b: float) -> void:
	_anim.append([node, kind, a, b])


func _circle(radius: float, count: int) -> PackedVector2Array:
	var out: PackedVector2Array = PackedVector2Array()
	for i: int in range(count):
		var ang: float = TAU * i / count
		out.append(Vector2(cos(ang), sin(ang)) * radius)
	return out


func _star(tips: int, outer: float, inner: float) -> PackedVector2Array:
	var out: PackedVector2Array = PackedVector2Array()
	for i: int in range(tips * 2):
		var ang: float = PI * i / tips
		out.append(Vector2(cos(ang), sin(ang)) * (outer if i % 2 == 0 else inner))
	return out


func _rect(size: Vector2) -> PackedVector2Array:
	var h: Vector2 = size * 0.5
	return PackedVector2Array([Vector2(-h.x, -h.y), Vector2(h.x, -h.y), Vector2(h.x, h.y), Vector2(-h.x, h.y)])
