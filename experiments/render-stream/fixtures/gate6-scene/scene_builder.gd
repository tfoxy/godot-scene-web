extends RefCounted
## The gate 6 combined scene (../../protocol/gate6-design.md "Q6b", "Q6c", "Q6d"), built under one
## top-level `Scene` Control. One instance is one 640x360 copy: `gate6_scene.gd` builds one at the
## origin (cell 0, phase 0); G6h's `gate6-hd` builds nine, each with its own origin, cell index c
## (TEXA content offset 100c, HUD layer 1 + c) and phase phi (frames).
##
## Every CanvasItem, material, shader and texture is created in `build()`, which the owner calls
## from `_ready()` after `GrcLoader` armed the capture (gate 0 route (a)). Construction order is the
## wire id order (expected.json `creation_order`, internal children included). Paint order is tree
## order: `BG` first, then every region in Q6b's table order; `ZH` paints last in the root canvas
## (z_index 100); the HUD is its own canvas.
##
## Time (D6). `steps` mode: the tween is paused and driven by `custom_step(1/60)` and both
## AnimationPlayers use ANIMATION_CALLBACK_MODE_PROCESS_MANUAL with `advance(1/60)`, once per
## fixture frame (`on_frame`). Both clocks start a quarter frame in (`TIME_OFFSET_FRAMES`) plus the
## phase, so at fixture frame f each animation reads its value at (f + phi + 1/4)/60 s: every key,
## loop boundary and rounding threshold is at least a quarter frame away, and float accumulation
## can never pick the neighbouring value. `realtime` mode: the tween and the players run on process
## delta and `on_frame` only drives the mesh and the `animate` writes.

const TIME_OFFSET_FRAMES: float = 0.25
const FPS: float = 60.0

## Gate 1's marker colours, steps 0..11.
const MARKER_COLORS: Array[Color] = [
	Color(0, 0, 0, 1),
	Color(1, 1, 0, 1),
	Color(0, 1, 1, 1),
	Color(0.4, 0, 0.4, 1),
	Color(0, 0.4, 0, 1),
	Color(0.4, 0, 0, 1),
	Color(0, 0, 0.4, 1),
	Color(0.8, 0.4, 0.8, 1),
	Color(0.4, 0.6, 0.8, 1),
	Color(0.8, 0.6, 0.4, 1),
	Color(0.2, 0.6, 0.2, 1),
	Color(1, 0.2, 1, 1),
]

const BG_COLOR: Color = Color(0.2, 0.2, 0.2, 1)
const BG_SIZE: Vector2 = Vector2(640, 344)

## `SC` rows: row r's ColorRect colour (row 8 is appended at step 9).
const ROW_COLORS: Array[Color] = [
	Color(1, 0.4, 0.4, 1),
	Color(1, 0.8, 0.2, 1),
	Color(0.6, 1, 0.4, 1),
	Color(0.2, 0.8, 0.8, 1),
	Color(0.4, 0.6, 1, 1),
	Color(0.8, 0.4, 1, 1),
	Color(1, 0.6, 0.8, 1),
	Color(0.8, 0.8, 0.8, 1),
	Color(1, 1, 1, 1),
]
const ROW_COUNT: int = 8
const ROW_RECT: Vector2 = Vector2(24, 20)
const ROW_FONT_SIZE: int = 14
const SC_POS: Vector2 = Vector2(8, 8)
const SC_SIZE: Vector2 = Vector2(168, 112)

const RT_POS: Vector2 = Vector2(184, 8)
const RT_SIZE: Vector2 = Vector2(200, 112)
const TR_POS: Vector2 = Vector2(392, 8)
const NP_POS: Vector2 = Vector2(464, 8)
const NP_SIZE: Vector2 = Vector2(96, 64)
const MARKER_POS: Vector2 = Vector2(592, 16)
const ZH_POS: Vector2 = Vector2(400, 84)
const ZH_SIZE: Vector2 = Vector2(112, 32)
const ZH_COLOR: Color = Color(0.8, 0.2, 0.2, 1)
const HUD_POS: Vector2 = Vector2(456, 88)
const HUD_SIZE: Vector2 = Vector2(168, 28)
const HUD_COLOR: Color = Color(0.2, 0.8, 0.8, 1)
const HUD_LABEL_POS: Vector2 = Vector2(8, 2)
const PB_POS: Vector2 = Vector2(8, 128)
const PB_SIZE: Vector2 = Vector2(168, 24)
const PB_FONT_SIZE: int = 12
const BT_POS: Vector2 = Vector2(8, 160)
const BT_SIZE: Vector2 = Vector2(120, 32)
const LE_POS: Vector2 = Vector2(8, 200)
const LE_SIZE: Vector2 = Vector2(168, 32)
const CD_POS: Vector2 = Vector2(184, 128)
const CD_SIZE: Vector2 = Vector2(120, 104)
const MS_POS: Vector2 = Vector2(312, 128)
const SM_POS: Vector2 = Vector2(424, 128)
const SM_SIZE: Vector2 = Vector2(64, 48)
const SM_TINT: Color = Color(1, 1, 0, 1)
const SM_TINT_STEP4: Color = Color(1, 0, 1, 1)
const CM_UNDER_POS: Vector2 = Vector2(496, 128)
const CM_UNDER_SIZE: Vector2 = Vector2(48, 40)
const CM_UNDER_COLOR: Color = Color(0.4, 0.6, 0.2, 1)
const CM_OVER_POS: Vector2 = Vector2(512, 144)
const CM_OVER_SIZE: Vector2 = Vector2(48, 32)
const CM_OVER_COLOR: Color = Color(0.4, 0.2, 0.6, 1)
const HB_POS: Vector2 = Vector2(8, 248)
const HB_SIZE: Vector2 = Vector2(400, 48)
const HB_SIZE_STEP7: Vector2 = Vector2(496, 48)
const HB_SEPARATION: int = 8
const AN_FROM: Vector2 = Vector2(512, 256)
const AN_TO: Vector2 = Vector2(600, 256)
const AN_PERIOD_FRAMES: int = 88
const LB_POS: Vector2 = Vector2(8, 304)
const LB_SIZE: Vector2 = Vector2(320, 32)
const TL_POS: Vector2 = Vector2(600, 344)
const TL_SIZE: Vector2 = Vector2(16, 16)
const TL_COLOR: Color = Color(1, 1, 0.6, 1)

## `SM`'s phase: a discrete key every 4 frames, values 0..5, loop 24 frames.
const PHASE_KEY_FRAMES: int = 4
const PHASE_PERIOD_FRAMES: int = 24
## `PB`'s tween: 0 -> 100 over 300 frames, looping.
const PB_PERIOD_FRAMES: int = 300
const PB_FREEZE_VALUE: float = 40.0
## `MS`: column i's two vertices move by round(8 sin(2 pi (f + phi + 6i) / 90)) in y.
const MS_COLUMNS: int = 8
const MS_DX: float = 12.0
const MS_TOP: float = 12.0
const MS_BOTTOM: float = 40.0
const MS_AMPLITUDE: float = 8.0
const MS_PERIOD_FRAMES: int = 90
const MS_COLUMN_PHASE: int = 6
const MS_TOP_COLOR: Color = Color(1, 0.8, 0.2, 1)
const MS_BOTTOM_COLOR: Color = Color(0.2, 0.4, 1, 1)
## `animate` (Q6d).
const ANIMATE_TEXA_FRAMES: int = 30
const ANIMATE_LB_FRAMES: int = 30
const ANIMATE_SCROLL_PERIOD: int = 152
const ANIMATE_CD_FRAMES: int = 15
const SC_SCROLL_MAX: int = 76

## `TEXN` (gate 5g's): 16x16, a 4-texel border around an 8x8 centre of 2x2 cells.
const TEXN_BORDER: Color = Color(1, 1, 0.6, 1)
const TEXN_MARK: Color = Color(1, 0.4, 0.4, 1)
const TEXN_A: Color = Color(0.4, 0.2, 0.8, 1)
const TEXN_B: Color = Color(0.2, 0.8, 0.6, 1)
## `TEXA(n)`'s palette: sixteen distinct 0.2-grid colours; content n uses PALETTE[(5n + 3j) mod 16]
## for j = 0..3, cell (cx, cy) colour j = (cx + 2 cy) mod 4, plus n's 12 bits as 4x4 blocks in
## the top row (LSB first, white = 1).
const TEXA_PALETTE: Array[Color] = [
	Color(1, 0.4, 0.2, 1),
	Color(0.2, 0.6, 1, 1),
	Color(0.8, 1, 0.2, 1),
	Color(0.6, 0.2, 0.8, 1),
	Color(1, 0.8, 0.6, 1),
	Color(0.2, 0.8, 0.4, 1),
	Color(0.4, 0.4, 0.8, 1),
	Color(1, 0.2, 0.6, 1),
	Color(0.6, 0.6, 0.2, 1),
	Color(0.2, 0.4, 0.4, 1),
	Color(0.8, 0.6, 1, 1),
	Color(0.4, 1, 0.8, 1),
	Color(1, 1, 0.4, 1),
	Color(0.6, 0.2, 0.2, 1),
	Color(0.2, 1, 1, 1),
	Color(0.8, 0.4, 0.6, 1),
]
const TEXA_SIZE: int = 64
const TEXA_CELL: int = 8
const TEXA_BITS: int = 12
const TEXA_BIT_BLOCK: int = 4
const TEXB_CONTENT: int = 1000
const TEXA_CELL_OFFSET: int = 100

## `RT`'s text (bbcode): before step 9 line 2 is TEXA as a 64x64 inline image.
const RT_LINES: Array[String] = [
	"[color=#ffcc66]RichText line 0[/color]",
	"[b]bold line 1[/b]",
	"",
	"[color=#66ccff]line 3[/color]",
	"line 4 plain",
	"[b][color=#99ff99]line 5 bold[/color][/b]",
	"line 6 plain",
	"[color=#ff99cc]line 7[/color]",
	"line 8 end",
]
const RT_LINES_STEP9: Array[String] = [
	"[color=#ffcc66]RichText line 0[/color]",
	"[b]bold line 1[/b]",
	"[color=#cccccc]image removed[/color]",
	"[color=#66ccff]line 3[/color]",
	"line 4 plain",
	"[b][color=#99ff99]line 5 bold[/color][/b]",
	"line 6 plain",
	"[color=#ff99cc]line 7[/color]",
	"line 8 end",
]
const RT_SCROLL_LINE: int = 4

## The custom draw `CD` (local to its Control): k shifts the polygon by (8k, 0).
const CD_RECT: Rect2 = Rect2(8, 8, 48, 32)
const CD_RECT_COLOR: Color = Color(0.8, 0.4, 0.2, 1)
const CD_LINE_FROM: Vector2 = Vector2(64, 8)
const CD_LINE_TO: Vector2 = Vector2(112, 40)
const CD_LINE_COLOR: Color = Color(1, 1, 0.6, 1)
const CD_LINE_WIDTH: float = 2.0
const CD_POLYLINE: Array[Vector2] = [Vector2(8, 44), Vector2(24, 52), Vector2(40, 44), Vector2(56, 52)]
const CD_POLYLINE_COLOR: Color = Color(0.4, 1, 0.4, 1)
const CD_POLYLINE_WIDTH: float = 2.0
const CD_CIRCLE_CENTRE: Vector2 = Vector2(32, 72)
const CD_CIRCLE_RADIUS: float = 16.0
const CD_CIRCLE_COLOR: Color = Color(0.2, 0.6, 1, 1)
const CD_POLYGON: Array[Vector2] = [Vector2(60, 90), Vector2(76, 88), Vector2(84, 96), Vector2(72, 102), Vector2(62, 100)]
const CD_POLYGON_COLOR: Color = Color(1, 0.6, 0.8, 1)
const CD_POLYGON_STEP: Vector2 = Vector2(8, 0)
const CD_TEXTURE_RECT: Rect2 = Rect2(72, 56, 32, 32)

## The refused variant's region `RF` (Q6d), local positions.
const RF_PARTICLES_POS: Vector2 = Vector2(360, 320)
const RF_LIGHT_POS: Vector2 = Vector2(420, 320)
const RF_TIME_POS: Vector2 = Vector2(472, 304)
const RF_TIME_SIZE: Vector2 = Vector2(32, 32)
const RF_LCD_POS: Vector2 = Vector2(520, 304)
## G6b: a `follow_viewport` CanvasLayer (layer 2) holding one ColorRect. The host composes the root
## canvas transform into it (rv.cpp:60-67), a /6 receiver does not (canvas-follow-viewport): the
## rect is placed so both positions, before and after step 10's (8, 4) shift, stay inside RF.
const RF_FOLLOW_LAYER: int = 2
const RF_FOLLOW_POS: Vector2 = Vector2(592, 308)
const RF_FOLLOW_SIZE: Vector2 = Vector2(24, 24)
const RF_FOLLOW_COLOR: Color = Color(1, 0.6, 0.2, 1)


## The step marker: a `Node2D` drawing one axis-aligned rect (gates 1 to 5.5).
class RectNode extends Node2D:
	var rect: Rect2 = Rect2()
	var color: Color = Color.BLACK

	func _draw() -> void:
		draw_rect(rect, color)

	func set_color(new_color: Color) -> void:
		color = new_color
		queue_redraw()


## `CD`: the custom `_draw` of Q6b; `k` moves the polygon.
class CustomDraw extends Control:
	var k: int = 0
	var texture: Texture2D

	func _draw() -> void:
		draw_rect(CD_RECT, CD_RECT_COLOR)
		draw_line(CD_LINE_FROM, CD_LINE_TO, CD_LINE_COLOR, CD_LINE_WIDTH)
		draw_polyline(PackedVector2Array(CD_POLYLINE), CD_POLYLINE_COLOR, CD_POLYLINE_WIDTH)
		draw_circle(CD_CIRCLE_CENTRE, CD_CIRCLE_RADIUS, CD_CIRCLE_COLOR)
		var points: PackedVector2Array = PackedVector2Array()
		var shift: Vector2 = CD_POLYGON_STEP * float(k)
		for p: Vector2 in CD_POLYGON:
			points.append(p + shift)
		draw_colored_polygon(points, CD_POLYGON_COLOR)
		draw_texture_rect(texture, CD_TEXTURE_RECT, false)

	func set_k(value: int) -> void:
		if value == k:
			return
		k = value
		queue_redraw()


var origin: Vector2 = Vector2.ZERO
var cell: int = 0
var phase: int = 0
var variant: String = ""
var realtime: bool = false

var texn: ImageTexture
var texa: ImageTexture
var texb: ImageTexture
var texa_content: int = 0

var scene: Control
var bg: Panel
var sc: ScrollContainer
var vbox: VBoxContainer
var rows: Array[HBoxContainer] = []
var row_labels: Array[Label] = []
var rt: RichTextLabel
var tr: TextureRect
var np: NinePatchRect
var marker: RectNode
var zh: ColorRect
var pb: ProgressBar
var bt: Button
var le: LineEdit
var cd: CustomDraw
var ms: MeshInstance2D
var ms_mesh: ArrayMesh
var sm: ColorRect
var sm_shader: Shader
var sm_material: ShaderMaterial
var cm_under: ColorRect
var cm_over: ColorRect
var cm_material: CanvasItemMaterial
var hb: HBoxContainer
var hb_panels: Array[Panel] = []
var an: Sprite2D
var lb: Label
var tl: ColorRect
var hud: CanvasLayer
var hud_panel: Panel
var hud_label: Label
var sm_player: AnimationPlayer
var an_player: AnimationPlayer
var tween: Tween
var rf_nodes: Array[Node] = []
var rf_time_shader: Shader
var rf_lcd_font: FontFile

var frozen: bool = false
var _last_texa_period: int = -1
var _last_lb_period: int = -1
var _last_cd_period: int = -1
var _ms_pose_frame: int = -1


## Builds the scene under `parent` (the plain root `Node`). Construction order below is the wire
## id order; do not reorder it without regenerating expected.json.
func build(parent: Node, at: Vector2, cell_index: int, phase_frames: int, variant_name: String, realtime_mode: bool) -> void:
	origin = at
	cell = cell_index
	phase = phase_frames
	variant = variant_name
	realtime = realtime_mode

	# Textures first (after the engine's hue strip): TEXN, TEXA(0 + 100c), TEXB.
	texn = ImageTexture.create_from_image(texn_image())
	texa_content = TEXA_CELL_OFFSET * cell
	texa = ImageTexture.create_from_image(texa_image(texa_content))
	texb = ImageTexture.create_from_image(texa_image(TEXB_CONTENT + TEXA_CELL_OFFSET * cell))

	scene = Control.new()
	scene.name = "Scene"
	scene.position = origin
	scene.size = Vector2(640, 360)
	scene.mouse_filter = Control.MOUSE_FILTER_IGNORE

	bg = Panel.new()
	bg.name = "BG"
	bg.size = BG_SIZE
	bg.add_theme_stylebox_override("panel", flat_box(BG_COLOR))
	_ignore(bg)
	scene.add_child(bg)

	_build_scroll()
	_build_rich_text()

	tr = TextureRect.new()
	tr.name = "TR"
	tr.position = TR_POS
	tr.texture = texa
	tr.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	_ignore(tr)
	scene.add_child(tr)

	np = NinePatchRect.new()
	np.name = "NP"
	np.position = NP_POS
	np.size = NP_SIZE
	np.texture = texn
	np.patch_margin_left = 4
	np.patch_margin_top = 4
	np.patch_margin_right = 4
	np.patch_margin_bottom = 4
	np.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	_ignore(np)
	scene.add_child(np)

	marker = RectNode.new()
	marker.name = "Marker"
	marker.position = MARKER_POS
	marker.rect = Rect2(0, 0, 32, 32)
	marker.color = MARKER_COLORS[0]
	scene.add_child(marker)

	zh = ColorRect.new()
	zh.name = "ZH"
	zh.position = ZH_POS
	zh.size = ZH_SIZE
	zh.color = ZH_COLOR
	zh.z_index = 100
	_ignore(zh)
	scene.add_child(zh)

	pb = ProgressBar.new()
	pb.name = "PB"
	pb.position = PB_POS
	pb.size = PB_SIZE
	pb.show_percentage = true
	pb.add_theme_font_size_override("font_size", PB_FONT_SIZE)
	_ignore(pb)
	scene.add_child(pb)

	bt = Button.new()
	bt.name = "BT"
	bt.position = BT_POS
	bt.size = BT_SIZE
	bt.text = "Play"
	bt.focus_mode = Control.FOCUS_NONE
	_ignore(bt)
	scene.add_child(bt)

	le = LineEdit.new()
	le.name = "LE"
	le.position = LE_POS
	le.size = LE_SIZE
	le.text = "edit me"
	le.caret_force_displayed = true
	le.caret_blink = false
	_ignore(le)
	scene.add_child(le)

	cd = CustomDraw.new()
	cd.name = "CD"
	cd.position = CD_POS
	cd.size = CD_SIZE
	cd.texture = texn
	cd.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	_ignore(cd)
	scene.add_child(cd)

	ms_mesh = ArrayMesh.new()
	ms_mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, _ms_arrays(_pose_frame(0)), [], {}, Mesh.ARRAY_FLAG_USE_DYNAMIC_UPDATE)
	ms = MeshInstance2D.new()
	ms.name = "MS"
	ms.position = MS_POS
	ms.mesh = ms_mesh
	scene.add_child(ms)

	sm_shader = load("res://shaders/phase_tint.gdshader") as Shader
	sm_material = ShaderMaterial.new()
	sm_material.shader = sm_shader
	sm_material.set_shader_parameter("phase", 0)
	sm_material.set_shader_parameter("tint", SM_TINT)
	sm = ColorRect.new()
	sm.name = "SM"
	sm.position = SM_POS
	sm.size = SM_SIZE
	sm.material = sm_material
	_ignore(sm)
	scene.add_child(sm)

	cm_under = ColorRect.new()
	cm_under.name = "CMU"
	cm_under.position = CM_UNDER_POS
	cm_under.size = CM_UNDER_SIZE
	cm_under.color = CM_UNDER_COLOR
	_ignore(cm_under)
	scene.add_child(cm_under)
	cm_material = CanvasItemMaterial.new()
	cm_material.blend_mode = CanvasItemMaterial.BLEND_MODE_ADD
	cm_over = ColorRect.new()
	cm_over.name = "CMO"
	cm_over.position = CM_OVER_POS
	cm_over.size = CM_OVER_SIZE
	cm_over.color = CM_OVER_COLOR
	cm_over.material = cm_material
	_ignore(cm_over)
	scene.add_child(cm_over)

	hb = HBoxContainer.new()
	hb.name = "HB"
	hb.position = HB_POS
	hb.size = HB_SIZE
	hb.add_theme_constant_override("separation", HB_SEPARATION)
	_ignore(hb)
	var bordered: StyleBoxFlat = flat_box(Color(0.2, 0.4, 0.8, 1))
	bordered.border_color = Color(1, 1, 0.6, 1)
	bordered.set_border_width_all(4)
	var rounded: StyleBoxFlat = flat_box(Color(1, 0.4, 0.4, 1))
	rounded.set_corner_radius_all(8)
	var boxes: Array[StyleBoxFlat] = [flat_box(Color(0.4, 0.8, 0.4, 1)), bordered, rounded]
	for i: int in range(3):
		var panel: Panel = Panel.new()
		panel.name = "HB%d" % i
		panel.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		panel.add_theme_stylebox_override("panel", boxes[i])
		_ignore(panel)
		hb_panels.append(panel)
		hb.add_child(panel)
	scene.add_child(hb)

	an = Sprite2D.new()
	an.name = "AN"
	an.texture = texn
	an.centered = false
	an.scale = Vector2(2, 2)
	an.position = AN_FROM
	an.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	scene.add_child(an)

	lb = Label.new()
	lb.name = "LB"
	lb.position = LB_POS
	lb.size = LB_SIZE
	lb.text = "Frame 0000"
	_ignore(lb)
	scene.add_child(lb)

	if variant == "refused":
		_build_refused()

	hud = CanvasLayer.new()
	hud.name = "HUD"
	hud.layer = 1 + cell
	hud_panel = Panel.new()
	hud_panel.name = "HUDPanel"
	hud_panel.position = origin + HUD_POS
	hud_panel.size = HUD_SIZE
	hud_panel.add_theme_stylebox_override("panel", flat_box(HUD_COLOR))
	_ignore(hud_panel)
	hud_label = Label.new()
	hud_label.name = "HUDLabel"
	hud_label.position = HUD_LABEL_POS
	hud_label.text = "HUD"
	_ignore(hud_label)
	hud_panel.add_child(hud_label)
	hud.add_child(hud_panel)
	scene.add_child(hud)

	_build_players()
	parent.add_child(scene)
	# PB's minimum size first comes from the theme's 16 px font (100% at 16 px: 4 + 23); in the
	# tree it is the override's 12 px, but a free Control never shrinks to a smaller minimum on
	# its own (memory rs-g4c-layout-facts): set the box again.
	pb.size = PB_SIZE
	le.select(0, 4)
	le.grab_focus()
	_start_players()
	_build_tween()


func _build_scroll() -> void:
	sc = ScrollContainer.new()
	sc.name = "SC"
	sc.position = SC_POS
	sc.size = SC_SIZE
	sc.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	_ignore(sc)
	vbox = VBoxContainer.new()
	vbox.name = "Rows"
	vbox.add_theme_constant_override("separation", 4)
	_ignore(vbox)
	for r: int in range(ROW_COUNT):
		var row: HBoxContainer = _row(r)
		rows.append(row)
		vbox.add_child(row)
		if r == 3:
			# `TL`: top_level, child of row 3's HBoxContainer: never moved by the scroll, never
			# clipped (gate 3's deferred top_level escape); the container ignores it.
			tl = ColorRect.new()
			tl.name = "TL"
			tl.top_level = true
			tl.position = origin + TL_POS
			tl.size = TL_SIZE
			tl.color = TL_COLOR
			_ignore(tl)
			row.add_child(tl)
	sc.add_child(vbox)
	scene.add_child(sc)


func _row(r: int) -> HBoxContainer:
	var row: HBoxContainer = HBoxContainer.new()
	row.name = "Row%d" % r
	_ignore(row)
	var rect: ColorRect = ColorRect.new()
	rect.name = "R%d" % r
	rect.custom_minimum_size = ROW_RECT
	rect.color = ROW_COLORS[r]
	_ignore(rect)
	row.add_child(rect)
	var label: Label = Label.new()
	label.name = "L%d" % r
	label.text = "row %d" % r
	label.add_theme_font_size_override("font_size", ROW_FONT_SIZE)
	_ignore(label)
	row.add_child(label)
	row_labels.append(label)
	return row


func _build_rich_text() -> void:
	rt = RichTextLabel.new()
	rt.name = "RT"
	rt.position = RT_POS
	rt.size = RT_SIZE
	rt.bbcode_enabled = true
	rt.scroll_active = true
	_ignore(rt)
	_rt_fill(true)
	scene.add_child(rt)


## The nine lines; line 2 is TEXA as a 64x64 inline image while `with_image`.
func _rt_fill(with_image: bool) -> void:
	rt.clear()
	var lines: Array[String] = RT_LINES if with_image else RT_LINES_STEP9
	for i: int in range(lines.size()):
		if i > 0:
			rt.append_text("\n")
		if with_image and i == 2:
			rt.add_image(texa, 64, 64)
		else:
			rt.append_text(lines[i])


func _build_refused() -> void:
	var particles: CPUParticles2D = CPUParticles2D.new()
	particles.name = "RFParticles"
	particles.position = RF_PARTICLES_POS
	particles.amount = 4
	particles.lifetime = 1.0
	particles.gravity = Vector2.ZERO
	particles.initial_velocity_min = 0.0
	particles.initial_velocity_max = 0.0
	particles.emitting = true
	scene.add_child(particles)
	rf_nodes.append(particles)

	var light: PointLight2D = PointLight2D.new()
	light.name = "RFLight"
	light.position = RF_LIGHT_POS
	# No item has light mask 2: the light is attached (canvas-light) but lights nothing.
	light.range_item_cull_mask = 2
	scene.add_child(light)
	rf_nodes.append(light)

	rf_time_shader = load("res://shaders/refused/time.gdshader") as Shader
	var time_material: ShaderMaterial = ShaderMaterial.new()
	time_material.shader = rf_time_shader
	var time_rect: ColorRect = ColorRect.new()
	time_rect.name = "RFTime"
	time_rect.position = RF_TIME_POS
	time_rect.size = RF_TIME_SIZE
	time_rect.material = time_material
	_ignore(time_rect)
	scene.add_child(time_rect)
	rf_nodes.append(time_rect)

	var fallback: Font = ThemeDB.fallback_font
	var base: FontFile = fallback as FontFile
	rf_lcd_font = base.duplicate() as FontFile
	rf_lcd_font.antialiasing = TextServer.FONT_ANTIALIASING_LCD
	var lcd: Label = Label.new()
	lcd.name = "RFLcd"
	lcd.position = RF_LCD_POS
	lcd.text = "LCD"
	lcd.add_theme_font_override("font", rf_lcd_font)
	_ignore(lcd)
	scene.add_child(lcd)
	rf_nodes.append(lcd)

	var follow: CanvasLayer = CanvasLayer.new()
	follow.name = "RFFollowLayer"
	follow.layer = RF_FOLLOW_LAYER
	follow.follow_viewport_enabled = true
	var follow_rect: ColorRect = ColorRect.new()
	follow_rect.name = "RFFollow"
	follow_rect.position = origin + RF_FOLLOW_POS
	follow_rect.size = RF_FOLLOW_SIZE
	follow_rect.color = RF_FOLLOW_COLOR
	_ignore(follow_rect)
	follow.add_child(follow_rect)
	scene.add_child(follow)
	rf_nodes.append(follow)


func _build_players() -> void:
	sm_player = AnimationPlayer.new()
	sm_player.name = "SMPlayer"
	var phase_anim: Animation = Animation.new()
	phase_anim.length = float(PHASE_PERIOD_FRAMES) / FPS
	phase_anim.loop_mode = Animation.LOOP_LINEAR
	var track: int = phase_anim.add_track(Animation.TYPE_VALUE)
	phase_anim.track_set_path(track, NodePath("SM:material:shader_parameter/phase"))
	phase_anim.value_track_set_update_mode(track, Animation.UPDATE_DISCRETE)
	for k: int in range(PHASE_PERIOD_FRAMES / PHASE_KEY_FRAMES):
		phase_anim.track_insert_key(track, float(k * PHASE_KEY_FRAMES) / FPS, k)
	var sm_library: AnimationLibrary = AnimationLibrary.new()
	sm_library.add_animation("phase", phase_anim)
	sm_player.add_animation_library("", sm_library)
	scene.add_child(sm_player)

	an_player = AnimationPlayer.new()
	an_player.name = "ANPlayer"
	var move_anim: Animation = Animation.new()
	move_anim.length = float(AN_PERIOD_FRAMES) / FPS
	move_anim.loop_mode = Animation.LOOP_LINEAR
	var move: int = move_anim.add_track(Animation.TYPE_VALUE)
	move_anim.track_set_path(move, NodePath("AN:position"))
	move_anim.value_track_set_update_mode(move, Animation.UPDATE_CONTINUOUS)
	move_anim.track_set_interpolation_type(move, Animation.INTERPOLATION_LINEAR)
	move_anim.track_insert_key(move, 0.0, AN_FROM)
	move_anim.track_insert_key(move, float(AN_PERIOD_FRAMES) / FPS, AN_TO)
	var an_library: AnimationLibrary = AnimationLibrary.new()
	an_library.add_animation("move", move_anim)
	an_player.add_animation_library("", an_library)
	scene.add_child(an_player)

	for player: AnimationPlayer in [sm_player, an_player]:
		if not realtime:
			player.callback_mode_process = AnimationMixer.ANIMATION_CALLBACK_MODE_PROCESS_MANUAL


## Both players start a quarter frame (plus the phase) in; called once the scene is in the tree.
func _start_players() -> void:
	var start: float = (float(phase) + TIME_OFFSET_FRAMES) / FPS
	sm_player.play("phase")
	sm_player.seek(start, true)
	an_player.play("move")
	an_player.seek(start, true)


func _build_tween() -> void:
	tween = scene.create_tween()
	tween.set_loops(0)
	tween.tween_property(pb, "value", 100.0, float(PB_PERIOD_FRAMES) / FPS).from(0.0)
	if not realtime:
		tween.pause()
	tween.custom_step((float(phase) + TIME_OFFSET_FRAMES) / FPS)


## Per fixture frame f (steps: after this frame's step; realtime: f = floor(60 t)).
func on_frame(f: int) -> void:
	if frozen:
		return
	if not realtime:
		tween.custom_step(1.0 / FPS)
		sm_player.advance(1.0 / FPS)
		an_player.advance(1.0 / FPS)
	_set_mesh_pose(f)
	if variant == "animate":
		_animate(f)


## `animate` (Q6d): unique TEXA content every 30 frames, the label every 30, the scroll as a
## triangle wave (period 152) and CD's k every 15. Each write happens once per period.
func _animate(f: int) -> void:
	var texa_period: int = f / ANIMATE_TEXA_FRAMES
	if texa_period != _last_texa_period:
		_last_texa_period = texa_period
		if f % ANIMATE_TEXA_FRAMES == 0 and texa != null:
			texa_content = texa_period + 2 + TEXA_CELL_OFFSET * cell
			texa.update(texa_image(texa_content))
	var lb_period: int = f / ANIMATE_LB_FRAMES
	if lb_period != _last_lb_period:
		_last_lb_period = lb_period
		if f % ANIMATE_LB_FRAMES == 0:
			lb.text = "Frame %04d" % f
	var m: int = f % ANIMATE_SCROLL_PERIOD
	sc.scroll_vertical = SC_SCROLL_MAX - absi(SC_SCROLL_MAX - m)
	var cd_period: int = f / ANIMATE_CD_FRAMES
	if cd_period != _last_cd_period:
		_last_cd_period = cd_period
		if f % ANIMATE_CD_FRAMES == 0:
			cd.set_k(cd_period % 4)


## The step table of Q6c (cell-local part; the viewport's canvas transform at step 10 is the
## owner's).
func apply_step(step: int) -> void:
	match step:
		1:
			sc.scroll_vertical = 40
		2:
			lb.text = "Score 12345 ÆØ"
		3:
			texa_content = 1 + TEXA_CELL_OFFSET * cell
			texa.update(texa_image(texa_content))
		4:
			sm_material.set_shader_parameter("tint", SM_TINT_STEP4)
			cm_material.blend_mode = CanvasItemMaterial.BLEND_MODE_SUB
		5:
			rt.scroll_to_line(RT_SCROLL_LINE)
			sc.scroll_vertical = SC_SCROLL_MAX
		6:
			cd.set_k(1)
			bt.text = "Pause"
		7:
			hb.size = HB_SIZE_STEP7
			le.select(2, 7)
		8:
			tr.texture = texb
			hud.visible = false
		9:
			var gone: HBoxContainer = rows[2]
			rows.remove_at(2)
			row_labels.remove_at(2)
			gone.free()
			var row: HBoxContainer = _row(ROW_COUNT)
			rows.append(row)
			vbox.add_child(row)
			_rt_fill(false)
			# TR shows TEXB since step 8 and RT no longer names TEXA: dropping the last
			# reference frees it (texture `free`).
			texa = null
			hud.visible = true
			hud.layer = -1 - cell
		10:
			hud.layer = 1 + cell
		11:
			frozen = true
			sm_player.seek(0.0, true)
			sm_player.pause()
			an_player.seek(0.0, true)
			an_player.pause()
			tween.kill()
			pb.value = PB_FREEZE_VALUE
			_set_mesh_pose_value(0)
			sm_material.set_shader_parameter("phase", 0)
	marker.set_color(MARKER_COLORS[step])


## G6c (gate6-design.md "As built (G6c)"): what step 11's freeze leaves time-dependent -- the
## `animate` writes it does not reset (SC's scroll, LB's text, CD's k). A realtime host's freeze
## lands at whatever game frame the wall clock reached, and a game frame it skipped skips that
## frame's write too, so the owner logs these at step 11 and a reference reproduces them exactly
## (`apply_freeze_state`).
func freeze_state() -> Dictionary:
	return {"sc": sc.scroll_vertical, "lb": lb.text, "cd_k": cd.k}


## Sets the leftovers `freeze_state()` names (after step 11 on a reference); false when `state`
## lacks one of them.
func apply_freeze_state(state: Dictionary) -> bool:
	if not (state.get("sc") is float or state.get("sc") is int) or not (state.get("lb") is String) or not (state.get("cd_k") is float or state.get("cd_k") is int):
		return false
	var sc_value: float = state["sc"]
	var lb_text: String = state["lb"]
	var cd_value: float = state["cd_k"]
	sc.scroll_vertical = int(sc_value)
	lb.text = lb_text
	cd.set_k(int(cd_value))
	return true


func _pose_frame(f: int) -> int:
	return f + phase


func _set_mesh_pose(f: int) -> void:
	_set_mesh_pose_value(_pose_frame(f))


## Moves MS to the pose of animation frame `value` (fixture frame + phase): one vertex region
## update, skipped when the pose is unchanged.
func _set_mesh_pose_value(value: int) -> void:
	if value == _ms_pose_frame:
		return
	_ms_pose_frame = value
	ms_mesh.surface_update_vertex_region(0, 0, ms_points(value).to_byte_array())


## Column i's offset at animation frame t.
static func ms_offset(t: int, column: int) -> float:
	var angle: float = TAU * float(t + MS_COLUMN_PHASE * column) / float(MS_PERIOD_FRAMES)
	return roundf(MS_AMPLITUDE * sin(angle))


## The strip's 16 vertices at animation frame t: per column top then bottom.
static func ms_points(t: int) -> PackedVector2Array:
	var out: PackedVector2Array = PackedVector2Array()
	for i: int in range(MS_COLUMNS):
		var dy: float = ms_offset(t, i)
		out.append(Vector2(MS_DX * float(i), MS_TOP + dy))
		out.append(Vector2(MS_DX * float(i), MS_BOTTOM + dy))
	return out


func _ms_arrays(t: int) -> Array:
	var arrays: Array = []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = ms_points(t)
	var colours: PackedColorArray = PackedColorArray()
	var indices: PackedInt32Array = PackedInt32Array()
	for i: int in range(MS_COLUMNS):
		colours.append(MS_TOP_COLOR)
		colours.append(MS_BOTTOM_COLOR)
		if i + 1 < MS_COLUMNS:
			var a: int = 2 * i
			indices.append_array(PackedInt32Array([a, a + 2, a + 1, a + 1, a + 2, a + 3]))
	arrays[Mesh.ARRAY_COLOR] = colours
	arrays[Mesh.ARRAY_INDEX] = indices
	return arrays


static func flat_box(color: Color) -> StyleBoxFlat:
	var box: StyleBoxFlat = StyleBoxFlat.new()
	box.bg_color = color
	return box


static func texn_image() -> Image:
	var image: Image = Image.create_empty(16, 16, false, Image.FORMAT_RGBA8)
	image.fill(TEXN_BORDER)
	for cy: int in 4:
		for cx: int in 4:
			var c: Color = TEXN_MARK if cx == 0 and cy == 0 else (TEXN_A if (cx + cy) % 2 == 0 else TEXN_B)
			image.fill_rect(Rect2i(4 + cx * 2, 4 + cy * 2, 2, 2), c)
	return image


static func texa_image(n: int) -> Image:
	var image: Image = Image.create_empty(TEXA_SIZE, TEXA_SIZE, false, Image.FORMAT_RGBA8)
	var cells: int = TEXA_SIZE / TEXA_CELL
	for cy: int in cells:
		for cx: int in cells:
			var j: int = (cx + 2 * cy) % 4
			var c: Color = TEXA_PALETTE[(5 * n + 3 * j) % TEXA_PALETTE.size()]
			image.fill_rect(Rect2i(cx * TEXA_CELL, cy * TEXA_CELL, TEXA_CELL, TEXA_CELL), c)
	for b: int in TEXA_BITS:
		var on: bool = ((n >> b) & 1) == 1
		image.fill_rect(Rect2i(b * TEXA_BIT_BLOCK, 0, TEXA_BIT_BLOCK, TEXA_BIT_BLOCK), Color(1, 1, 1, 1) if on else Color(0, 0, 0, 1))
	return image


static func _ignore(control: Control) -> void:
	control.mouse_filter = Control.MOUSE_FILTER_IGNORE
