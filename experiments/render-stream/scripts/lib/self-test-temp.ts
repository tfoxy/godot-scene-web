import { mkdtempSync, rmSync } from "node:fs";
import { constants } from "node:os";

const roots = new Set<string>();
let handlersInstalled = false;

/** Retain self-test evidence when explicitly requested for debugging. */
export function keepSelfTestTempDirs(): boolean {
  return process.env.RS_SELF_TEST_KEEP_TMP === "1";
}

/** Create and register a temporary root before returning control to the event loop. */
export function makeSelfTestTempDir(prefix: string): string {
  if (!handlersInstalled) {
    handlersInstalled = true;
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.once(signal, () => {
        for (const root of roots) {
          try {
            removeSelfTestTempDir(root);
          } catch (error) {
            console.error(
              `Failed to remove self-test temp directory ${root}:`,
              error,
            );
          }
        }
        process.exit(128 + constants.signals[signal]);
      });
    }
  }
  const root = mkdtempSync(prefix);
  roots.add(root);
  if (keepSelfTestTempDirs()) {
    console.error(`RS_SELF_TEST_KEEP_TMP=1: keeping ${root}`);
  }
  return root;
}

/** Remove a root (or a scenario directory), respecting the debugging override. */
export function removeSelfTestTempDir(root: string): void {
  if (!keepSelfTestTempDirs()) rmSync(root, { recursive: true, force: true });
  roots.delete(root);
}
