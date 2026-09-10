// Driver-attributed VRAM: the PURE half of nvidia.ts.
//
// The fixtures are real output, trimmed. `NVIDIA_SMI` is `nvidia-smi -q -x` on this box (RTX 2060,
// driver 595.71.05) with the process list cut down and the paths shortened; the shape — including
// `<fb_memory_usage><used>` sitting above a `<processes>` block, and a second, FOREIGN Chromium's
// `--type=gpu-process` in it — is exactly what the parser has to survive.
//
// The readers that shell out (`readNvidiaProcesses`, `readProcessTable`, `sampleChromeVram`) are
// UNTESTED SURFACE by design: they are `execFile` and two `/proc` reads, and a test of them tests
// node. Everything that decides what number gets published is here.

import { describe, expect, it } from "vitest";
import {
  findDescendantGpuPids,
  isNvidiaGpu,
  parseNvidiaMemoryBytes,
  parseNvidiaProcesses,
  parseProcStat,
} from "../src/nvidia";

const NVIDIA_SMI = `<?xml version="1.0" ?>
<!DOCTYPE nvidia_smi_log SYSTEM "nvsmi_device_v13.dtd">
<nvidia_smi_log>
	<driver_version>595.71.05</driver_version>
	<gpu id="00000000:01:00.0">
		<product_name>NVIDIA GeForce RTX 2060</product_name>
		<fb_memory_usage>
			<total>12288 MiB</total>
			<reserved>464 MiB</reserved>
			<used>981 MiB</used>
			<free>10844 MiB</free>
		</fb_memory_usage>
		<bar1_memory_usage>
			<total>256 MiB</total>
			<used>21 MiB</used>
			<free>235 MiB</free>
		</bar1_memory_usage>
		<processes>
			<process_info>
				<gpu_instance_id>N/A</gpu_instance_id>
				<pid>2705</pid>
				<type>G</type>
				<process_name>/usr/bin/gnome-shell</process_name>
				<used_memory>170 MiB</used_memory>
			</process_info>
			<process_info>
				<pid>4386</pid>
				<type>G</type>
				<process_name>/usr/share/code/code</process_name>
				<used_memory>222 MiB</used_memory>
			</process_info>
			<process_info>
				<pid>11616</pid>
				<type>C+G</type>
				<process_name>/snap/chromium/3507/usr/lib/chromium-browser/chrome --type=gpu-process --ozone-platform=wayland --gpu-preferences=YAAAAA</process_name>
				<used_memory>235 MiB</used_memory>
			</process_info>
			<process_info>
				<pid>15246</pid>
				<type>G</type>
				<process_name>/usr/bin/nautilus</process_name>
				<used_memory>N/A</used_memory>
			</process_info>
		</processes>
	</gpu>
</nvidia_smi_log>
`;

describe("nvidia-smi -q -x", () => {
  it("parses every process_info under <gpu><processes>", () => {
    const processes = parseNvidiaProcesses(NVIDIA_SMI);
    expect(processes.map((p) => p.pid)).toEqual([2705, 4386, 11616, 15246]);
    expect(processes[2]).toMatchObject({
      pid: 11616,
      type: "C+G",
      usedMemoryBytes: 235 * 1024 * 1024,
    });
  });

  it("NEVER reports the box-wide fb_memory_usage as a process figure", () => {
    // 981 MiB is this whole card: gnome-shell, VS Code, sunshine, the developer's own Chromium. It is
    // the number this module exists NOT to publish, and the only structural guard is that nothing
    // outside <processes> is ever read.
    const boxWide = 981 * 1024 * 1024;
    for (const process of parseNvidiaProcesses(NVIDIA_SMI)) {
      expect(process.usedMemoryBytes).not.toBe(boxWide);
    }
  });

  it("normalises used_memory to bytes, and reads N/A as NOT MEASURED", () => {
    expect(parseNvidiaMemoryBytes("235 MiB")).toBe(246_415_360);
    expect(parseNvidiaMemoryBytes("1 GiB")).toBe(1_073_741_824);
    expect(parseNvidiaMemoryBytes("4096")).toBe(4096);
    // Never 0: a driver that will not say is not a driver saying zero.
    expect(parseNvidiaMemoryBytes("N/A")).toBeNull();
    expect(parseNvidiaMemoryBytes("")).toBeNull();
    expect(parseNvidiaMemoryBytes(null)).toBeNull();
    expect(
      parseNvidiaProcesses(NVIDIA_SMI).find((p) => p.pid === 15246)
        ?.usedMemoryBytes,
    ).toBeNull();
  });

  it("returns an empty list, not a throw, for output with no <processes>", () => {
    expect(parseNvidiaProcesses("")).toEqual([]);
    expect(
      parseNvidiaProcesses("<nvidia_smi_log><gpu/></nvidia_smi_log>"),
    ).toEqual([]);
  });
});

/**
 * A `/proc` snapshot of the situation this attribution exists for: OUR chrome (pid 1000) with its
 * GPU process behind a ZYGOTE, and ANOTHER Chromium (pid 900) with an identical-looking one.
 */
const TABLE = [
  { pid: 1, ppid: 0, cmdline: "/sbin/init " },
  // The developer's own browser. Same binary family, same flag, 235 MiB of somebody else's textures.
  { pid: 900, ppid: 1, cmdline: "/snap/chromium/3507/.../chrome " },
  {
    pid: 901,
    ppid: 900,
    cmdline:
      "/snap/chromium/3507/.../chrome --type=gpu-process --ozone-platform=wayland ",
  },
  // The Chrome this harness launched.
  {
    pid: 1000,
    ppid: 500,
    cmdline: "/opt/chrome --remote-debugging-port=0 --no-sandbox ",
  },
  { pid: 1001, ppid: 1000, cmdline: "/opt/chrome --type=zygote " },
  {
    pid: 1002,
    ppid: 1001,
    cmdline:
      "/opt/chrome --type=gpu-process --gpu-preferences=UAAAAA --shared-files ",
  },
  {
    pid: 1003,
    ppid: 1001,
    cmdline: "/opt/chrome --type=renderer --lang=en-US ",
  },
];

describe("attribution: the GPU process of the chrome WE launched", () => {
  it("finds it through the zygote, i.e. transitively", () => {
    // Chrome forks sandboxed children off a zygote, so the GPU process's PARENT is pid 1001 and the
    // browser is its grandparent. A one-level walk finds nothing here.
    expect(findDescendantGpuPids(TABLE, 1000)).toEqual([1002]);
  });

  it("does NOT pick up another browser's gpu-process", () => {
    // The whole point. pid 901 carries the same `--type=gpu-process` and is in the same nvidia-smi
    // list; matching on the flag alone would publish the developer's browser as this run's cost.
    expect(findDescendantGpuPids(TABLE, 1000)).not.toContain(901);
    expect(findDescendantGpuPids(TABLE, 900)).toEqual([901]);
  });

  it("returns an EMPTY list when the launched chrome has no gpu process", () => {
    // Empty, so the caller can report NOT MEASURED. There is no pid to fall back to, and a 0 here
    // would read as "the GPU work was free".
    expect(findDescendantGpuPids(TABLE, 1003)).toEqual([]);
    expect(findDescendantGpuPids(TABLE, 424_242)).toEqual([]);
  });

  it("sums a crashed-and-relaunched pair rather than dropping one", () => {
    const restarted = [
      ...TABLE,
      {
        pid: 1004,
        ppid: 1001,
        cmdline: "/opt/chrome --type=gpu-process --shared-files ",
      },
    ];
    expect(findDescendantGpuPids(restarted, 1000)).toEqual([1002, 1004]);
  });

  it("terminates on a cyclic parent map", () => {
    const cyclic = [
      { pid: 10, ppid: 11, cmdline: "a " },
      { pid: 11, ppid: 10, cmdline: "b --type=gpu-process " },
    ];
    expect(findDescendantGpuPids(cyclic, 10)).toEqual([11]);
  });
});

describe("/proc/<pid>/stat", () => {
  it("reads ppid AFTER the comm field, which may contain spaces and parens", () => {
    // The trap: splitting on whitespace makes field 4 the pgrp for any process whose comm has a
    // space in it — and it reads as "this process has no parent", not as a parse error.
    expect(parseProcStat("1002 (chrome) S 1001 900 900 0 -1 4194560")).toEqual({
      pid: 1002,
      ppid: 1001,
    });
    expect(
      parseProcStat("1010 (Chrome_ChildIOT (2)) S 1001 900 900 0 -1 4194560"),
    ).toEqual({ pid: 1010, ppid: 1001 });
  });

  it("returns null for a line it cannot read", () => {
    expect(parseProcStat("")).toBeNull();
    expect(parseProcStat("1002 (chrome)")).toBeNull();
  });
});

describe("the gate: does this environment have an NVIDIA GPU at all", () => {
  it("opens on the renderer string Chrome reports for this box headed", () => {
    expect(
      isNvidiaGpu({
        hardware: "NVIDIA GeForce RTX 2060/PCIe/SSE2 (ANGLE)",
        hardwareDetail:
          "ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 2060/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 595.71.05)",
      }),
    ).toBe(true);
  });

  it("stays SHUT on SwiftShader and on the phone", () => {
    // A headless SwiftShader run has no GPU context: nvidia-smi would list no chrome process, and the
    // subprocess per bracket would buy nothing. The phone's driver figure comes from dumpsys instead.
    expect(
      isNvidiaGpu({ hardware: "swiftshader", hardwareDetail: "SwiftShader" }),
    ).toBe(false);
    expect(
      isNvidiaGpu({
        hardware: "Mali-G615 MC2 (ANGLE)",
        hardwareDetail: "ANGLE (ARM, Mali-G615 MC2, OpenGL ES 3.2)",
      }),
    ).toBe(false);
    expect(isNvidiaGpu({ hardware: "unknown", hardwareDetail: "" })).toBe(
      false,
    );
  });
});
