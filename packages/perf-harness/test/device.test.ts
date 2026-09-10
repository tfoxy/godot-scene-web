// The device path's parsers and its "what is wrong with the phone" logic, tested without a phone.
//
// Everything here is a pure function over real `adb` / `dumpsys` output on purpose: the parts of a
// device runner that are easy to get quietly wrong are the parsing and the diagnosis, and those must
// not need hardware to test. The fixtures are verbatim output shapes, not invented ones.

import { describe, expect, it } from "vitest";
import {
  conditionWarnings,
  type DeviceConditions,
  deviceEnvLabel,
  parseAdbDevices,
  parseBattery,
  parseDevtoolsSockets,
  parseKeyValueLines,
  parseLockState,
  parseThermal,
} from "../src/device";

describe("parseAdbDevices", () => {
  it("reads a healthy `adb devices -l` listing", () => {
    const entries = parseAdbDevices(
      [
        "List of devices attached",
        "ZY32LL2X8W             device usb:1-1 product:rtwo_g model:moto_g86_5G device:rtwo transport_id:1",
        "",
      ].join("\n"),
    );
    expect(entries).toEqual([
      {
        serial: "ZY32LL2X8W",
        state: "device",
        model: "moto_g86_5G",
        product: "rtwo_g",
      },
    ]);
  });

  it("is empty when no device is attached", () => {
    // The state this workstream actually started in. It must parse to nothing, not to garbage.
    expect(parseAdbDevices("List of devices attached\n\n")).toEqual([]);
  });

  it("keeps the state of a device that is present but not usable", () => {
    const entries = parseAdbDevices(
      [
        "List of devices attached",
        "ZY32LL2X8W             unauthorized usb:1-1 transport_id:3",
        "emulator-5554          offline",
        "0123456789ABCDEF       no permissions (user in plugdev group; are your udev rules wrong?)",
      ].join("\n"),
    );
    expect(entries.map((entry) => entry.state)).toEqual([
      "unauthorized",
      "offline",
      "no permissions",
    ]);
  });

  it("ignores the daemon chatter adb prints on first run", () => {
    const entries = parseAdbDevices(
      [
        "* daemon not running; starting now at tcp:5037",
        "* daemon started successfully",
        "List of devices attached",
        "ZY32LL2X8W             device",
      ].join("\n"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].serial).toBe("ZY32LL2X8W");
  });
});

describe("parseBattery", () => {
  it("reads level and temperature (tenths of a degree)", () => {
    const sample = parseBattery(
      [
        "Current Battery Service state:",
        "  AC powered: false",
        "  USB powered: true",
        "  status: 2",
        "  health: 2",
        "  level: 84",
        "  scale: 100",
        "  temperature: 351",
        "  technology: Li-ion",
      ].join("\n"),
    );
    expect(sample).toEqual({ pct: 84, temperatureC: 35.1 });
  });

  it("reports null rather than 0 when dumpsys said nothing", () => {
    // 0% battery and "not measured" are very different claims about a baseline.
    expect(parseBattery("")).toEqual({ pct: null, temperatureC: null });
  });
});

describe("parseThermal", () => {
  it("prefers the headline Thermal Status", () => {
    const sample = parseThermal(
      [
        "IsStatusOverride: false",
        "ThermalEventListeners:",
        "\tcallbacks: 2",
        "Thermal Status: 0",
        "Cached temperatures:",
        "\tTemperature{mValue=31.9, mType=3, mName=skin, mStatus=0}",
      ].join("\n"),
    );
    expect(sample).toEqual({ status: "none", code: 0, maxTempC: 31.9 });
  });

  it("names a throttled status", () => {
    const sample = parseThermal("Thermal Status: 2\nmValue=44.0");
    expect(sample.status).toBe("moderate");
    expect(sample.code).toBe(2);
  });

  it("falls back to the WORST per-sensor status when there is no headline", () => {
    // Under-reading throttling is the failure that silently invalidates a baseline, so the fallback
    // takes the max, never the first.
    const sample = parseThermal(
      [
        "Current temperatures from HAL:",
        "\tTemperature{mValue=41.0, mType=3, mName=skin, mStatus=1}",
        "\tTemperature{mValue=52.0, mType=0, mName=cpu, mStatus=3}",
      ].join("\n"),
    );
    expect(sample.code).toBe(3);
    expect(sample.status).toBe("severe");
    expect(sample.maxTempC).toBe(52);
  });

  it("reports null when thermalservice said nothing", () => {
    expect(parseThermal("")).toEqual({
      status: null,
      code: null,
      maxTempC: null,
    });
  });
});

describe("parseLockState", () => {
  it("detects the lockscreen", () => {
    const state = parseLockState(
      "    mDreamingLockscreen=true mDreamingSleepToken=null\n    mAwake=true",
    );
    expect(state.dreamingLockscreen).toBe(true);
    expect(state.awake).toBe(true);
    expect(state.raw).toContain("mDreamingLockscreen=true");
  });

  it("detects an unlocked, awake phone", () => {
    const state = parseLockState(
      "    mDreamingLockscreen=false mDreamingSleepToken=null\n    mAwake=true",
    );
    expect(state.dreamingLockscreen).toBe(false);
  });

  it("is null (unknown), not false, when the dump did not say", () => {
    expect(parseLockState("").dreamingLockscreen).toBeNull();
  });
});

describe("parseDevtoolsSockets", () => {
  it("finds the abstract socket and prefers stock Chrome", () => {
    const sockets = parseDevtoolsSockets(
      [
        "Num       RefCount Protocol Flags    Type St Inode Path",
        "0000000000000000: 00000002 00000000 00010000 0001 01 41321 @webview_devtools_remote_2841",
        "0000000000000000: 00000002 00000000 00010000 0001 01 41322 @chrome_devtools_remote",
        "0000000000000000: 00000003 00000000 00000000 0001 03 41323 /dev/socket/logdw",
      ].join("\n"),
    );
    expect(sockets[0]).toBe("chrome_devtools_remote");
    expect(sockets).toContain("webview_devtools_remote_2841");
  });

  it("is empty when Chrome is not running", () => {
    expect(parseDevtoolsSockets("@logdw\n@traced")).toEqual([]);
  });
});

describe("parseKeyValueLines", () => {
  it("reads the getprop probe output", () => {
    expect(
      parseKeyValueLines("model=moto g86 5G\nrelease=15\nsdk=35\n"),
    ).toEqual({
      model: "moto g86 5G",
      release: "15",
      sdk: "35",
    });
  });
});

function conditions(
  overrides: Partial<DeviceConditions> = {},
): DeviceConditions {
  return {
    batteryPct: 84,
    batteryTemperatureC: 30,
    thermalStatus: "none",
    thermalStatusCode: 0,
    thermalMaxTempC: 31,
    ...overrides,
  };
}

describe("conditionWarnings", () => {
  it("says nothing about a cold, charged phone", () => {
    expect(conditionWarnings(conditions(), conditions())).toEqual([]);
  });

  it("flags a phone that was ALREADY throttled before the run", () => {
    const warnings = conditionWarnings(
      conditions({ thermalStatus: "moderate", thermalStatusCode: 2 }),
      conditions({ thermalStatus: "moderate", thermalStatusCode: 2 }),
    );
    expect(warnings.join(" ")).toContain("ALREADY thermally throttled");
  });

  it("flags thermal status RISING during the run", () => {
    // The exact failure the before/after sampling exists to catch: clean before, throttled after,
    // and medians that just look like "the phone is slow".
    const warnings = conditionWarnings(
      conditions(),
      conditions({ thermalStatus: "light", thermalStatusCode: 1 }),
    );
    expect(warnings.join(" ")).toContain("ROSE during the run");
  });

  it("flags a battery that heated up", () => {
    const warnings = conditionWarnings(
      conditions({ batteryTemperatureC: 29 }),
      conditions({ batteryTemperatureC: 34.5 }),
    );
    expect(warnings.join(" ")).toContain("battery temperature rose");
  });

  it("flags a nearly flat battery, which brings its own CPU limits", () => {
    const warnings = conditionWarnings(
      conditions({ batteryPct: 21 }),
      conditions({ batteryPct: 14 }),
    );
    expect(warnings.join(" ")).toContain("14%");
  });
});

describe("deviceEnvLabel", () => {
  it("names the environment after the phone and its Chrome", () => {
    expect(
      deviceEnvLabel(
        {
          serial: "ZY32LL2X8W",
          model: "moto g86 5G",
          manufacturer: "motorola",
          androidRelease: "15",
          androidSdk: "35",
        },
        "Chrome/152.0.7300.60",
      ),
    ).toBe("android15-moto-g86-5g-chrome-152");
  });
});
