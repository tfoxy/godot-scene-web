extends Node
## The `born` main scene (RS_FIXTURE_ARM=born): a plain Node that instantiates viewport_scene.tscn in
## `_ready`, after the loader armed the capture in `_enter_tree`, so every viewport, proxy, canvas
## and item of the scene is created under the hooks (as fixtures/gate8-adopt/born.gd). A Node is no
## canvas item, so the scene's items parent to the same canvases as in the late run.

func _ready() -> void:
	var scene: PackedScene = load("res://viewport_scene.tscn")
	add_child(scene.instantiate())
