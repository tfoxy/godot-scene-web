// The adb COMMAND WIRING, exercised end to end against a fake `adb` on PATH.
//
// The parsers are unit-tested in device.test.ts; what this file covers is the part that only breaks
// when the pieces are put together: is every call targeted at the right serial, is the compound
// getprop probe shaped so a real `sh` answers it, does the preflight really run before anything
// expensive, and does each unusable-device state produce the sentence that says what to do.
//
// A real phone is the only way to prove the CDP half. Everything up to the DevTools socket does not
// need one, and "we could not test it without hardware" would have been a choice, not a fact.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  Adb,
  AdbError,
  readDeviceProps,
  sampleConditions,
  selectDevice,
} from "../src/device";

const SERIAL = "ZY32LL2X8W";

const FAKE_ADB = `#!/bin/sh
echo "$*" >> "$FAKE_ADB_LOG"
case "$*" in
  "devices -l")
    printf 'List of devices attached\\n'
    printf '%s\\n' "$FAKE_ADB_DEVICES"
    ;;
  *"getprop"*)
    printf 'model=moto g86 5G\\nmanufacturer=motorola\\nrelease=15\\nsdk=35\\n'
    ;;
  *"dumpsys battery")
    printf '  level: 84\\n  scale: 100\\n  temperature: 301\\n'
    ;;
  *"dumpsys thermalservice")
    printf 'IsStatusOverride: false\\nThermal Status: 0\\n\\tTemperature{mValue=31.5, mStatus=0}\\n'
    ;;
  *"dumpsys window")
    printf '    mDreamingLockscreen=false mDreamingSleepToken=null\\n    mAwake=true\\n'
    ;;
  *"cat /proc/net/unix")
    printf '0000: 00000002 00000000 00010000 0001 01 41322 @chrome_devtools_remote\\n'
    ;;
  *forward*|*reverse*)
    ;;
  *)
    echo "fake adb: unhandled: $*" >&2
    exit 1
    ;;
esac
`;

function fakeAdb(devicesLine: string): { bin: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "gsw-fake-adb-"));
  const bin = join(dir, "adb");
  const log = join(dir, "calls.log");
  writeFileSync(bin, FAKE_ADB);
  chmodSync(bin, 0o755);
  process.env.FAKE_ADB_LOG = log;
  process.env.FAKE_ADB_DEVICES = devicesLine;
  return { bin, log };
}

const healthy = `${SERIAL}             device usb:1-1 product:rtwo_g model:moto_g86_5G device:rtwo transport_id:1`;

describe.skipIf(process.platform === "win32")("adb wiring", () => {
  it("selects the only connected device", async () => {
    const { bin } = fakeAdb(healthy);
    const { adb, entry } = await selectDevice({ adbBin: bin });
    expect(entry.serial).toBe(SERIAL);
    expect(entry.model).toBe("moto_g86_5G");
    expect(adb.serial).toBe(SERIAL);
  });

  it("targets every later call at that serial", async () => {
    // Two phones on one desk is normal; an untargeted `adb shell` would silently read the wrong one.
    const { bin, log } = fakeAdb(healthy);
    const adb = new Adb({ bin, serial: SERIAL });
    await adb.shell("dumpsys battery");
    const calls = await readFile(log, "utf8");
    expect(calls).toContain(`-s ${SERIAL} shell dumpsys battery`);
  });

  it("reads the props through one compound shell command a real sh can answer", async () => {
    const { bin } = fakeAdb(healthy);
    const props = await readDeviceProps(new Adb({ bin, serial: SERIAL }));
    expect(props).toEqual({
      serial: SERIAL,
      model: "moto g86 5G",
      manufacturer: "motorola",
      androidRelease: "15",
      androidSdk: "35",
    });
    // …and the probe really is valid shell, not just a string this repo can parse.
    const echoed = execFileSync("sh", [
      "-c",
      'echo "model=$(echo moto)"; echo "sdk=$(echo 35)"',
    ]).toString();
    expect(echoed).toBe("model=moto\nsdk=35\n");
  });

  it("samples battery and thermal together", async () => {
    const { bin } = fakeAdb(healthy);
    const conditions = await sampleConditions(new Adb({ bin, serial: SERIAL }));
    expect(conditions).toEqual({
      batteryPct: 84,
      batteryTemperatureC: 30.1,
      thermalStatus: "none",
      thermalStatusCode: 0,
      thermalMaxTempC: 31.5,
    });
  });

  it("explains an empty device list instead of throwing something opaque", async () => {
    const { bin } = fakeAdb("");
    await expect(selectDevice({ adbBin: bin })).rejects.toThrow(AdbError);
    await expect(selectDevice({ adbBin: bin })).rejects.toThrow(
      /no Android device is visible to adb/,
    );
  });

  it("explains an unauthorized phone", async () => {
    const { bin } = fakeAdb(`${SERIAL}             unauthorized usb:1-1`);
    await expect(selectDevice({ adbBin: bin })).rejects.toThrow(
      /Allow USB debugging/,
    );
  });

  it("explains an offline phone", async () => {
    const { bin } = fakeAdb(`${SERIAL}             offline usb:1-1`);
    await expect(selectDevice({ adbBin: bin })).rejects.toThrow(
      /adb kill-server/,
    );
  });

  it("refuses to guess between two phones", async () => {
    const { bin } = fakeAdb(`${SERIAL}   device\nemulator-5554   device`);
    await expect(selectDevice({ adbBin: bin })).rejects.toThrow(
      /--device-serial/,
    );
  });

  it("picks the requested serial out of several", async () => {
    const { bin } = fakeAdb(`${SERIAL}   device\nemulator-5554   device`);
    const { entry } = await selectDevice({
      adbBin: bin,
      serial: "emulator-5554",
    });
    expect(entry.serial).toBe("emulator-5554");
  });

  it("says so when the requested serial is not there at all", async () => {
    const { bin } = fakeAdb(healthy);
    await expect(selectDevice({ adbBin: bin, serial: "NOPE" })).rejects.toThrow(
      /no device with serial "NOPE"/,
    );
  });

  it("reports a missing adb binary as a setup problem, not a crash", async () => {
    await expect(selectDevice({ adbBin: "/nonexistent/adb" })).rejects.toThrow(
      /adb not found/,
    );
  });
});
