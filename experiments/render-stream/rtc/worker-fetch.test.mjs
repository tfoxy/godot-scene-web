import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createContext, SourceTextModule } from "node:vm";

const source = await readFile(
  new URL("./page/worker-fetch.mjs", import.meta.url),
  "utf8",
);
async function probe({
  control = true,
  intercepted = true,
  registrationError,
} = {}) {
  const events = [];
  const container = new EventTarget();
  container.register = async (scriptURL) => {
    if (registrationError) throw Error(registrationError);
    if (control)
      setTimeout(() => {
        container.controller = { scriptURL };
        container.dispatchEvent(new Event("controllerchange"));
      }, 1);
    return {
      async unregister() {
        events.push("unregister");
      },
    };
  };
  const context = createContext({
    navigator: { serviceWorker: container },
    document: { baseURI: "http://127.0.0.1:8080/" },
    location: new URL("http://127.0.0.1:8080/?h=example"),
    URL: class extends URL {
      static createObjectURL(blob) {
        events.push(blob);
        return "blob:http://127.0.0.1:8080/token";
      }
      static revokeObjectURL(url) {
        events.push(`revoke ${url}`);
      }
    },
    Blob,
    crypto,
    setTimeout,
    clearTimeout,
    Promise,
    Worker: class {
      constructor(url) {
        assert.match(url, /^blob:/);
      }
      postMessage(requests) {
        assert.ok(
          container.controller,
          "first load must be controlled before worker fetch",
        );
        events.push(...requests.map((request) => ({ ...request })));
        this.onmessage({
          data: requests.map(({ kind, url }) => ({
            kind,
            url,
            intercepted,
            error: intercepted ? null : "fetch failed",
          })),
        });
      }
      terminate() {
        events.push("terminate");
      }
    },
  });
  const module = new SourceTextModule(source, { context });
  await module.link(() => {
    throw Error("unexpected import");
  });
  await module.evaluate();
  return { result: await module.namespace.probeWorkerFetch(25), events };
}

test("first-load control precedes Blob worker fetch of absolute and document.baseURI URLs", async () => {
  const { result, events } = await probe();
  assert.equal(result.controlled, true);
  assert.equal(result.workerFetchIntercepted, true);
  const requests = events.filter((event) => event?.kind);
  assert.deepEqual(
    requests.map((request) => request.kind),
    ["absolute", "document-baseURI"],
  );
  for (const request of requests) {
    const url = new URL(request.url);
    assert.equal(url.origin, "http://127.0.0.1:8080");
    assert.ok(url.pathname.startsWith("/~h/"));
    assert.equal(request.marker, `rtc-worker:${url.searchParams.get("token")}`);
  }
  assert.ok(events.some((event) => event instanceof Blob));
  assert.ok(events.includes("terminate"));
  assert.ok(events.includes("unregister"));
  assert.ok(
    events.some(
      (event) => typeof event === "string" && event.startsWith("revoke blob:"),
    ),
  );
});

test("unintercepted worker fetch is a false result with its error retained", async () => {
  const { result } = await probe({ intercepted: false });
  assert.equal(result.controlled, true);
  assert.equal(result.workerFetchIntercepted, false);
  assert.equal(result.fetches.length, 2);
  assert.equal(result.fetches[0].error, "fetch failed");
});

test("missing controller is bounded and never starts the Blob worker", async () => {
  const { result, events } = await probe({ control: false });
  assert.equal(result.controlled, false);
  assert.equal(result.workerFetchIntercepted, false);
  assert.match(result.error, /service worker control timeout/);
  assert.deepEqual(events, ["unregister"]);
});

test("registration failure is recorded as a capability outcome", async () => {
  const { result } = await probe({ registrationError: "registration failed" });
  assert.equal(result.controlled, false);
  assert.equal(result.workerFetchIntercepted, false);
  assert.match(result.error, /registration failed/);
});
