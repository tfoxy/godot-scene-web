// Manual check for `@godot-scene-web/input/gamepad` `pads: "claim"` (IN6): open this page in two or
// more windows of one browser and watch which window reports each pad. Per window it shows the raw
// `navigator.getGamepads()` view (index, id, mapping, timestamp, pressed buttons, and how often pad
// data arrived while this window was unfocused), the capture's claims, the origin's held Web Locks
// (all windows), and every record the capture emitted. Query: `?w=<label>`, `?pads=claim|each|merge`,
// `?nonStandard=as-standard|skip` (default as-standard, so Firefox's evdev-mapped pads show up).
import {
  createGamepadCapture,
  type GamepadPadsMode,
  type GamepadRecord,
} from "../../../packages/input/src/gamepad";

const query = new URLSearchParams(location.search);
const label =
  query.get("w") ?? Math.random().toString(36).slice(2, 6).toUpperCase();
const pads = (query.get("pads") ?? "claim") as GamepadPadsMode;
const nonStandard =
  query.get("nonStandard") === "skip" ? "skip" : "as-standard";
document.title = `pads ${label}`;

const log: string[] = [];
const started = performance.now();
const stamp = () =>
  ((performance.now() - started) / 1000).toFixed(2).padStart(7);

const capture = createGamepadCapture({
  pads,
  nonStandard,
  // Real window, document and navigator.locks: this file also typechecks them against the
  // capture's structural interfaces under lib DOM (playground typecheck, tsc and tsc6).
  events: window,
  visibility: document,
  hasFocus: () => document.hasFocus(),
  locks: navigator.locks ?? null,
  sink: {
    push(record) {
      const r = record as GamepadRecord;
      const what =
        r.event === "joypad_button"
          ? `button ${r.button_index} ${r.pressed ? "down" : "up"}`
          : `axis ${r.axis} = ${r.axis_value}`;
      log.unshift(
        `${stamp()}s  device ${r.device}  ${what}   (focused=${document.hasFocus()})`,
      );
      if (log.length > 300) log.length = 300;
    },
  },
});

/** Per pad index: last timestamp seen, frames whose data changed while this window was unfocused. */
const seen = new Map<
  number,
  { timestamp: number; unfocusedUpdates: number; updates: number }
>();
let heldLocks: string[] = [];
let lockQueryError = "";

async function refreshLocks(): Promise<void> {
  if (!navigator.locks?.query) {
    lockQueryError = "navigator.locks.query unavailable";
    return;
  }
  try {
    const state = await navigator.locks.query();
    heldLocks = (state.held ?? [])
      .map(
        (lock) => `${lock.name}  (client ${String(lock.clientId).slice(0, 8)})`,
      )
      .filter((line) => line.startsWith("gsw-input/pad/"));
  } catch (error) {
    lockQueryError = String(error);
  }
}
setInterval(refreshLocks, 250);

const yesNo = (value: boolean) =>
  `<span class="${value ? "yes" : "no"}">${value ? "yes" : "no"}</span>`;
const esc = (text: string) =>
  text.replace(
    /[&<>]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c,
  );

function render(): void {
  const focused = document.hasFocus();
  const list = navigator.getGamepads ? [...navigator.getGamepads()] : [];
  const rows = list
    .filter((pad): pad is Gamepad => pad !== null)
    .map((pad) => {
      const entry = seen.get(pad.index) ?? {
        timestamp: pad.timestamp,
        unfocusedUpdates: 0,
        updates: 0,
      };
      if (pad.timestamp !== entry.timestamp) {
        entry.updates += 1;
        if (!focused) entry.unfocusedUpdates += 1;
        entry.timestamp = pad.timestamp;
      }
      seen.set(pad.index, entry);
      const pressed = pad.buttons
        .map((button, i) => (button.pressed ? i : -1))
        .filter((i) => i >= 0)
        .join(",");
      const axes = pad.axes.map((v) => v.toFixed(2)).join(" ");
      return `<tr><td>${pad.index}</td><td>${esc(pad.id)}</td><td>${pad.mapping || '""'}</td>
        <td>${pad.connected}</td><td>${pad.timestamp.toFixed(0)}</td><td>${pressed}</td><td>${axes}</td>
        <td>${entry.updates}</td><td>${entry.unfocusedUpdates}</td></tr>`;
    });
  const claims = capture
    .claims()
    .map(
      (claim) =>
        `<tr><td>${claim.slot}</td><td>${claim.index}</td><td>${esc(claim.id)}</td><td>${claim.state}</td><td>${claim.exclusive}</td></tr>`,
    );
  const mine = capture
    .claims()
    .filter((c) => c.state === "held")
    .map((c) => `pad ${c.index}`);
  const banner = document.getElementById("banner");
  if (banner) {
    banner.textContent = `window ${label}: ${mine.length ? `CLAIMED ${mine.join(", ")}` : "no claim"}`;
    banner.style.background = mine.length ? "#264" : "#333";
  }
  const app = document.getElementById("app");
  if (app)
    app.innerHTML = `
      <h1>pad claim check — window ${esc(label)}</h1>
      <div>pads mode <b>${pads}</b>, nonStandard <b>${nonStandard}</b>; focused ${yesNo(focused)};
        visibility <b>${document.visibilityState}</b>; Web Locks ${yesNo(Boolean(navigator.locks))};
        secure context ${yesNo(isSecureContext)}; polling ${yesNo(capture.polling())}</div>
      <div>${esc(navigator.userAgent)}</div>
      <h2>navigator.getGamepads() in this window</h2>
      <table><tr><th>index</th><th>id</th><th>mapping</th><th>connected</th><th>timestamp</th>
        <th>pressed buttons</th><th>axes</th><th>updates</th><th>updates while unfocused</th></tr>
        ${rows.join("") || '<tr><td colspan="9">none (press a button on the pad)</td></tr>'}</table>
      <h2>this window's claims</h2>
      <table><tr><th>slot</th><th>index</th><th>id</th><th>state</th><th>exclusive</th></tr>
        ${claims.join("") || '<tr><td colspan="5">none</td></tr>'}</table>
      <h2>gsw-input pad locks held by this origin (all windows)</h2>
      <div>${heldLocks.map(esc).join("<br>") || esc(lockQueryError) || "none"}</div>`;
  const logBox = document.getElementById("log");
  if (logBox) logBox.textContent = log.join("\n");
  requestAnimationFrame(render);
}
requestAnimationFrame(render);
void refreshLocks();
