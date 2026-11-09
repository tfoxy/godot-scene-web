#!/usr/bin/env python3
"""Census fixtures and refusal checks; binaries are disassembled, never run."""

import argparse
import copy
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fixture_gen
import synth
from test_calibrate import safe_values

calibrate = synth.calibrate
census = calibrate.call_census
HERE = Path(__file__).resolve().parent
TOOL = HERE.parent / 'calibrate.py'

# Windows 4.6.2 has 13 rex.W band jumps omitted by the unstripped-mnemonic count.
REAL_CENSUS = {
    'lin': (588, 23, 1514, 1960, '0x47207e0', 633, 98, 858, 399, {}, {'14': 4, '16': 3, '21': 1}),
    'l462': (592, 22, 1551, 2028, '0x47c94e8', 668, 120, 867, 402, {}, {'9': 3, '14': 3, '20': 1}),
    'w462': (592, 22, 462, 535, '0x145ab7f70', 820, 13, 14, 7, {'79': 8, '578': 1}, {'9': 3, '14': 5, '16': 1, '20': 1}),
    # Windows custom builds have 3 rex.W band jumps omitted by the unstripped-mnemonic count.
    'win': (588, 23, 2101, 2690, '0x1457cec08', 1622, 3, 0, 0, {}, {'14': 4, '16': 2, '17': 1, '21': 1}),
}


def require(condition, detail):
    if not condition:
        raise AssertionError(detail)


def invoke(tool, *args):
    return subprocess.run([sys.executable, '-I', str(tool), *map(str, args)],
                          cwd='/', capture_output=True, text=True)


def arguments(binary, header):
    return argparse.Namespace(binary=str(binary), header=str(header), abstract_class='RenderingServer',
                              concrete_class='RenderingServerDefault', define=[], flavor='auto',
                              version_name='Godot Engine')


def inject(text, text_va, rdata_va, concrete_offset):
    declarations = synth.declarations()
    victim = synth.PREFIX + next(i for i, (name, _) in enumerate(declarations) if name == 'canvas_item_add_line')
    target = text_va + victim * 16
    origin = 0x1400
    code = bytearray()
    sites = []
    for opcode in (b'\xe8', b'\xe9', b'\x0f\x85'):
        sites.append(text_va + origin + len(code))
        code.extend(opcode + struct.pack('<i', target - (text_va + origin + len(code) + len(opcode) + 4)))
    # These displacements exercise the upper bound: this table has only 140 slots.
    code.extend(b'\xff\x90' + struct.pack('<I', 300 * 8))
    code.extend(b'\xff\xa0' + struct.pack('<I', 301 * 8))
    position = text_va + origin + len(code)
    code.extend(b'\x48\x8d\x15' + struct.pack('<i', target - (position + 7)))
    code.extend(b'\x48\x39\xd0')
    global_addr = rdata_va + 0xF00
    position = text_va + origin + len(code)
    code.extend(b'\x48\x8b\x05' + struct.pack('<i', global_addr - (position + 7)))
    code.extend(b'\x48\x8b\x08\xff\x91' + struct.pack('<I', victim * 8))
    code.extend(b'\xc3')
    text[origin:origin + len(code)] = code
    return dict(victim=victim, sites=[hex(v) for v in sites], singleton=hex(global_addr))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--update', action='store_true')
    parser.add_argument('--tool', type=Path, default=TOOL, help=argparse.SUPPRESS)
    parser.add_argument('--check-real-census', type=Path, metavar='DIR',
                        help='check saved census-{lin,l462,w462,win}.json evidence instead of fixtures')
    args = parser.parse_args()
    passed = failed = skipped = 0

    def test(name, function):
        nonlocal passed, failed
        try:
            function()
            passed += 1
            print('ok ' + name)
        except Exception as exc:
            failed += 1
            print(f'FAIL {name}: {exc}')

    if args.check_real_census:
        for tag, expected in REAL_CENSUS.items():
            def real_census():
                result = json.loads((args.check_real_census / f'census-{tag}.json').read_text())
                v, s, b, g = (result[k] for k in ('vtable', 'singleton', 'band', 'guards'))
                actual = (v['slots'], v['prefix'], s['vptr_loaded'], s['loads'], s['global_vaddr'],
                          b['call'], b['jmp'], g['total'], g['slots'], result['direct_api'], result['direct_prefix'])
                require(actual == expected, f'{actual} != {expected}')
                require(b['total'] == b['call'] + b['jmp'], 'band total differs')
                require(result['verdict'] == 'ok' and not result['devirtualized_slots']
                        and not result['verdict_hits'], 'wanted direct/jcc/alias hits')
            test('real-census-' + tag, real_census)
        print(f'census self-test: {passed} passed, {failed} failed, {skipped} skipped')
        return bool(failed)

    def partition():
        require(set(calibrate.FAMILIES) == {key for key, _ in calibrate.WANTED_SLOTS}, 'family keys differ')
        require(sum(f == 'required' for f in calibrate.FAMILIES.values()) == 8, 'required count')
    test('family-partition', partition)

    with tempfile.TemporaryDirectory(prefix='census-test-') as temporary:
        root = Path(temporary)
        header = root / 'fixture.h'
        synth.fixture_header(header)
        for tag, variant in (('elf', 'elf'), ('pe', 'pe-code')):
            binary = root / ('synth-' + tag)
            facts = synth.build(binary, variant, code=inject)
            image = calibrate.open_image(str(binary))
            derived = calibrate.derive(image, str(header), 'RenderingServer', 'RenderingServerDefault', set())
            result = census.run(image, derived)

            def golden():
                normalized = copy.deepcopy(result)
                # The installed tool version is evidence; the deterministic payload is golden.
                require(normalized.pop('objdump').startswith('GNU objdump'), 'objdump version missing')
                path = HERE / 'golden' / f'census-synth-{tag}.json'
                text = json.dumps(normalized, indent=2) + '\n'
                if args.update:
                    path.write_text(text)
                require(path.read_text() == text, f'golden differs: {path}')
                require(result['band'] == dict(call=0, jmp=0, total=0), 'out-of-range band counted')
                require(result['singleton'] == dict(global_vaddr=facts['code_facts']['singleton'], loads=1, vptr_loaded=1, api_calls=1), str(result['singleton']))
                hits = result['verdict_hits']['canvas_item_add_line']
                require(hits == dict(direct=2, jcc=1, alias=0), str(hits))
                require(result['devirtualized_slots'][0]['sites'] == facts['code_facts']['sites'], 'sites')
                require(result['guards'] == dict(total=1, slots=1), str(result['guards']))
            test(f'synthetic-{tag}', golden)

            def record_golden():
                run = invoke(args.tool, '--binary', binary, '--header', header)
                require(run.returncode == 0, run.stdout + run.stderr)
                record = json.loads(run.stdout)
                safe_values(record)
                path = HERE / 'golden' / f'census-record-synth-{tag}.json'
                if args.update:
                    path.write_text(run.stdout)
                require(path.read_text() == run.stdout, f'golden differs: {path}')
                require(record['devirtualized_slots'] == result['devirtualized_slots'], 'record census differs')
                require(record['dropped_families'] == ['canvas_item_draw'], 'dropped family')
                require(all(calibrate.FAMILIES[k] != 'canvas_item_draw' for k in record['slots']), 'family retained')
                require(all(k in record['slots'] for k, f in calibrate.FAMILIES.items() if f == 'required'), 'required hook removed')
                path = root / 'record.json'
                path.write_text(run.stdout)
                verified = invoke(args.tool, '--verify-record', path, '--binary', binary, '--header', header)
                require(verified.returncode == 0 and 'verified: 14/14' in verified.stdout, verified.stdout + verified.stderr)
                without_header = invoke(args.tool, '--verify-record', path, '--binary', binary)
                require(without_header.returncode == 2 and '--header is required' in without_header.stderr,
                        without_header.stdout + without_header.stderr)
            test(f'synthetic-record-{tag}', record_golden)

            def guard_only():
                text_va = derived['concrete']['slots'][derived['slots']['canvas_item_add_line']]
                guard = f' 100: lea 0x1(%rip),%rdx # 0x{text_va:x}\n'
                clean = census.scan(image, derived, [guard])
                require(clean['guards']['total'] == 1 and not clean['devirtualized_slots'], str(clean))
            test(f'guard-only-{tag}', guard_only)

            def parser_forms():
                target = derived['concrete']['slots'][derived['slots']['canvas_item_add_line']]
                lines = [f' {0x100 + i:x}: {mn} {operand}\n' for i, (mn, operand) in enumerate((
                    ('notrack callq', f'0x{target:x} <victim>'), ('bnd jmpq', f'{target:x} <victim>'),
                    ('data16 rex.W cs ds jne', f'{target:x} <victim>')))]
                scanned = census.scan(image, derived, lines)
                require(scanned['verdict_hits']['canvas_item_add_line'] == dict(direct=2, jcc=1, alias=0), str(scanned))
            test(f'instruction-prefixes-{tag}', parser_forms)

            def band_and_zero():
                expanded = copy.deepcopy(derived)
                expanded['concrete']['slots'] += [0] * 200
                expanded['slot_count'] = len(expanded['concrete']['slots'])
                lines = [' 100: call *0x960(%rax)', ' 110: jmpq *0x968(%rax)',
                         ' 120: call *0x95f(%rax)', ' 130: call *0xaa0(%rax)',
                         '   140086206:\trex.W jmp *0x9c8(%rax)']
                scanned = census.scan(image, expanded, lines)
                require(scanned['band'] == dict(call=1, jmp=2, total=3), str(scanned['band']))
                require(scanned['singleton']['global_vaddr'] is None and not scanned['direct_api'], 'zero-hit crash')
            test(f'band-and-zero-hits-{tag}', band_and_zero)

            def probe_exempt():
                target = derived['concrete']['slots'][derived['slots']['get_default_clear_color']]
                scanned = census.scan(image, derived, [f' 100: call {target:x}'])
                require(not scanned['devirtualized_slots'] and scanned['direct_api'], str(scanned))
            test(f'probe-exempt-{tag}', probe_exempt)

        def alias_and_sites():
            def alias_code(text, text_va, rdata_va, concrete_offset):
                facts = inject(text, text_va, rdata_va, concrete_offset)
                offset = facts['victim'] * 16
                alias = text_va + 0x1800
                text[offset:offset + 5] = b'\xe9' + struct.pack('<i', alias - (text_va + offset + 5))
                return facts
            binary = root / 'alias'
            synth.build(binary, 'elf', code=alias_code)
            image = calibrate.open_image(str(binary))
            derived = calibrate.derive(image, str(header), 'RenderingServer', 'RenderingServerDefault', set())
            target = derived['concrete']['slots'][0] + 0x1800
            # Descending input proves sites are capped by address, not arrival order.
            lines = [f' {addr:x}: call {target:x}' for addr in range(20, 0, -1)]
            scanned = census.scan(image, derived, lines)
            entry = scanned['devirtualized_slots'][0]
            require(entry['direct_calls'] == 20 and entry['sites'] == [hex(i) for i in range(1, 9)], str(entry))
            require(scanned['verdict_hits'][entry['key']]['alias'] == 20, str(scanned))
        test('alias-and-eight-ascending-sites', alias_and_sites)

        def required_synthetic():
            binary = root / 'required'
            def code(text, text_va, rdata_va, concrete_offset):
                index = synth.PREFIX + next(i for i, (name, _) in enumerate(synth.declarations()) if name == 'free')
                target = text_va + index * 16
                text[0x1400:0x1405] = b'\xe8' + struct.pack('<i', target - (text_va + 0x1405))
            synth.build(binary, 'elf-pie', code=code)
            output = root / 'required-record.json'
            run = invoke(args.tool, '--binary', binary, '--header', header, '--out', output)
            require(run.returncode == 2 and 'devirtualized required slot(s): free@' in run.stderr, run.stdout + run.stderr)
            require(not output.exists(), 'required refusal wrote a record')
            output.write_text('preserve me')
            run = invoke(args.tool, '--binary', binary, '--header', header, '--out', output)
            require(run.returncode == 2 and output.read_text() == 'preserve me', 'required refusal changed output')
            record, derived = calibrate.build_record(arguments(binary, header), census=False)
            for listed in (False, True):
                if listed:
                    record['devirtualized_slots'] = [dict(key='free', slot=derived['slots']['free'], family='required', direct_calls=1, sites=[])]
                output.write_text(json.dumps(record))
                verified = invoke(args.tool, '--verify-record', output, '--binary', binary, '--header', header)
                require(verified.returncode == 3 and 'check devirtualized FAIL free@' in verified.stdout
                        and 'refused: devirtualized' in verified.stdout, verified.stdout + verified.stderr)
        test('synthetic-required-refusal-and-verifier', required_synthetic)

        def optional_sabotages():
            binary = root / 'optional'
            synth.build(binary, 'elf', code=inject)
            record, _ = calibrate.build_record(arguments(binary, header))
            output = root / 'optional-record.json'
            variants = []
            missing = copy.deepcopy(record)
            missing['devirtualized_slots'] = []
            variants.append(missing)
            erased = copy.deepcopy(missing)
            erased['dropped_families'] = []
            variants.append(erased)
            family = copy.deepcopy(record)
            family['dropped_families'] = []
            variants.append(family)
            retained = copy.deepcopy(record)
            retained['slots']['canvas_item_add_line'] = record['devirtualized_slots'][0]['slot']
            variants.append(retained)
            wrong = copy.deepcopy(record)
            wrong['devirtualized_slots'][0]['family'] = 'texture'
            variants.append(wrong)
            for tampered in variants:
                output.write_text(json.dumps(tampered))
                verified = invoke(args.tool, '--verify-record', output, '--binary', binary, '--header', header)
                require(verified.returncode == 3 and 'refused: devirtualized' in verified.stdout, verified.stdout + verified.stderr)
        test('optional-record-sabotages', optional_sabotages)

        builds = [('elf', ['g++', '-O2', '-std=c++17'])]
        mingw = os.environ.get('LLVM_MINGW_ROOT')
        if not mingw:
            helper = HERE.parents[2] / 'scripts/lib/llvm-mingw.sh'
            if helper.is_file():
                ensured = subprocess.run(['bash', str(helper), '--ensure'], capture_output=True, text=True)
                require(ensured.returncode == 0, ensured.stdout + ensured.stderr)
                mingw = ensured.stdout.strip().splitlines()[-1]
        if mingw and (Path(mingw) / 'bin/x86_64-w64-mingw32-clang++').is_file():
            builds.append(('pe', [str(Path(mingw) / 'bin/x86_64-w64-mingw32-clang++'), '-O2', '-std=c++17', '-static', '-Wl,--build-id']))
        else:
            print('skip pe-fixture: llvm-mingw not cached')
            skipped += 2
            if os.environ.get('GRC_REQUIRE_PE_FIXTURE') == '1':
                test('required-pe-fixture', lambda: require(False, 'llvm-mingw not cached'))
        for kind, compiler in builds:
            for victim in ('canvas_item_add_line', 'free'):
                def compiled():
                    directory = root / f'{kind}-{victim}'
                    directory.mkdir()
                    header, source = fixture_gen.generate(directory, victim)
                    binary = directory / ('fixture.exe' if kind == 'pe' else 'fixture')
                    build = subprocess.run([*compiler, str(source), '-o', str(binary)], capture_output=True, text=True)
                    require(build.returncode == 0, build.stdout + build.stderr)
                    symbols = subprocess.run(['objdump', '-t', str(binary)], capture_output=True, text=True, check=True).stdout
                    direct = next((line.split()[-1] for line in symbols.splitlines() if '_Z14fixture_direct' in line), None)
                    require(direct, 'fixture_direct symbol missing')
                    disassembly = subprocess.run(['objdump', '-d', '--no-show-raw-insn', '--disassemble=' + direct, str(binary)], capture_output=True, text=True, check=True).stdout
                    victim_symbol = f'_ZN22RenderingServerDefault{len(victim)}{victim}Em'
                    victim_line = next((line for line in symbols.splitlines() if line.endswith(victim_symbol)), None)
                    require(victim_line, 'VICTIM symbol missing')
                    victim_code = subprocess.run(['objdump', '-d', '--no-show-raw-insn', '--disassemble=' + victim_symbol,
                                                  str(binary)], capture_output=True, text=True, check=True).stdout
                    target = next(census.instructions(victim_code.splitlines()))[0]
                    require(any(mn in ('call', 'callq', 'jmp', 'jmpq') and census.DIRECT.match(ops)
                                and int(census.DIRECT.match(ops).group(1), 16) == target
                                for _, mn, ops in census.instructions(disassembly.splitlines())), 'fixture not devirtualized by this compiler')
                    image = calibrate.open_image(str(binary))
                    derived = calibrate.derive(image, str(header), 'RenderingServer', 'RenderingServerDefault', set())
                    require(derived['placeholder_kind'] == ('code' if kind == 'pe' else 'null'),
                            f"unexpected {kind} placeholder: {derived['placeholder_kind']}")
                    if kind == 'pe':
                        require(image.codeview(), 'PE fixture has no RSDS entry')
                    output = directory / 'record.json'
                    run = invoke(args.tool, '--binary', binary, '--header', header, '--out', output)
                    if victim == 'canvas_item_add_line':
                        require(run.returncode == 0, run.stdout + run.stderr)
                        record = json.loads(output.read_text())
                        require([e['key'] for e in record['devirtualized_slots']] == [victim], str(record['devirtualized_slots']))
                        require(record['devirtualized_slots'][0]['direct_calls'] >= 1, 'no direct calls')
                        require(record['dropped_families'] == ['canvas_item_draw'], str(record))
                        require(all(calibrate.FAMILIES[k] != 'canvas_item_draw' for k in record['slots']), 'family kept')
                        require(all(k in record['slots'] for k, f in calibrate.FAMILIES.items() if f == 'required'), 'required removed')
                        verified = invoke(args.tool, '--verify-record', output, '--binary', binary, '--header', header)
                        require(verified.returncode == 0 and 'verified: 14/14' in verified.stdout, verified.stdout + verified.stderr)
                    else:
                        require(run.returncode == 2 and 'devirtualized required slot(s): free@' in run.stderr, run.stdout + run.stderr)
                        require(not output.exists(), 'refused record written')
                        output.write_text('preserve me')
                        repeat = invoke(args.tool, '--binary', binary, '--header', header, '--out', output)
                        require(repeat.returncode == 2 and output.read_text() == 'preserve me', 'existing output changed')
                        record, derived = calibrate.build_record(arguments(binary, header), census=False)
                        for listed in (False, True):
                            if listed:
                                record['devirtualized_slots'] = [dict(key='free', slot=derived['slots']['free'], family='required', direct_calls=1, sites=[])]
                            output.write_text(json.dumps(record))
                            verified = invoke(args.tool, '--verify-record', output, '--binary', binary, '--header', header)
                            require(verified.returncode == 3 and 'check devirtualized FAIL free@' in verified.stdout
                                    and 'refused: devirtualized' in verified.stdout, verified.stdout + verified.stderr)
                test(f'compiled-{kind}-{victim}', compiled)
    print(f'census self-test: {passed} passed, {failed} failed, {skipped} skipped')
    return bool(failed)


if __name__ == '__main__':
    raise SystemExit(main())
