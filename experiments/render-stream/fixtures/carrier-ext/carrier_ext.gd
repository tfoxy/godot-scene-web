extends Node
## The carried scene: a ColorRect and a Label made after the arm (frame 4, so no pre-arm item needs
## adoption), the rect's colour and position changed every frame, so every frame is a transaction.

var _frame: int = 0
var _rect: ColorRect = null
var _label: Label = null


func _process(_delta: float) -> void:
	_frame += 1
	if _frame == 4:
		_rect = ColorRect.new()
		_rect.size = Vector2(64, 48)
		add_child(_rect)
		_label = Label.new()
		_label.text = "carrier"
		_label.position = Vector2(200, 100)
		add_child(_label)
	if _rect != null:
		_rect.position = Vector2(10 + (_frame % 50) * 4, 20)
		_rect.color = Color.from_hsv(float(_frame % 30) / 30.0, 0.8, 0.9)
