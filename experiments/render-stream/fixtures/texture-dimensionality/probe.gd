extends Node2D

var api: Object
var layered: Texture2DArray
var flat: ImageTexture
var frame := 0
var out: String
var variant: String


func _ready() -> void:
	out = OS.get_environment("RS_CTRES_OUT")
	variant = OS.get_environment("RS_DIMENSIONALITY_CASE")
	var images: Array[Image] = []
	for layer in range(3):
		var image := Image.create(8, 8, false, Image.FORMAT_RGBA8)
		image.fill(Color(float(layer) / 2.0, 0.5, 1.0, 1.0))
		images.append(image)
	layered = Texture2DArray.new()
	_check(layered.create_from_images(images) == OK, "create layered texture")
	flat = ImageTexture.create_from_image(images[0])
	var shader := Shader.new()
	var sampler := "sampler2DArray" if variant == "array" else "sampler2D"
	var coords := "vec3(UV, 2.0)" if variant == "array" else "UV"
	shader.code = "shader_type canvas_item; uniform %s layers; uniform sampler2D flat_tex; void fragment() { COLOR = texture(layers, %s) * texture(flat_tex, UV); }" % [sampler, coords]
	var mat := ShaderMaterial.new()
	mat.shader = shader
	if variant == "default":
		shader.set_default_texture_parameter("layers", layered)
	elif variant != "canvas":
		mat.set_shader_parameter("layers", layered)
	mat.set_shader_parameter("flat_tex", flat)
	var rect := ColorRect.new()
	rect.size = Vector2(160, 160)
	rect.material = mat
	add_child(rect)
	OS.set_environment("GRC_TEST_NON2D_RID", str(layered.get_rid().get_id()))
	var file := FileAccess.open(out.path_join("source.json"), FileAccess.WRITE)
	file.store_string(JSON.stringify({"rid": str(layered.get_rid().get_id()), "layers": layered.get_layers(),
		"flat_rid": str(flat.get_rid().get_id()), "layer_bytes": 256, "variant": variant,
		"flat_hex": images[0].get_data().hex_encode()}))


func _process(_delta: float) -> void:
	frame += 1
	if frame == 10:
		_check(GDExtensionManager.load_extension(OS.get_environment("GRC_EXTENSION")) == GDExtensionManager.LOAD_STATUS_OK, "load extension")
		api = Engine.get_singleton("RenderStreamCapture")
	elif frame == 20:
		_check(api.call("attach", {}) == 0, "attach")
		_check(api.call("arm", {}) == 0, "arm")
	elif frame == 70:
		_check(api.call("disarm", {"linger_ms": 0}) == 0, "disarm")
	elif frame == 80:
		get_tree().quit()


func _check(ok: bool, reason: String) -> void:
	if not ok:
		push_error("texture dimensionality: " + reason)
		get_tree().quit(1)


func _draw() -> void:
	if variant == "canvas":
		RenderingServer.canvas_item_add_texture_rect(get_canvas_item(), Rect2(0, 0, 160, 160), layered.get_rid())
