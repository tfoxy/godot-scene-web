class_name AnnouncedTween
extends RefCounted
## Finite, absolute property schedules for optional render-stream client playback.
## Playback is approximate and opt-in per client; late joiners follow host frames.
## Kill through cancel(). Cancel/re-announce before pause, speed or loop changes.
## No capture singleton is required: play() still builds a normal Godot Tween.
## Existing Tweens cannot be introspected; announce() requires their explicit schedule.

var steps: Array[Dictionary] = []
var _target: Object
var _owner: Node
var _id: int
var _tween: Tween
var _group_start: float = 0.0
var _group_end: float = 0.0
var _parallel: bool = false
var _next_parallel: bool = false


## A ShaderMaterial target needs a node owner to bind its native Tween lifetime.
static func create(target: Object, tween_id: int, owner: Node = null) -> AnnouncedTween:
	var result := AnnouncedTween.new()
	result._target = target
	result._owner = target as Node if target is Node else owner
	assert(result._owner != null, "Material tweens require a node owner")
	result._id = tween_id
	return result


## All durations/delays use seconds, as Tween.tween_property does.
## Explicit from values are optional; omitted values are read at the step's start.
func property(path: NodePath, to: Variant, duration: float,
		trans: Tween.TransitionType = Tween.TRANS_LINEAR,
		ease: Tween.EaseType = Tween.EASE_IN_OUT, delay: float = 0.0,
		from: Variant = null) -> AnnouncedTween:
	assert(_tween == null, "Build the schedule before play()")
	assert(duration >= 0.0 and delay >= 0.0)
	if not steps.is_empty() and not (_parallel or _next_parallel):
		_group_start = _group_end
	_next_parallel = false
	var step: Dictionary = {
		"property": String(path), "to": to,
		"start_ms": (_group_start + delay) * 1000.0,
		"duration_ms": duration * 1000.0, "trans": trans, "ease": ease,
	}
	if from != null:
		step["from"] = from
	steps.append(step)
	_group_end = maxf(_group_end, _group_start + delay + duration)
	return self


func set_parallel(enabled: bool = true) -> AnnouncedTween:
	_parallel = enabled
	return self


## The next property shares the previous group's start (including its own delay).
func parallel() -> AnnouncedTween:
	_next_parallel = true
	return self


func chain() -> AnnouncedTween:
	_group_start = _group_end
	_next_parallel = true
	return self


## An interval moves the next group after the previous group's longest step.
func interval(seconds: float) -> AnnouncedTween:
	assert(seconds >= 0.0)
	_group_start = _group_end + seconds
	_group_end = _group_start
	_next_parallel = true
	return self


func play() -> Tween:
	assert(_tween == null and not steps.is_empty())
	var started_usec: int = Time.get_ticks_usec()
	_tween = _owner.create_tween().set_parallel(true)
	var resolved: Dictionary = resolve_target(_target, steps)
	for step: Dictionary in resolved["steps"]:
		var part: PropertyTweener = _tween.tween_property(
			resolved["target"], NodePath(step["property"]), step["to"], step["duration_ms"] / 1000.0)
		part.set_delay(step["start_ms"] / 1000.0)
		part.set_trans(step["trans"])
		part.set_ease(step["ease"])
		if step.has("from"):
			part.from(step["from"])
	announce(_target, _id, steps, started_usec)
	return _tween


## For a caller-built Tween, pass creation time and a flattened absolute schedule.
static func announce(target: Object, tween_id: int, schedule: Array[Dictionary],
		started_usec: int) -> void:
	if Engine.has_singleton("RenderStreamCapture"):
		var resolved: Dictionary = resolve_target(target, schedule)
		Engine.get_singleton("RenderStreamCapture").call("tween_begin", {
			"tween_id": tween_id, "object_id": resolved["target"].get_instance_id(),
			"started_usec": started_usec, "steps": resolved["steps"],
		})


## Resolve the node property convenience path before native playback and capture.
## One announcement targets one object; node and material properties cannot be mixed.
static func resolve_target(target: Object, schedule: Array[Dictionary]) -> Dictionary:
	assert(not schedule.is_empty())
	var alias: bool = String(schedule[0]["property"]).begins_with("material:shader_parameter/")
	var resolved_target: Object = target
	if alias:
		assert(target is CanvasItem and (target as CanvasItem).material is ShaderMaterial)
		resolved_target = (target as CanvasItem).material
	assert(resolved_target is Node or resolved_target is ShaderMaterial)
	var resolved_steps: Array[Dictionary] = []
	for step: Dictionary in schedule:
		var path: String = step["property"]
		assert(path.begins_with("material:shader_parameter/") == alias)
		var copy: Dictionary = step.duplicate()
		if alias:
			copy["property"] = path.trim_prefix("material:")
		resolved_steps.append(copy)
	return {"target": resolved_target, "steps": resolved_steps}


func cancel() -> void:
	if _tween != null and _tween.is_valid():
		_tween.kill()
	cancel_announcement(_id)


static func cancel_announcement(tween_id: int) -> void:
	if Engine.has_singleton("RenderStreamCapture"):
		Engine.get_singleton("RenderStreamCapture").call("tween_cancel", tween_id)
