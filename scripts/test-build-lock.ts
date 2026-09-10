import { createHash } from "node:crypto";
import { type FileHandle, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workspaceKey = createHash("sha256")
  .update(process.cwd())
  .digest("hex")
  .slice(0, 16);
const LOCK_PATH = join(tmpdir(), `gsw-core-parser-build-${workspaceKey}.lock`);
const RETRY_MS = 25;
const TIMEOUT_MS = 120_000;

/**
 * Serialize the two package-consumer tests that both clean and rebuild core/parser dist.
 * Their package commands mutate one shared workspace output, so parallel Vitest workers can
 * otherwise pack a parser while the other test has just removed its dist directory.
 */
export async function withCoreParserBuildLock<T>(
  task: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  let handle: FileHandle | undefined;
  while (!handle) {
    try {
      handle = await open(LOCK_PATH, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline)
        throw new Error(`Timed out waiting for ${LOCK_PATH}.`);
      await new Promise<void>((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }
  try {
    return await task();
  } finally {
    await handle.close();
    await rm(LOCK_PATH, { force: true });
  }
}
