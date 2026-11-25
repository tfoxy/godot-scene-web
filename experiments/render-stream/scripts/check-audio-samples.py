#!/usr/bin/env python3
"""Compare actual sample-mode emissions against the independent G1 hook log."""
import json
import math
import sys
from pathlib import Path

logged, emitted = [Path(p) for p in sys.argv[1:]]
hooks = [json.loads(line) for line in logged.read_text().splitlines()]
messages = [json.loads(line) for line in emitted.read_text().splitlines()]
expected = []
samples, voices = {}, {}
for hook in hooks:
    slot = hook['slot']
    event = None
    if slot == 'register_sample':
        sid = samples.setdefault(hook['stream_id'], len(samples) + 1)
        event = {'type': 'sample', 'id': sid, 'length_ms': hook['length_s'] * 1000,
                 'loop': {'mode': ['disabled', 'forward', 'pingpong', 'backward'][hook['loop_mode']]}}
    elif slot == 'unregister_sample':
        event = {'type': 'sample-drop', 'id': samples[hook['stream_id']]}
    elif slot == 'start_sample_playback':
        voice = voices.setdefault(hook['object_id'], len(voices) + 1)
        gains = sum(hook['volume_vector'], [])
        event = {'type': 'start', 'voice': voice, 'sample': samples[hook['stream_id']],
                 'bus': {'Master': 0, 'FX': 1}.get(hook['bus'], -1),
                 'offset_s': hook['offset_s'], 'pitch': hook['pitch_scale'], 'volumes': gains + [0] * (8 - len(gains))}
    elif slot in ('stop_sample_playback', 'set_sample_playback_pause', 'update_sample_playback_pitch_scale', 'set_sample_playback_bus_volumes_linear'):
        voice = voices[hook['object_id']]
        event = {'type': {'stop_sample_playback': 'stop', 'set_sample_playback_pause': 'pause',
                          'update_sample_playback_pitch_scale': 'pitch', 'set_sample_playback_bus_volumes_linear': 'voice-volumes'}[slot], 'voice': voice}
        if event['type'] == 'stop': event['reason'] = 'stop'
        if event['type'] == 'pause': event['paused'] = hook['paused']
        if event['type'] == 'pitch': event['pitch'] = hook['new_pitch_scale']
        if event['type'] == 'voice-volumes':
            event['buses'] = []
            for route in hook['bus_volumes']:
                gains = sum(route['volumes'], [])
                event['buses'].append({'bus': {'Master': 0, 'FX': 1}.get(route['bus'], -1), 'v': gains + [0] * (8 - len(gains))})
    elif slot.startswith('set_sample_bus_') or slot in ('add_sample_bus', 'remove_sample_bus', 'move_sample_bus'):
        op = {'set_sample_bus_count': 'count', 'add_sample_bus': 'add', 'remove_sample_bus': 'remove',
              'move_sample_bus': 'move', 'set_sample_bus_send': 'send', 'set_sample_bus_volume_db': 'volume_db',
              'set_sample_bus_solo': 'solo', 'set_sample_bus_mute': 'mute'}[slot]
        event = {'type': 'bus', 'op': op, 'bus': 0 if op == 'count' else hook.get('bus_index', hook.get('value'))}
        if op == 'count': event['value'] = hook['value']
        if op == 'move': event['value'] = hook['to_index']
        if op == 'send': event['value'] = {'Master': 0, 'FX': 1}.get(hook['send'], -1)
        if op == 'volume_db': event['value'] = hook['volume_db']
        if op in ('solo', 'mute'): event['value'] = hook['enabled']
    if event is not None: expected.append(event)

def compare(want, got, path):
    if isinstance(want, dict):
        for key, value in want.items(): compare(value, got[key], f'{path}.{key}')
    elif isinstance(want, list):
        assert len(want) == len(got), (path, want, got)
        for i, value in enumerate(want): compare(value, got[i], f'{path}[{i}]')
    elif isinstance(want, (int, float)) and not isinstance(want, bool):
        assert math.isclose(want, got, rel_tol=1e-6, abs_tol=1e-6), (path, want, got)
    else:
        assert want == got, (path, want, got)
assert len(expected) == len(messages), (len(expected), len(messages), [m['type'] for m in messages])
for i, (want, got) in enumerate(zip(expected, messages)):
    compare(want, got, str(i))
    if got['type'] == 'sample':
        for variant in got['variants']:
            assert len(variant['hash']) == 64 and int(variant['hash'], 16) >= 0 and variant['bytes'] > 0
print(f'audio-samples: {len(messages)} messages equal G1 hook log; 0 mismatches')
