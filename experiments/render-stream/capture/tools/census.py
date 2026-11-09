#!/usr/bin/env python3
"""Read-only census of RenderingServer calls in ELF and Itanium PE images."""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import json
import os
import re
import struct
import subprocess
import sys
import tempfile

SCHEMA = "render-stream-census/1"
INSTRUCTION = re.compile(r'^\s*([0-9a-f]+):\s+(\S+)\s*(.*)$')
PREFIX = re.compile(r'^(?:notrack|bnd|data16|rex\.\w+|cs|ds)\s+(\S+)\s*(.*)$')
DIRECT = re.compile(r'^(?:0x)?([0-9a-f]+)(?:\s|$)')
INDIRECT = re.compile(r'^\*(0x[0-9a-f]+)?\(%(\w+)\)')
LOAD = re.compile(r'(0x[0-9a-f]+\(%rip\)|0x[0-9a-f]+),%(\w+)\s*(?:#\s*(?:0x)?([0-9a-f]+))?')
VPTR = re.compile(r'\(%(\w+)\),%(\w+)')
REFERENCES = re.compile(r'(?:#\s*|\$)0x([0-9a-f]+)')


class CensusError(Exception):
    pass


def instructions(lines):
    """Accept GNU objdump's AT&T spelling, including instruction prefixes."""
    for line in lines:
        match = INSTRUCTION.match(line)
        if match is None:
            continue
        addr, mnemonic, operands = match.groups()
        while True:
            prefixed = PREFIX.match(mnemonic + ' ' + operands)
            if not prefixed:
                break
            mnemonic, operands = prefixed.groups()
        yield int(addr, 16), mnemonic, operands


def scan(image, derived, lines):
    concrete = derived['concrete']['slots']
    prefix = derived['prefix']
    # Keep the original singleton algorithm's body-to-last-slot mapping. Direct
    # attribution below deliberately keeps *all* slots sharing a body.
    slots = {value: i for i, value in enumerate(concrete) if value and i >= prefix}
    lo, hi = prefix * 8, max(slots.values()) * 8 + 8
    by_body = defaultdict(list)
    for i, value in enumerate(concrete):
        if value:
            by_body[value].append(i)
    wanted = derived['slots']
    families = derived['families']
    wanted_by_body = defaultdict(set)
    aliases = defaultdict(set)
    for key, index in wanted.items():
        if families[key] == 'probe':
            continue
        body = concrete[index]
        wanted_by_body[body].add(key)
        off = image.vaddr_to_offset(body)
        if off is not None and image.data[off:off + 1] == b'\xe9' and off + 5 <= len(image.data):
            target = body + 5 + struct.unpack_from('<i', image.data, off + 1)[0]
            if image.is_code(target):
                aliases[target].add(key)

    loads, vload, calls = Counter(), Counter(), Counter()
    guards = 0
    guardslots = set()
    pend, vp = {}, {}
    band = Counter(call=0, jmp=0)
    direct_api, direct_prefix = Counter(), Counter()
    hits = defaultdict(Counter)
    sites = defaultdict(set)
    for n, (addr, mn, ops) in enumerate(instructions(lines), 1):
        # These windows and regexes intentionally mirror singleton discovery.
        refs = [int(x, 16) for x in REFERENCES.findall(ops)]
        if not mn.startswith(('call', 'jmp')) and any(r in slots for r in refs):
            guards += 1
            guardslots.update(slots[r] for r in refs if r in slots)
        if mn.startswith('mov'):
            mo = LOAD.match(ops)
            if mo and not ops.startswith('$'):
                src, reg, comment = mo.groups()
                target = int(comment, 16) if '(%rip)' in src and comment else (int(src, 16) if '(%rip)' not in src else None)
                if target:
                    pend[reg] = (target, n)
                    loads[target] += 1
            mv = VPTR.match(ops)
            if mv:
                a, b = mv.groups()
                if a in pend and n - pend[a][1] <= 6:
                    vload[pend[a][0]] += 1
                    vp[b] = (pend[a][0], n)
        transfer = 'call' if mn in ('call', 'callq') else 'jmp' if mn in ('jmp', 'jmpq') else None
        conditional = mn.startswith('j') and transfer is None
        if transfer:
            mc = INDIRECT.match(ops)
            if mc:
                displacement = int(mc.group(1) or '0', 16)
                reg = mc.group(2)
                if reg in vp and n - vp[reg][1] <= 20 and lo <= displacement < hi:
                    calls[vp[reg][0]] += 1
                if displacement % 8 == 0 and 300 <= displacement // 8 < len(concrete):
                    band[transfer] += 1
        if not (transfer or conditional):
            continue
        direct = DIRECT.match(ops)
        if direct is None:
            continue
        target = int(direct.group(1), 16)
        if transfer:
            for index in by_body.get(target, ()):
                (direct_api if index >= prefix else direct_prefix)[index] += 1
        for key in wanted_by_body.get(target, ()):
            hits[key]['jcc' if conditional else 'direct'] += 1
            if len(sites[key]) < 8 or addr < max(sites[key]):
                sites[key].add(addr)
                if len(sites[key]) > 8:
                    sites[key].remove(max(sites[key]))
        for key in aliases.get(target, ()):
            hits[key]['alias'] += 1
            if len(sites[key]) < 8 or addr < max(sites[key]):
                sites[key].add(addr)
                if len(sites[key]) > 8:
                    sites[key].remove(max(sites[key]))

    global_addr = calls.most_common(1)[0][0] if calls else None
    devirtualized = [dict(key=key, slot=index, family=families[key],
                          direct_calls=sum(hits[key].values()),
                          sites=[hex(addr) for addr in sorted(sites[key])])
                     for key, index in wanted.items() if hits[key]]
    required = [entry['key'] for entry in devirtualized if entry['family'] == 'required']
    dropped = sorted({entry['family'] for entry in devirtualized if entry['family'] != 'required'})
    return dict(singleton=dict(global_vaddr=hex(global_addr) if global_addr is not None else None,
                               loads=loads[global_addr], vptr_loaded=vload[global_addr], api_calls=calls[global_addr]),
                band=dict(call=band['call'], jmp=band['jmp'], total=sum(band.values())),
                guards=dict(total=guards, slots=len(guardslots)),
                direct_api={str(k): v for k, v in sorted(direct_api.items())},
                direct_prefix={str(k): v for k, v in sorted(direct_prefix.items())},
                verdict_hits={key: dict(direct=hits[key]['direct'], jcc=hits[key]['jcc'], alias=hits[key]['alias'])
                              for key in wanted if hits[key]},
                devirtualized_slots=devirtualized, dropped_families=dropped,
                refused_keys=required, verdict='refuse' if required else 'drop' if dropped else 'ok')


def toolchain(image):
    values = set()
    pe = image.platform == 'windows-x86_64'
    for section in image.alloc if pe else image.sections:
        if not pe and section['name'] != '.comment':
            continue
        data = image.data[section['offset']:section['offset'] + section['size']]
        if pe:
            patterns = (rb'GCC: \([^\x00\r\n]+', rb'clang version[^\x00\r\n]+',
                        rb'(?i:msvcrt\.dll|api-ms-win-crt-[a-z0-9-]+\.dll)')
            for pattern in patterns:
                values.update(m.group().decode('utf-8', 'replace') for m in re.finditer(pattern, data))
        else:
            values.update(part.decode('utf-8', 'replace') for part in data.split(b'\0') if part)
    return sorted(values)


def run(image, derived, objdump='objdump'):
    try:
        version = subprocess.run([objdump, '--version'], capture_output=True, text=True, check=True).stdout.splitlines()[0]
        formats = subprocess.run([objdump, '-i'], capture_output=True, text=True, check=True).stdout
        match = re.search(r'(\d+)\.(\d+)', version)
        if not match or tuple(map(int, match.groups())) < (2, 38) or 'pei-x86-64' not in formats:
            raise CensusError('GNU objdump >= 2.38 with pei-x86-64 is required')
        sections = [s['name'] for s in image.sections
                    if any(start == s['addr'] and end > start for start, end in image.exec_ranges)]
        command = [objdump, '-d', '--no-show-raw-insn']
        for name in sections:
            command.extend(['-j', name])
        command.append(image.path)
        with tempfile.TemporaryFile(mode='w+t') as errors:
            with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors, text=True,
                                  env=dict(os.environ, LC_ALL='C')) as process:
                try:
                    result = scan(image, derived, process.stdout)
                except BaseException:
                    process.terminate()
                    raise
                status = process.wait()
            if status:
                errors.seek(0)
                raise CensusError(f'objdump exited {status}: {errors.read().strip()}')
    except (OSError, subprocess.SubprocessError) as exc:
        raise CensusError(f'objdump: {exc}') from exc
    return dict(schema=SCHEMA, binary=os.path.basename(image.path),
                format='pe' if image.platform == 'windows-x86_64' else 'elf',
                objdump=version, toolchain=toolchain(image),
                vtable=dict(slots=derived['slot_count'], prefix=derived['prefix'],
                            placeholder_kind=derived['placeholder_kind'],
                            pure_placeholder=hex(derived['pure_placeholder']) if derived['pure_placeholder'] is not None else None,
                            pure_slots=derived['pure_count']), **result)


def report(result):
    print(f"census: {result['binary']} {result['version']} ({result['format']}, {result['objdump']})")
    print('toolchain: ' + '; '.join(result['toolchain']))
    v = result['vtable']
    print(f"vtable: slots {v['slots']} prefix {v['prefix']} placeholder {v['placeholder_kind']} {v['pure_placeholder'] or 'null'} ({v['pure_slots']} pure)")
    s = result['singleton']
    print(f"singleton: {s['vptr_loaded']} of {s['loads']} (global {s['global_vaddr'] or 'none'}, {s['api_calls']} api calls)")
    b = result['band']
    print(f"band: {b['total']} (call {b['call']}, jmp {b['jmp']})")
    print(f"guards: {result['guards']['total']} in {result['guards']['slots']} slots")
    print(f"direct api: {sum(result['direct_api'].values())} in {len(result['direct_api'])} slots {result['direct_api']}")
    print(f"direct prefix: {result['direct_prefix']}")
    entries = result['devirtualized_slots']
    print('wanted devirtualized: ' + (', '.join(f"{e['key']}@{e['slot']}({e['direct_calls']})" for e in entries) or 'none'))
    print('verdict hits: ' + json.dumps(result['verdict_hits'], sort_keys=True))
    print('verdict: ' + result['verdict'] + (' ' + ','.join(result['refused_keys'] if result['verdict'] == 'refuse' else result['dropped_families']) if result['verdict'] != 'ok' else ''))


def main(argv=None):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import calibrate

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', required=True)
    parser.add_argument('--header', required=True)
    parser.add_argument('--version-name', default=calibrate.DEFAULT_VERSION_NAME)
    parser.add_argument('--json', metavar='OUT')
    args = parser.parse_args(argv)
    try:
        image = calibrate.open_image(args.binary)
        derived = calibrate.derive(image, args.header, 'RenderingServer', 'RenderingServerDefault', set())
        result = run(image, derived)
        result['version'] = calibrate.engine_version_string(image, args.version_name)
        report(result)
        if args.json:
            with open(args.json, 'w', encoding='utf-8') as handle:
                json.dump(result, handle, indent=2)
                handle.write('\n')
        return 4 if result['verdict'] == 'refuse' else 0
    except (calibrate.CalibrationError, CensusError) as exc:
        print(f'census: {exc}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
