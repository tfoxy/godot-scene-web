#!/usr/bin/env python3
"""Deterministic /19 node compatibility, material endpoints and associated streams."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import sys

HERE = Path(__file__).resolve().parent


def load(version):
    spec = importlib.util.spec_from_file_location(f'golden{version}', HERE.parent / f'golden-{version}/make_golden.py')
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


g17 = load(17)
g18 = load(18)
g16 = g17.g16
MAGIC = b'GRSJ\r\n\x1a\n'


def unpack(record):
    _, size = struct.unpack_from('<II', record)
    meta = json.loads(record[8:8+size])
    pos = 12 + size
    blocks = []
    for _ in meta['blocks']:
        count, = struct.unpack_from('<I', record, pos)
        blocks.append(record[pos+4:pos+4+count])
        pos += 4 + count
    return meta, blocks


def pack(meta, blocks=()):
    return g16.make_record(json.dumps(meta, separators=(',', ':')).encode(), blocks)


def step(name='threshold', ty='float', component=None, at=0, to=1):
    return dict(param=name, type=ty, component=component, start_us=0,
                duration_us=1000000, trans=0, ease=2, **{'from': at, 'to': to})


def begin(steps=None):
    return dict(op='begin', tween_id='7001', material=1, order=1,
                begin_us=0, end_us=1000000, steps=steps or [step()])


def tween(events, values=(), poses=None, seq=1):
    return dict(type='tween', seq=seq, frame=seq, t_us=0, events=events,
                poses=poses or [], blocks=[dict(name='tween_f32', type='f32', count=len(values))] if values else [])


def associated(meta, values, *, bad=None, version=19, second=None):
    source = g18.recording(version, 1)
    records = g16.records(source, source[:8])
    session, session_blocks = unpack(records[0])
    session = {k: v for k, v in session.items() if k != 'blocks'} | {'client_tweens': True, 'blocks': session['blocks']}
    tx, blocks = unpack(records[1])
    tx = dict(list(tx.items())[:3] + [('t_us', 0)] + list(tx.items())[3:])
    shader = dict(id=1, origin='created', status='ok', reason=None, version=1,
                  mode='canvas_item', source='payload', hash='2c874800cd97ba181708fd009b2ec9ab5c49e666c285a39427cf5f8ccf761310',
                  payload_bytes=157, builtin=None, uses=[], default_textures=[])
    tx['shaders'] = [shader]
    params, floats = [], []
    for name, ty, vals in [('offset', 'vector2', [1, 2]), ('threshold', 'float', [1]),
                           ('tint', 'color', [1, 1, 1, 1]), ('v3', 'vector3', [1, 2, 3]),
                           ('v4', 'vector4', [1, 2, 3, 4])]:
        params.append(dict(name=name, type=ty, n=1, tex=None, f=len(floats)))
        floats += vals
    material = dict(id=1, origin='created', status='ok', reason=None, version=1, shader=1, params=params)
    tx['materials'] = [material]
    if bad == 'material-missing': tx['materials'] = []
    if bad == 'param-missing': params[1]['name'] = 'threshold_absent'
    if bad == 'param-type-mismatch': params[1]['type'] = 'int'
    if bad == 'material-unsupported': material['shader'] = None
    tx['blocks'][5]['count'] = len(floats)
    blocks[5] = struct.pack('<' + 'd'*len(floats), *floats)
    if bad == 'material-missing':
        blocks[5] = b''; tx['blocks'][5]['count'] = 0
    event = g17.record(meta, values)
    body = [pack(session, session_blocks), event, pack(tx, blocks)]
    if second is not None:
        # Param removal is a legitimate host update; the ordinary cancel releases claims.
        tx2 = copy.deepcopy(tx)
        tx2['seq'] = tx2['frame'] = 2
        tx2['materials'][0]['version'] = 2
        tx2['materials'][0]['params'] = []
        blocks2 = blocks.copy(); blocks2[5] = b''; tx2['blocks'][5]['count'] = 0
        body += [g17.record(second, []), pack(tx2, blocks2)]
    return source[:8] + b''.join(body) + g16.end_record(body, 2 if second else 1, 2 if second else 1)


def downgrade(data):
    """Independent prefix-only expected /18 transcode for the mixed fixture."""
    body = []
    material_ids = set()
    for raw in g16.records(data, MAGIC):
        meta, blocks = unpack(raw)
        if meta['type'] == 'end': continue
        if meta['type'] == 'session': meta['protocol'] = 'render-stream/18'
        if meta['type'] == 'tween':
            kept = []
            for e in meta['events']:
                tid = e['tween_id']
                if e['op'] == 'begin':
                    if 'material' in e: material_ids.add(tid); continue
                    material_ids.discard(tid)
                elif tid in material_ids: material_ids.remove(tid); continue
                kept.append(e)
            meta['events'] = kept
            count = 0
            for e in kept:
                if e['op'] == 'begin':
                    for s in e['steps']: count = s['to'] + (2 if s['property'] == 'position' else 1)
            for p in meta['poses']: count = p['f'] + 16
            meta['blocks'] = [dict(name='tween_f32', type='f32', count=count)] if count else []
            blocks = [blocks[0][:4*count]] if count else []
            if not kept and not meta['poses']: continue
        body.append(pack(meta, blocks))
    return b'GRSI\r\n\x1a\n' + b''.join(body) + g16.end_record(body, 1, 1)


def build():
    outputs = {}
    index = dict(schema='render-stream-19-golden-index/1', protocol='render-stream/19', valid=[], invalid=[])
    # Inherit the original /17 vectors; associated recordings are added per version below.
    old = g17.build(include_associated=False)
    old_index = json.loads(old['index.json'])
    for group in ('valid', 'invalid'):
        for entry in old_index[group]:
            name = entry['file'].replace('.rs17', '.rs19')
            data = old[entry['file']]
            if name.endswith('.rs19'):
                data = g16._retag(data, g17.MAGIC, MAGIC, lambda m: g16.g13._swap_protocol(m, 'render-stream/17', 'render-stream/19'))
            outputs[name] = data
            row = {k: v for k, v in entry.items() if k not in ('hex', 'rs16', 'sha256')}
            row['file'] = name
            if 'decoded' in entry:
                outputs[entry['decoded']] = old[entry['decoded']]
            if group == 'valid': row['sha256'] = hashlib.sha256(data).hexdigest()
            index[group].append(row)
    for window in (1, 8):
        name = f'window{window}.rs19'
        outputs[name] = g18.recording(19, window)
        index['valid'].append(dict(file=name, sha256=hashlib.sha256(outputs[name]).hexdigest()))
    vectors = {}
    vectors['material-begin'] = (tween([begin()], [1, 0]), [1, 0])
    vectors['material-component'] = (tween([begin([step('offset', 'vector2', 1)])], [2, 5]), [2, 5])
    types = [step('v3', 'vector3', at=0, to=3), step('v4', 'vector4', at=6, to=10), step('tint', 'color', at=14, to=18)]
    values = [1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 6, 7, 8, 1, 1, 1, 1, 0, 0, 0, 0]
    vectors['material-types'] = (tween([begin(types)], values), values)
    node = dict(op='begin', tween_id='8001', item=1, order=2, begin_us=0, end_us=1000000,
                steps=[dict(property='position', start_us=0, duration_us=1000000, trans=0, ease=2, **{'from': None, 'to': 0})])
    values = [100, 200] + [0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1] + [1, 0]
    vectors['mixed'] = (tween([begin([step(at=18, to=19)]), node], values, [dict(item=1, kind='node2d', f=2)]), values)
    cancel = tween([dict(op='cancel', tween_id='7001')], seq=2)
    vectors['material-cancel'] = (cancel, [])
    vectors['invalidation-cancel'] = (copy.deepcopy(cancel), [])
    for name, (meta, values) in vectors.items():
        data = g17.record(meta, values)
        outputs[name+'.record'] = data
        outputs[name+'.decoded.json'] = (json.dumps(dict(meta=meta, tween_f32=values), indent=2)+'\n').encode()
        index['valid'].append(dict(file=name+'.record', record_only=True, decoded=name+'.decoded.json', sha256=hashlib.sha256(data).hexdigest()))
    meta, values = vectors['mixed']
    outputs['mixed.rs19'] = associated(meta, values)
    outputs['mixed.to18.rs18'] = downgrade(outputs['mixed.rs19'])
    index['valid'].append(dict(file='mixed.rs19', to18='mixed.to18.rs18', sha256=hashlib.sha256(outputs['mixed.rs19']).hexdigest()))
    # A full stream proves legitimate invalidation + cancel association.
    meta, values = vectors['material-begin']
    outputs['invalidation-cancel.rs19'] = associated(meta, values, second=cancel)
    index['valid'].append(dict(file='invalidation-cancel.rs19', sha256=hashlib.sha256(outputs['invalidation-cancel.rs19']).hexdigest()))
    mutations = [
        ('material-in-rs18', 'meta-schema', lambda m: None),
        ('item-and-material', 'meta-schema', lambda m: m['events'][0].update(item=1)),
        ('bad-type', 'meta-schema', lambda m: m['events'][0]['steps'][0].update(type='int')),
        ('component-on-float', 'meta-schema', lambda m: m['events'][0]['steps'][0].update(component=0)),
        ('component-range', 'meta-schema', lambda m: m['events'][0]['steps'][0].update(type='vector2', component=2)),
        ('material-wrong-offset', 'tween-offset', lambda m: m['events'][0]['steps'][0].update(to=2)),
        ('material-wrong-count', 'tween-offset', lambda m: m['blocks'][0].update(count=3)),
        ('material-nonfinite', 'tween-offset', lambda m: None),
    ]
    for name, code, mutate in mutations:
        m = copy.deepcopy(meta); mutate(m)
        v = [float('inf'), 0] if name == 'material-nonfinite' else values
        file = 'invalid/'+name+'.record'
        outputs[file] = g17.record(m, v)
        index['invalid'].append(dict(file=file, error=code, record_only=True, version=18 if name == 'material-in-rs18' else 19))
    for name in ('material-missing', 'param-missing', 'param-type-mismatch', 'inconsistent-param-types', 'material-unsupported'):
        m = copy.deepcopy(meta); v = values
        if name == 'inconsistent-param-types':
            m['events'][0]['steps'].append(step('threshold', 'vector2', at=2, to=4))
            v = values + [1, 2, 3, 4]; m['blocks'][0]['count'] = 6
        file = 'invalid/'+name+'.rs19'
        outputs[file] = associated(m, v, bad=name)
        index['invalid'].append(dict(file=file, error='tween-entry'))
    for name, code, kwargs in [
        ('tween-without-grant', 'meta-schema', {'grant': False}),
        ('client-tweens-key-order', 'meta-schema', {'bad': 'client-tweens-key-order'}),
        ('missing-t-us', 'tween-association', {'bad': 'missing-t-us'}),
    ]:
        file = 'invalid/'+name+'.rs19'
        outputs[file] = g17.node_recording(19, **kwargs)
        index['invalid'].append(dict(file=file, error=code))
    outputs['index.json'] = (json.dumps(index, indent=2)+'\n').encode()
    return outputs


def main():
    outputs = build()
    for name, data in outputs.items():
        path = HERE/name
        if '--check' in sys.argv:
            if not path.is_file() or path.read_bytes() != data: raise SystemExit(f'golden-19: stale or missing {name}')
        else:
            path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data)
    print(f'golden-19: {len(outputs)} files {"checked" if "--check" in sys.argv else "written"}')


if __name__ == '__main__': main()
