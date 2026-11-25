extends Node2D

var players: Array[AudioStreamPlayer] = []
var finished_count: int = 0

func _ready() -> void:
	var status: int = GDExtensionManager.load_extension(OS.get_environment("GRC_EXTENSION"))
	if status != GDExtensionManager.LOAD_STATUS_OK:
		push_error("Capture extension did not load")
		get_tree().quit(1)
		return
	AudioServer.bus_count = 2
	AudioServer.set_bus_name(1, "FX")
	AudioServer.set_bus_send(1, "Master")
	AudioServer.set_bus_volume_db(1, -6.0)
	var wav: AudioStreamWAV = load("res://tone.wav")
	var mp3: AudioStreamMP3 = load("res://tone.mp3")
	var ogg: AudioStreamOggVorbis = load("res://tone.ogg")
	var one_shot: AudioStreamPlayer = make_player(wav)
	one_shot.play()
	make_player(mp3).play(0.025)
	make_player(ogg).play()
	var loop: AudioStreamWAV = wav.duplicate() as AudioStreamWAV
	loop.loop_mode = AudioStreamWAV.LOOP_FORWARD
	loop.loop_begin = 0
	loop.loop_end = 2205
	var music: AudioStreamPlayer = make_player(loop)
	music.bus = &"FX"
	music.play()
	music.pitch_scale = 1.5
	music.stream_paused = true
	await get_tree().process_frame
	music.stream_paused = false
	await get_tree().create_timer(0.25).timeout
	music.stop()
	for player: AudioStreamPlayer in players:
		player.stop()
	var observation: Dictionary = {"finished": finished_count, "players": players.size()}
	var path: String = OS.get_environment("GRC_EVIDENCE_DIR") + "/audio-fixture.json"
	var file: FileAccess = FileAccess.open(path, FileAccess.WRITE)
	file.store_string(JSON.stringify(observation))
	file.close()
	get_tree().quit()

func make_player(stream: AudioStream) -> AudioStreamPlayer:
	var player: AudioStreamPlayer = AudioStreamPlayer.new()
	player.stream = stream
	player.playback_type = AudioServer.PLAYBACK_TYPE_SAMPLE
	player.finished.connect(func() -> void: finished_count += 1)
	add_child(player)
	players.append(player)
	return player
