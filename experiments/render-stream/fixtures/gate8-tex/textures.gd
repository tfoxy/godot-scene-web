extends RefCounted
## The gate 8 texture fixture's texture table (gate8-design.md Q3 "Fixture"), shared by
## make_sources.gd (which writes each source image and its `.import` settings into res://tex/),
## gate8_tex.gd (which draws them) and oracle.gd (which decodes them). Every source is
## synthetic and generated: nothing under res://tex/ is committed.
##
## `pattern`: rgb (opaque colour: DXT1 / ETC2_RGB8), rgba (alpha: DXT5 / ETC2_RGBA8, or BPTC_RGBA /
## ASTC_4x4 with high_quality), r and rg (channel_pack Optimized: RGTC_R / ETC2_R11, RGTC_RG /
## ETC2_RG11), hdr (an opaque float EXR: BPTC_RGBFU / ASTC_4x4_HDR, both refused by G8t's decode).
## `drawn`: whether gate8_tex.gd draws it (hdr is created only, its refusal is the census's).
## `cost`: a 2048x2048 source for the decode-cost timing leg only.

const TEXTURES: Array[Dictionary] = [
	{"name": "opaque", "size": 64, "pattern": "rgb", "drawn": true, "cost": false,
		"params": {"compress/mode": 2}},
	{"name": "alpha", "size": 64, "pattern": "rgba", "drawn": true, "cost": false,
		"params": {"compress/mode": 2}},
	{"name": "alpha_mip", "size": 64, "pattern": "rgba", "drawn": true, "cost": false,
		"params": {"compress/mode": 2, "mipmaps/generate": true}},
	{"name": "hq", "size": 64, "pattern": "rgba", "drawn": true, "cost": false,
		"params": {"compress/mode": 2, "compress/high_quality": true}},
	{"name": "mask_r", "size": 64, "pattern": "r", "drawn": true, "cost": false,
		"params": {"compress/mode": 2, "compress/channel_pack": 1}},
	{"name": "mask_rg", "size": 64, "pattern": "rg", "drawn": true, "cost": false,
		"params": {"compress/mode": 2, "compress/channel_pack": 1}},
	{"name": "control", "size": 64, "pattern": "rgba", "drawn": true, "cost": false,
		"params": {"compress/mode": 0}},
	{"name": "hdr", "size": 16, "pattern": "hdr", "drawn": false, "cost": false,
		"params": {"compress/mode": 2}},
	{"name": "cost_rgb", "size": 2048, "pattern": "rgb", "drawn": false, "cost": true,
		"params": {"compress/mode": 2}},
	{"name": "cost_rgba", "size": 2048, "pattern": "rgba", "drawn": false, "cost": true,
		"params": {"compress/mode": 2}},
	{"name": "cost_hq", "size": 2048, "pattern": "rgba", "drawn": false, "cost": true,
		"params": {"compress/mode": 2, "compress/high_quality": true}},
]

## Import variant keys, in the order a family takes them: the desktop family draws first (step 0),
## the mobile family replaces it (step 1). `path` is a non-VRAM import (one variant only).
const DESKTOP_KEYS: Array[String] = ["s3tc", "bptc", ""]
const MOBILE_KEYS: Array[String] = ["etc2", "astc", ""]


static func source_path(texture: Dictionary) -> String:
	var name: String = texture["name"]
	var pattern: String = texture["pattern"]
	return "res://tex/%s.%s" % [name, "exr" if pattern == "hdr" else "png"]


## The imported `.ctex` of `texture` for `family` ("desktop" or "mobile") from its `.import`
## file: {"key": "s3tc" | "bptc" | "etc2" | "astc" | "", "path": res:// path}, or {} when absent.
static func variant(texture: Dictionary, family: String) -> Dictionary:
	var config := ConfigFile.new()
	if config.load(source_path(texture) + ".import") != OK:
		return {}
	var keys: Array[String] = DESKTOP_KEYS if family == "desktop" else MOBILE_KEYS
	for key: String in keys:
		var config_key: String = "path" if key == "" else "path." + key
		if config.has_section_key("remap", config_key):
			var path: String = config.get_value("remap", config_key)
			return {"key": key, "path": path}
	return {}
