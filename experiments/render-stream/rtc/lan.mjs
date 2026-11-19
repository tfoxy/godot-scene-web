import { execFileSync } from "node:child_process";
import { networkInterfaces, platform } from "node:os";
import { pathToFileURL } from "node:url";

export function selectLan(interfaces, preferred) {
  const candidates = Object.entries(interfaces).flatMap(([name, addresses]) =>
    (addresses ?? [])
      .filter(
        (a) =>
          a.family === "IPv4" &&
          !a.internal &&
          !/^(0|127|22[4-9]|23\d)\./.test(a.address),
      )
      .map((a) => ({ ip: a.address, interface: name })),
  );
  const selected = candidates.find((a) => a.ip === preferred) ?? candidates[0];
  if (!selected) throw Error("no non-loopback unicast IPv4 interface");
  return {
    ...selected,
    source:
      selected.ip === preferred
        ? "ipconfig getifaddr en0"
        : "networkInterfaces",
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let preferred;
  if (platform() === "darwin") {
    try {
      preferred = execFileSync("ipconfig", ["getifaddr", "en0"], {
        encoding: "utf8",
      }).trim();
    } catch {
      /* Other interfaces are valid on hosted runners. */
    }
  }
  console.log(JSON.stringify(selectLan(networkInterfaces(), preferred)));
}
