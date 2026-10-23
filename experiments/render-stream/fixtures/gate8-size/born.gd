extends Node
## The `born` main scene (RS_FIXTURE_ARM=born): a plain Node that instantiates size.tscn in
## `_ready`, after the loader armed the capture in `_enter_tree`, so every canvas and item
## of the scene is created under the hooks (gate 0's rule, memory gate0-route-a-fixture-rule).

func _ready() -> void:
	var scene: PackedScene = load("res://size.tscn")
	add_child(scene.instantiate())
