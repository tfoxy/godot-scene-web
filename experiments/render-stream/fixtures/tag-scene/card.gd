extends Control
## A card instance (card.tscn): tags set in _ready, as a game or a mod does.

@export var slot: int = 0


func _ready() -> void:
	add_to_group("rs_hand")
	set_meta("rs_tag", "card")
	set_meta("rs_slot", slot)
	var container: Node = get_node("CardContainer")
	container.add_to_group("rs_text")
	container.set_meta("rs_tag", &"container")
