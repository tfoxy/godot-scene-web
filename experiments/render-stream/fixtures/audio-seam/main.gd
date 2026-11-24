extends Node2D

var players: Array[AudioStreamPlayer] = []
var spatial: AudioStreamPlayer2D
var finished_count: int = 0
var cache_picked_up: bool = false
var fallback: bool = false

func _ready() -> void:
	var status: int = GDExtensionManager.load_extension(OS.get_environment("GRC_EXTENSION"))
	if status != GDExtensionManager.LOAD_STATUS_OK:
		push_error("Capture extension did not load")
		get_tree().quit(1)
		return
	if OS.get_environment("GRC_AUDIO") != "log":
		get_tree().quit()
		return
	var report_path: String = OS.get_environment("GRC_EVIDENCE_DIR") + "/audio-probe.json"
	if not FileAccess.file_exists(report_path):
		push_error("Audio probe evidence is missing")
		get_tree().quit(1)
		return
	var result: Variant = JSON.parse_string(FileAccess.get_file_as_string(report_path))
	if not result is Dictionary:
		get_tree().quit(1)
		return
	var probe: Dictionary = result
	if probe.get("status") != "found" or probe.get("bound_driver") != "Dummy":
		push_error("Audio probe refused; fixture will not force sample playback")
		get_tree().quit(1)
		return
	AudioServer.bus_count = 2
	AudioServer.set_bus_name(1, "FX")
	AudioServer.set_bus_send(1, "Master")
	AudioServer.set_bus_volume_db(1, -6.0)
	AudioServer.set_bus_solo(1, true)
	AudioServer.set_bus_solo(1, false)
	AudioServer.set_bus_mute(1, true)
	AudioServer.set_bus_mute(1, false)
	AudioServer.add_bus()
	AudioServer.move_bus(2, 1)
	AudioServer.remove_bus(1)
	AudioServer.bus_count = 1
	var wav: AudioStreamWAV = load("res://tone.wav")
	var mp3: AudioStreamMP3 = load("res://tone.mp3")
	var ogg: AudioStreamOggVorbis = load("res://tone.ogg")
	var default_player: AudioStreamPlayer = make_player(wav)
	default_player.play()
	await get_tree().process_frame
	cache_picked_up = default_player.get_stream_playback().get_sample_playback() != null
	print("[audio-fixture] GLOBAL_GET_CACHED picked up setting: ", cache_picked_up)
	fallback = not cache_picked_up
	if fallback:
		default_player.stop()
		default_player.playback_type = AudioServer.PLAYBACK_TYPE_SAMPLE
		default_player.play()
	print("[audio-fixture] forwarded playback position: ", default_player.get_playback_position())
	var mp3_player: AudioStreamPlayer = make_player(mp3)
	var ogg_player: AudioStreamPlayer = make_player(ogg)
	mp3_player.play(0.025)
	ogg_player.play()
	var looping: AudioStreamWAV = wav.duplicate() as AudioStreamWAV
	looping.loop_mode = AudioStreamWAV.LOOP_FORWARD
	looping.loop_begin = 0
	looping.loop_end = 2205
	var loop_player: AudioStreamPlayer = make_player(looping)
	loop_player.play()
	loop_player.pitch_scale = 1.5
	loop_player.stream_paused = true
	loop_player.stream_paused = false
	var overlap: AudioStreamPlayer = make_player(wav)
	overlap.play()
	spatial = AudioStreamPlayer2D.new()
	spatial.stream = wav
	if fallback:
		spatial.playback_type = AudioServer.PLAYBACK_TYPE_SAMPLE
	add_child(spatial)
	var listener: AudioListener2D = AudioListener2D.new()
	add_child(listener)
	listener.make_current()
	spatial.play()
	for i: int in range(8):
		spatial.position = Vector2(i * 25.0, 0.0)
		await get_tree().physics_frame
	loop_player.stop()
	# The tone is 0.1 s long; observe well after its nominal end without ending it ourselves.
	await get_tree().create_timer(0.35).timeout
	var observation: Dictionary = {
		"cache_picked_up": cache_picked_up,
		"fallback_per_player": fallback,
		"one_shot_playing_after_end": default_player.playing,
		"finished_count": finished_count,
		"overlap_playing": overlap.playing,
	}
	print("[audio-fixture] ", JSON.stringify(observation))
	var file: FileAccess = FileAccess.open(OS.get_environment("GRC_EVIDENCE_DIR") + "/audio-fixture.json", FileAccess.WRITE)
	file.store_string(JSON.stringify(observation))
	file.close()
	for player: AudioStreamPlayer in players:
		player.stop()
	spatial.stop()
	get_tree().quit()

func make_player(stream: AudioStream) -> AudioStreamPlayer:
	var player: AudioStreamPlayer = AudioStreamPlayer.new()
	player.stream = stream
	if fallback:
		player.playback_type = AudioServer.PLAYBACK_TYPE_SAMPLE
	player.finished.connect(func() -> void: finished_count += 1)
	add_child(player)
	players.append(player)
	return player
