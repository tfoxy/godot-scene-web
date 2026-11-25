extends Node2D

var players: Array[AudioStreamPlayer] = []
var finished_count: int = 0

func _ready() -> void:
	GDExtensionManager.load_extension(OS.get_environment("GRC_EXTENSION"))
	await get_tree().process_frame
	var control: String = OS.get_environment("GRC_AUDIO_TEST_CONTROL")
	if not control.is_empty():
		while not FileAccess.file_exists(control + "/start"):
			await get_tree().process_frame
	AudioServer.add_bus()
	AudioServer.set_bus_name(1, "Private")
	var streams: Array[AudioStream] = []
	for options: Dictionary in [{"compress/mode": 0}, {"compress/mode": 0, "force/8_bit": true}, {"compress/mode": 1}, {"compress/mode": 2}]:
		streams.append(AudioStreamWAV.load_from_file("res://tone.wav", options))
	streams.append(AudioStreamMP3.load_from_file("res://tone.mp3"))
	streams.append(AudioStreamOggVorbis.load_from_file("res://tone.ogg"))
	var compressed: AudioStreamOggVorbis = streams.back().duplicate() as AudioStreamOggVorbis
	compressed.loop = true
	compressed.loop_offset = 0.25
	streams.append(compressed)
	var rows: Array[Dictionary] = []
	for i: int in range(streams.size()):
		var stream: AudioStream = streams[i]
		var copy: AudioStream = stream.duplicate() as AudioStream
		if copy is AudioStreamWAV:
			(copy as AudioStreamWAV).loop_mode = AudioStreamWAV.LOOP_DISABLED
		else:
			copy.set("loop", false)
		var playback: AudioStreamPlayback = copy.instantiate_playback()
		playback.start()
		var pcm: PackedByteArray = PackedByteArray()
		var channels: int = 2 if (stream is AudioStreamWAV and (stream as AudioStreamWAV).stereo) else 1
		# Compressed sources have the same channel count as our generated WAV.
		if not stream is AudioStreamWAV:
			channels = 2 if (streams[0] as AudioStreamWAV).stereo else 1
		var remaining: int = roundi(stream.get_length() * 22050)
		while remaining > 0:
			var frames: PackedVector2Array = playback.mix_audio(AudioServer.get_mix_rate() / 22050.0 / AudioServer.playback_speed_scale, mini(4096, remaining))
			if frames.is_empty():
				break
			for frame: Vector2 in frames:
				for channel: int in range(channels):
					var n: int = clampi(roundi(frame[channel] * 32768), -32768, 32767)
					pcm.append(n & 255)
					pcm.append((n >> 8) & 255)
			remaining -= frames.size()
		playback.stop()
		var output: FileAccess = FileAccess.open(OS.get_environment("GRC_EVIDENCE_DIR") + "/reference-%d.pcm" % i, FileAccess.WRITE)
		output.store_buffer(pcm)
		rows.append({"index": i, "class": stream.get_class(), "frames": pcm.size() / (2 * channels), "channels": channels})
		var player: AudioStreamPlayer = AudioStreamPlayer.new()
		player.stream = stream
		player.playback_type = AudioServer.PLAYBACK_TYPE_SAMPLE
		if i == 0:
			player.bus = "Private"
		player.finished.connect(func() -> void: finished_count += 1)
		add_child(player)
		players.append(player)
		player.play()
		await get_tree().create_timer(0.15).timeout
	await get_tree().create_timer(1.5).timeout
	for player: AudioStreamPlayer in players:
		player.stop()
	var file: FileAccess = FileAccess.open(OS.get_environment("GRC_EVIDENCE_DIR") + "/audio-fixture.json", FileAccess.WRITE)
	file.store_string(JSON.stringify({"rows": rows, "finished": finished_count}))
	file.close()
	if not control.is_empty():
		while not FileAccess.file_exists(control + "/quit"):
			await get_tree().process_frame
	get_tree().quit()
