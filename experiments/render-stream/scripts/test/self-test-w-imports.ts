#!/usr/bin/env -S pnpm exec tsx --conditions=development
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const tool = fileURLToPath(new URL("../w-imports.py", import.meta.url));
const scratchRoot = fileURLToPath(
  new URL("../../../../.local/", import.meta.url),
);
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "w-imports-"));
let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: ${detail}`}`);
}

// A single .idata section with independently allocated normal and delay tables.
function pe(imports: string[], delay: string[] = [], delayVa = false): Buffer {
  const bytes = Buffer.alloc(0x1200);
  const opt = 0x98;
  bytes.write("MZ");
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80);
  bytes.writeUInt16LE(0x8664, 0x84);
  bytes.writeUInt16LE(1, 0x86);
  bytes.writeUInt16LE(240, 0x94);
  bytes.writeUInt16LE(0x20b, opt);
  const imageBase = delayVa ? 0x400000 : 0x140000000;
  bytes.writeBigUInt64LE(BigInt(imageBase), opt + 24);
  bytes.writeUInt32LE(0x200, opt + 60);
  bytes.writeUInt32LE(16, opt + 108);
  const section = opt + 240;
  bytes.write(".idata", section);
  bytes.writeUInt32LE(0x1000, section + 8);
  bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(0x1000, section + 16);
  bytes.writeUInt32LE(0x200, section + 20);
  let cursor = 0x200;
  for (const [names, directory, stride] of [
    [imports, 1, 20],
    [delay, 13, 32],
  ] as const) {
    if (names.length === 0) continue;
    const table = cursor;
    const size = (names.length + 1) * stride;
    cursor += size;
    bytes.writeUInt32LE(table + 0xe00, opt + 112 + directory * 8);
    bytes.writeUInt32LE(size, opt + 116 + directory * 8);
    names.forEach((name, index) => {
      const descriptor = table + index * stride;
      const rva = cursor + 0xe00;
      if (directory === 13) {
        bytes.writeUInt32LE(delayVa ? 0 : 1, descriptor);
        bytes.writeUInt32LE(delayVa ? imageBase + rva : rva, descriptor + 4);
      } else {
        bytes.writeUInt32LE(rva, descriptor + 12);
      }
      bytes.write(`${name}\0`, cursor, "ascii");
      cursor += Buffer.byteLength(name) + 1;
    });
    cursor = (cursor + 3) & ~3;
  }
  return bytes;
}

function binary(name: string, bytes: Buffer): string {
  const path = join(scratch, name);
  writeFileSync(path, bytes);
  return path;
}

function exportedPe(names: string[], unnamed = false): Buffer {
  const bytes = pe(["kernel32.dll"]);
  const rva = (offset: number) => offset + 0xe00;
  bytes.writeUInt32LE(rva(0x600), 0x98 + 112);
  bytes.writeUInt32LE(40, 0x98 + 116);
  bytes.writeUInt32LE(names.length + Number(unnamed), 0x600 + 20);
  bytes.writeUInt32LE(names.length, 0x600 + 24);
  bytes.writeUInt32LE(rva(0x640), 0x600 + 28);
  bytes.writeUInt32LE(rva(0x680), 0x600 + 32);
  bytes.writeUInt32LE(rva(0x6c0), 0x600 + 36);
  let cursor = 0x700;
  names.forEach((name, index) => {
    bytes.writeUInt32LE(0x1000 + index, 0x640 + index * 4);
    bytes.writeUInt32LE(rva(cursor), 0x680 + index * 4);
    bytes.writeUInt16LE(index, 0x6c0 + index * 2);
    bytes.write(`${name}\0`, cursor, "ascii");
    cursor += Buffer.byteLength(name) + 1;
  });
  if (unnamed) bytes.writeUInt32LE(0x1100, 0x640 + names.length * 4);
  return bytes;
}

function run(...args: string[]) {
  const result = spawnSync("python3", ["-I", tool, ...args], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return { rc: result.status, text: result.stdout + result.stderr };
}

try {
  const prng = run(binary("rust-prng.dll", pe(["BCRYPTPRIMITIVES.dll"])));
  check("rust-std-process-prng", prng.rc === 0, prng.text);
  const symbols = ["grc_net_module_v1", "grc_net_tls_v1"];
  const expectExports = ["--expect-exports", symbols.join(",")];
  const exportsReport = join(scratch, "exports.json");
  const exportsMatch = run(
    ...expectExports,
    "--json",
    exportsReport,
    binary("net.dll", exportedPe([...symbols].reverse())),
  );
  check("exact-exports", exportsMatch.rc === 0, exportsMatch.text);
  if (exportsMatch.rc === 0) {
    check(
      "exports-json",
      JSON.parse(readFileSync(exportsReport, "utf8")).binaries[0].exports.join(
        ",",
      ) === symbols.join(","),
    );
  }
  for (const [name, names] of [
    ["extra", [...symbols, "other_export"]],
    ["missing", symbols.slice(0, 1)],
    ["case", ["GRC_NET_MODULE_V1", symbols[1]]],
    ["duplicate", [symbols[0], symbols[0]]],
  ] as const) {
    const result = run(
      ...expectExports,
      binary(`exports-${name}.dll`, exportedPe([...names])),
    );
    check(
      `exports-${name}`,
      result.rc === 2 && result.text.includes("unexpected exports"),
      result.text,
    );
  }
  const unnamed = run(
    ...expectExports,
    binary("unnamed.dll", exportedPe(symbols, true)),
  );
  check(
    "exports-unnamed",
    unnamed.rc === 2 && unnamed.text.includes("unnamed exports"),
    unnamed.text,
  );
  const noExports = run(...expectExports, binary("no-exports.dll", pe([])));
  check(
    "exports-absent",
    noExports.rc === 2 && noExports.text.includes("unexpected exports"),
    noExports.text,
  );
  const good = binary(
    "allowed.exe",
    pe([
      "KERNEL32.dll",
      "ADVAPI32.dll",
      "WS2_32.dll",
      "bcrypt.dll",
      "ntdll.dll",
      "userenv.dll",
      "api-ms-win-crt-runtime-l1-1-0.dll",
      "api-ms-win-core-synch-l1-2-0.dll",
    ]),
  );
  const report = join(scratch, "imports.json");
  const allowed = run("--json", report, good);
  check("allowed", allowed.rc === 0, allowed.text);
  if (allowed.rc === 0) {
    const data = JSON.parse(readFileSync(report, "utf8"));
    check(
      "json-shape",
      data.schema === "render-stream-w-imports/1" &&
        data.ok === true &&
        data.allow.includes("kernel32.dll") &&
        data.binaries.length === 1 &&
        data.binaries[0].path === good &&
        data.binaries[0].imports.length === 8 &&
        data.binaries[0].delay_imports.length === 0 &&
        data.binaries[0].disallowed.length === 0,
    );
  }
  const bad = binary("dynamic.exe", pe(["KERNEL32.dll", "LIBC++.DLL"]));
  const dynamic = run("--json", report, bad);
  check(
    "dynamic-libc++",
    dynamic.rc === 1 && dynamic.text.includes("disallowed libc++.dll"),
    dynamic.text,
  );
  if (dynamic.rc === 1) {
    const data = JSON.parse(readFileSync(report, "utf8"));
    check(
      "case-normalization",
      data.ok === false &&
        data.binaries[0].imports.join(",") === "kernel32.dll,libc++.dll" &&
        data.binaries[0].disallowed.join(",") === "libc++.dll",
    );
  }
  for (const va of [false, true]) {
    const path = binary(
      `delay-${va}.exe`,
      pe(["kernel32.dll"], ["libunwind.dll"], va),
    );
    const result = run("--json", report, path);
    check(
      `delay-${va ? "va" : "rva"}`,
      result.rc === 1 && result.text.includes("disallowed libunwind.dll"),
      result.text,
    );
    if (result.rc === 1) {
      check(
        `delay-${va ? "va" : "rva"}-json`,
        JSON.parse(readFileSync(report, "utf8")).binaries[0].delay_imports.join(
          ",",
        ) === "libunwind.dll",
      );
    }
  }
  for (const dll of [
    "msvcrt.dll",
    "ucrtbase.dll",
    "psapi.dll",
    "libwinpthread-1.dll",
  ]) {
    const result = run(binary(`${dll}.exe`, pe([dll])));
    check(
      `disallow-${dll}`,
      result.rc === 1 && result.text.includes(dll),
      result.text,
    );
  }
  const nonPe = run(binary("not-pe.exe", Buffer.from("not a PE")));
  check("not-pe", nonPe.rc === 2, nonPe.text);
  const x86 = pe([]);
  x86.writeUInt16LE(0x14c, 0x84);
  const wrongMachine = run(binary("x86.exe", x86));
  check("not-x86-64", wrongMachine.rc === 2, wrongMachine.text);
  const pe32 = pe([]);
  pe32.writeUInt16LE(0x10b, 0x98);
  const wrongMagic = run(binary("pe32.exe", pe32));
  check("not-pe32+", wrongMagic.rc === 2, wrongMagic.text);
  const unmapped = pe(["kernel32.dll"]);
  unmapped.writeUInt32LE(0x9000, 0x200 + 12);
  const badRva = run(binary("unmapped.exe", unmapped));
  check("unmapped-rva", badRva.rc === 2, badRva.text);
  const truncated = run(
    binary("truncated.exe", pe(["kernel32.dll"]).subarray(0, 0x210)),
  );
  check("truncated", truncated.rc === 2, truncated.text);
  const noTerminator = pe(["kernel32.dll"]);
  noTerminator.writeUInt32LE(20, 0x98 + 116 + 8);
  const unterminated = run(binary("unterminated.exe", noTerminator));
  check("unterminated", unterminated.rc === 2, unterminated.text);
  const empty = run(binary("no-imports.exe", pe([])));
  check("no-imports", empty.rc === 0, empty.text);
  const missing = run(join(scratch, "missing.exe"));
  check("unreadable", missing.rc === 2, missing.text);
  const sabotage = run("--expect-disallowed", "LiBc++.DLL", bad);
  check(
    "sabotage-detected",
    sabotage.rc === 0 && sabotage.text.includes("sabotage detected:"),
    sabotage.text,
  );
  const missed = run("--expect-disallowed", "libc++.dll", good);
  check(
    "sabotage-not-detected",
    missed.rc === 1 && missed.text.includes("sabotage not detected:"),
    missed.text,
  );
  const subset = run("--expect-disallowed", "libc++.dll,libunwind.dll", bad);
  check("sabotage-needs-all-dlls", subset.rc === 1, subset.text);
  const every = run("--expect-disallowed", "libc++.dll", bad, good);
  check("sabotage-needs-every-binary", every.rc === 1, every.text);
  const usage = run("--expect-disallowed", "", good);
  check("usage", usage.rc === 2, usage.text);
  // A Python stub is portable and lets the checker exercise objdump disagreements.
  const dump = join(scratch, "objdump.py");
  writeFileSync(
    dump,
    '#!/usr/bin/env python3\nprint("DLL Name: KERNEL32.dll")\n',
    { mode: 0o755 },
  );
  const kernelOnly = binary("kernel.exe", pe(["kernel32.dll"]));
  const agree = run("--objdump", dump, kernelOnly);
  check("objdump-agrees", agree.rc === 0, agree.text);
  const disagree = run("--objdump", dump, bad);
  check(
    "objdump-disagrees",
    disagree.rc === 2 && disagree.text.includes("objdump disagreement"),
    disagree.text,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`self-test-w-imports: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
