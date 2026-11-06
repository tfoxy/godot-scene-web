extends ColorRect
## ID3 (RS_FIXTURE_TAG_V2, README.md "Variant V2"): a Control whose script implements _has_point, so
## its rect is only an upper bound of its pick area (the left half picks).


func _has_point(point: Vector2) -> bool:
	return point.x >= 0.0 and point.x < size.x / 2.0 and point.y >= 0.0 and point.y < size.y
