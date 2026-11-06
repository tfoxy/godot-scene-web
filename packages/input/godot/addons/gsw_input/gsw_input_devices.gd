class_name GswInputDevices
extends RefCounted
## Virtual joypad device ids for GswInputInjector (docs/input.md "Many instances on one machine",
## "Injector API"): a source's pad `slot` is on `device_base + block * devices_per_source + slot`,
## where `block` is the lowest block free when the source first used a pad. The injector keeps
## the block through reconnects and calls `release()` when the source's lease expires, which
## frees the block for the next source.
##
## Godot never lists injected devices: `Input.get_connected_joypads()` and
## `joy_connection_changed` only cover driver pads (ids 0..15). So a device is `attached` when its
## first holder acquires it and `detached` when its last holder is released; `attached_devices()`
## is the list a game reads instead of `get_connected_joypads()`. With `share_devices` every
## source uses `device_base + slot`, and a device stays attached while any source holds it.
##
## Set the configuration before the first `acquire`; changing it later does not move devices
## already handed out.

signal attached(device: int, source: String, slot: int)
signal detached(device: int, source: String, slot: int)

## Godot packs `device << 20` into joypad button and axis keys (`_combine_device`,
## core/input/input.cpp:357-363), so every device id stays below 2048.
const MAX_DEVICE: int = 2047

## First virtual device id (>= Input::JOYPADS_MAX 16, so physical pads never collide).
var device_base: int = 64
var devices_per_source: int = 4
## All sources share `device_base + slot` instead of one block each.
var share_devices: bool = false

## block -> source id.
var _blocks: Dictionary = {}
## source id -> block.
var _block_of: Dictionary = {}
## source id -> {slot: device}.
var _slots: Dictionary = {}
## device -> Array of the source ids holding it, in acquire order.
var _users: Dictionary = {}


## The device `source`'s pad `slot` is on, acquiring it (and the source's block) on first use.
## -1 when the slot is out of range, no block is free, or the id would pass MAX_DEVICE.
func acquire(source: String, slot: int) -> int:
	if slot < 0 or slot >= devices_per_source:
		return -1
	var slots: Dictionary = _slots.get(source, {})
	if slots.has(slot):
		var known: int = slots[slot]
		return known
	var device: int = device_base + slot
	if not share_devices:
		var block: int = _block_of.get(source, -1)
		if block < 0:
			block = _free_block()
			if block < 0:
				return -1
			_blocks[block] = source
			_block_of[source] = block
		device += block * devices_per_source
	if device < 0 or device > MAX_DEVICE:
		return -1
	slots[slot] = device
	_slots[source] = slots
	var users: Array = _users.get(device, [])
	users.append(source)
	_users[device] = users
	if users.size() == 1:
		attached.emit(device, source, slot)
	return device


## The device `source`'s pad `slot` is on, or -1 when the source has not acquired it.
func device_for(source: String, slot: int) -> int:
	var slots: Dictionary = _slots.get(source, {})
	var device: int = slots.get(slot, -1)
	return device


## Give back everything `source` holds (its lease expired): devices it was the last holder of
## detach, in slot order, and its block is free again.
func release(source: String) -> void:
	var slots: Dictionary = _slots.get(source, {})
	var order: Array = slots.keys()
	order.sort()
	for item: Variant in order:
		var slot: int = item
		var device: int = slots[slot]
		var users: Array = _users.get(device, [])
		users.erase(source)
		if users.is_empty():
			_users.erase(device)
			detached.emit(device, source, slot)
	_slots.erase(source)
	var block: int = _block_of.get(source, -1)
	if block >= 0:
		_blocks.erase(block)
		_block_of.erase(source)


## Every attached virtual device id, ascending: the injected counterpart of
## `Input.get_connected_joypads()`.
func attached_devices() -> Array[int]:
	var out: Array[int] = []
	for item: Variant in _users.keys():
		var device: int = item
		out.append(device)
	out.sort()
	return out


## Every id the first `sources` blocks can hand out (the shared ids with `share_devices`), for
## `GswJoypadIsolation.isolate()`. Ids past MAX_DEVICE are left out.
func virtual_devices(sources: int = 1) -> Array[int]:
	var out: Array[int] = []
	var count: int = devices_per_source if share_devices else sources * devices_per_source
	for i: int in count:
		var device: int = device_base + i
		if device >= 0 and device <= MAX_DEVICE:
			out.append(device)
	return out


func _free_block() -> int:
	var block: int = 0
	while device_base + block * devices_per_source + devices_per_source - 1 <= MAX_DEVICE:
		if not _blocks.has(block):
			return block
		block += 1
	return -1
