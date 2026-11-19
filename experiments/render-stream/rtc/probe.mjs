import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { createInterface } from "node:readline";

export const probeBinary = new URL(
  "../rs-net/target/release/rs-net-rtc-probe",
  import.meta.url,
);
export async function startProbe(ip, certDir, log, port = 45000) {
  const output = createWriteStream(log);
  const child = spawn(
    probeBinary.pathname,
    ["--bind", `${ip}:${port}`, "--cert-dir", certDir],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  child.stderr.pipe(output);
  const lines = createInterface({ input: child.stdout });
  const exit = once(child, "exit");
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    await exit;
    lines.close();
    output.end();
  };
  try {
    const discovery = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(Error("probe startup timeout"));
      }, 15000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(Error(`probe exited ${code}/${signal}; see ${log}`));
      });
      lines.once("line", (line) => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(line));
        } catch (error) {
          reject(error);
        }
      });
    });
    return { child, discovery, stop };
  } catch (error) {
    await stop();
    if (stderr.includes("Address already in use") && port < 45100)
      return startProbe(ip, certDir, log, port + 1);
    throw error;
  }
}
