extends Node2D

var finished_count: int = 0
var finished_frame: int = -1
var deadline: int = 0
var deadline_frame: int = -1
var player: AudioStreamPlayer

func _process(_dt: float) -> void:
	if deadline and Time.get_ticks_usec() >= deadline and deadline_frame < 0:
		deadline_frame = Engine.get_process_frames()

func _ready() -> void:
	GDExtensionManager.load_extension(OS.get_environment("GRC_EXTENSION"))
	player = AudioStreamPlayer.new()
	player.stream = load("res://tone.wav")
	player.playback_type = AudioServer.PLAYBACK_TYPE_SAMPLE
	player.finished.connect(func() -> void:
		finished_count += 1
		finished_frame = Engine.get_process_frames())
	add_child(player)
	player.pitch_scale = 2.0
	player.play(0.8)
	var start: int = Time.get_ticks_usec()
	await get_tree().process_frame
	player.stream_paused = true
	var before_pause: float = player.get_playback_position()
	var paused_at: int = Time.get_ticks_usec()
	await get_tree().create_timer(0.05).timeout
	var paused_position: float = player.get_playback_position()
	player.pitch_scale = 4.0
	player.stream_paused = false
	var resume: int = Time.get_ticks_usec()
	deadline = resume + int((1.0 - paused_position) / 4.0 * 1000000.0)
	await get_tree().create_timer(0.2).timeout
	var observation: Dictionary = {
		"finished": finished_count, "finished_frame": finished_frame,
		"deadline_frame": deadline_frame, "deadline_us": deadline,
		"start_us": start, "paused_at_us": paused_at,
		"before_pause": before_pause, "paused_position": paused_position,
		"playing": player.playing,
	}
	var file: FileAccess = FileAccess.open(OS.get_environment("GRC_EVIDENCE_DIR") + "/audio-clock.json", FileAccess.WRITE)
	file.store_string(JSON.stringify(observation))
	file.close()
	get_tree().quit()
