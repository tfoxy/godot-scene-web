#!/usr/bin/env python3
"""Mach-O dispatch scans: numeric and symbolic targets, guards and positive controls."""
from pathlib import Path
import struct
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import synth

calibrate = synth.calibrate
census = calibrate.call_census


def require(ok, message):
    if not ok:
        raise AssertionError(message)


def inject(arch, text, text_va, vt, hooked=None):
    offset = 0x1800
    site = text_va + offset
    target = text_va + (hooked or 0) * 16
    if arch == 'x86_64':
        code = b'\xe8' + struct.pack('<i', target - site - 5)
        code += b'\x48\x8d\x05' + struct.pack('<i', vt + 16 - (site + 12))
        code += b'\xc3'
    else:
        delta = ((vt + 16) >> 12) - ((site + 4) >> 12)
        adrp = 0x90000008 | ((delta & 3) << 29) | (((delta >> 2) & 0x7FFFF) << 5)
        add = 0x91000108 | (((vt + 16) & 0xFFF) << 10)
        code = struct.pack('<4I', 0x94000000 | (((target - site) >> 2) & 0x3FFFFFF), adrp, add, 0xD65F03C0)
    text[offset:offset + len(code)] = code


def main():
    passed = failed = 0

    def test(name, function):
        nonlocal passed, failed
        try:
            function()
            print('ok ' + name)
            passed += 1
        except Exception as exc:
            print(f'FAIL {name}: {exc}')
            failed += 1

    with tempfile.TemporaryDirectory(prefix='macho-census-') as temp:
        root = Path(temp)
        header = root / 'fixture.h'
        synth.fixture_header(header)
        binary = root / 'universal'
        synth.macho(binary, code=inject)

        def derive(arch):
            image = calibrate.open_image(str(binary), arch)
            return image, calibrate.derive(image, str(header), 'RenderingServer', 'RenderingServerDefault', set())

        for arch in ('x86_64', 'arm64'):
            def disassemble():
                image, derived = derive(arch)
                result = census.run(image, derived)
                require(result['format'] == 'macho' and result['verdict'] == 'ok', str(result))
                require(sum(result['direct_prefix'].values()) == 1, str(result))
                require(result['controls']['vtable_references'] == 1, str(result))
                require(not result['direct_api'] and result['guards']['total'] == 0, str(result))
            test(f'macho-{arch}-pinned-disassembly-controls', disassemble)

            def transfers(guard=False, symbolic=False):
                image, derived = derive(arch)
                wanted = derived['slots']
                key = next(key for key in wanted if derived['families'][key] == 'required')
                index = wanted[key]
                target = derived['concrete']['slots'][index]
                # Attribute a shared body to every hook using it.
                second = next(k for k in wanted if k != key and derived['families'][k] != 'probe')
                derived['concrete']['slots'][wanted[second]] = target
                image.symbols['__hook'] = target
                token = '__hook' if symbolic else hex(target)
                if guard:
                    if arch == 'arm64':
                        lines = [f'100002800: adrp x8, 0 ; 0x{target & ~0xFFF:x}',
                                 f'100002804: add x8, x8, #{target & 0xFFF}']
                    else:
                        lines = [f'100002800: leaq {target - 0x100002807}(%rip), %rax', '100002807: retq']
                else:
                    lines = [f'100002800: {"bl" if arch == "arm64" else "callq"} {token}']
                result = census.scan_macho(image, derived, lines)
                require(result['verdict'] == 'refuse' and key in result['refused_keys'], str(result))
                entries = {entry['key']: entry for entry in result['devirtualized_slots']}
                require(key in entries and second in entries, str(result))
                require(entries[key]['sites'] == [hex(0x100002804 if guard and arch == 'arm64' else 0x100002800)], str(result))
            test(f'macho-{arch}-numeric-direct-refusal', transfers)
            test(f'macho-{arch}-symbolic-direct-refusal', lambda: transfers(symbolic=True))
            test(f'macho-{arch}-guard-refusal', lambda: transfers(guard=True))

            def indirect():
                image, derived = derive(arch)
                derived['concrete']['slots'] += list(range(588 - synth.SLOT_COUNT))
                if arch == 'arm64':
                    lines = ['100002800: ldr x8, [x9, #2400]', '100002804: blr x8',
                             '100002808: ldr x10, [x9, #0x968]', '10000280c: br x10']
                else:
                    lines = ['100002800: callq *0x960(%rax)', '100002804: jmpq *0x968(%rax)']
                result = census.scan_macho(image, derived, lines)
                require(result['band'] == dict(call=1, jmp=1, total=2), str(result))
            test(f'macho-{arch}-indirect-band', indirect)

        def adr_guard(displacement, immediate, comment=False):
            image, derived = derive('arm64')
            key = next(k for k in derived['slots'] if derived['families'][k] == 'required')
            target = derived['concrete']['slots'][derived['slots'][key]]
            site = target - displacement
            suffix = f' ; 0x{target:x}' if comment else ''
            lines = [f'{site:x}: adr x8, {immediate}{suffix}', f'{site + 4:x}: cmp x9, x8',
                     f'{site + 8:x}: blr x8', f'{site + 12:x}: ret']
            result = census.scan_macho(image, derived, lines)
            require(result['verdict'] == 'refuse' and key in result['refused_keys'], str(result))
            require(result['guards'] == dict(total=1, slots=1), str(result))
            entry = next(e for e in result['devirtualized_slots'] if e['key'] == key)
            require(entry['sites'] == [hex(site)], str(result))
        test('macho-arm64-adr-negative-refusal', lambda: adr_guard(-5920, '#-5920'))
        test('macho-arm64-adr-positive-refusal', lambda: adr_guard(5920, '#5920'))
        test('macho-arm64-adr-negative-hex-comment-refusal', lambda: adr_guard(-5920, '-0x1720', True))
        test('macho-arm64-adr-positive-comment-refusal', lambda: adr_guard(5920, '#5920', True))

        def arm_clobber():
            image, derived = derive('arm64')
            key = next(k for k in derived['slots'] if derived['families'][k] == 'required')
            target = derived['concrete']['slots'][derived['slots'][key]]
            lines = [f'100002800: adrp x8, 0 ; 0x{target & ~0xFFF:x}', '100002804: mov x8, x0',
                     f'100002808: add x8, x8, #{target & 0xFFF}']
            require(census.scan_macho(image, derived, lines)['verdict'] == 'ok', 'stale adrp survived clobber')
        test('macho-arm64-adrp-clobber', arm_clobber)

        def native_direct_refuses():
            _, derived = derive('arm64')
            key = next(k for k in derived['slots'] if derived['families'][k] == 'required')
            index = derived['slots'][key]
            synth.macho(binary, code=lambda *args: inject(*args, hooked=index))
            for arch in ('arm64', 'x86_64'):
                image, table = derive(arch)
                result = census.run(image, table)
                require(result['verdict'] == 'refuse' and key in result['refused_keys'], str(result))
        test('macho-pinned-disassembly-direct-refusals-both-slices', native_direct_refuses)

        def native_adr_refuses():
            _, derived = derive('arm64')
            key = next(k for k in derived['slots'] if derived['families'][k] == 'required')
            index = derived['slots'][key]
            sites = []

            def inject_adr(arch, text, text_va, vt):
                if arch == 'x86_64':
                    return inject(arch, text, text_va, vt)
                offset = 0x1800
                site = text_va + offset
                sites.append(hex(site))
                delta = text_va + index * 16 - site
                require(-(1 << 20) <= delta < (1 << 20), 'ADR target out of range')
                immediate = delta & ((1 << 21) - 1)
                adr = 0x10000008 | ((immediate & 3) << 29) | ((immediate >> 2) << 5)
                # adr x8, target; cmp x9, x8; blr x8; ret
                text[offset:offset + 16] = struct.pack('<4I', adr, 0xEB08013F, 0xD63F0100, 0xD65F03C0)

            synth.macho(binary, code=inject_adr)
            image, table = derive('arm64')
            result = census.run(image, table)
            require(result['verdict'] == 'refuse' and key in result['refused_keys'], str(result))
            require(result['guards'] == dict(total=1, slots=1) and not result['direct_api'], str(result))
            entry = next(e for e in result['devirtualized_slots'] if e['key'] == key)
            require(entry['sites'] == sites, str(result))
        test('macho-arm64-pinned-disassembly-adr-refusal', native_adr_refuses)

    print(f'macho census self-test: {passed} passed, {failed} failed, 0 skipped')
    return bool(failed)


if __name__ == '__main__':
    raise SystemExit(main())
