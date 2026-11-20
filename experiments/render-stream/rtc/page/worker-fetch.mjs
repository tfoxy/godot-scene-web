function deadline(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(Error(`${label} timeout (${ms} ms)`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function waitForControl(scriptURL, timeoutMs) {
  const container = navigator.serviceWorker;
  let changed;
  const controlled = () => container.controller?.scriptURL === scriptURL;
  const ready = new Promise((resolve) => {
    changed = () => {
      if (controlled()) resolve();
    };
    container.addEventListener("controllerchange", changed);
    changed();
  });
  return deadline(ready, timeoutMs, "service worker control").finally(() =>
    container.removeEventListener("controllerchange", changed),
  );
}

// This function is serialized into a Blob; it deliberately has no module dependencies.
function workerMain() {
  self.onmessage = async ({ data }) => {
    const results = await Promise.all(
      data.map(async ({ kind, url, marker }) => {
        try {
          const response = await fetch(url, { cache: "no-store" });
          const text = await response.text();
          return {
            kind,
            url,
            intercepted: response.ok && text === marker,
            status: response.status,
            text,
            error: null,
          };
        } catch (error) {
          return { kind, url, intercepted: false, error: String(error) };
        }
      }),
    );
    self.postMessage(results);
  };
}

/** Record capability outcomes, including false, without making browser differences a failed RTC leg. */
export async function probeWorkerFetch(timeoutMs = 10000) {
  const result = {
    controlled: false,
    workerFetchIntercepted: false,
    baseURI: document.baseURI,
    fetches: [],
    error: null,
  };
  let registration;
  let worker;
  let blobURL;
  try {
    if (!navigator.serviceWorker) throw Error("service workers unavailable");
    const scriptURL = new URL("/rtc-worker-sw.js", location.href).href;
    registration = await deadline(
      navigator.serviceWorker.register(scriptURL, { scope: "/" }),
      timeoutMs,
      "service worker registration",
    );
    // The new worker activates and claims the first page; no navigation/reload is needed.
    await waitForControl(scriptURL, timeoutMs);
    result.controlled = true;
    const token = crypto.randomUUID();
    const marker = `rtc-worker:${token}`;
    const absolute = new URL("/~h/absolute", location.origin);
    const relative = new URL("~h/relative", document.baseURI);
    for (const url of [absolute, relative])
      url.searchParams.set("token", token);
    const requests = [
      { kind: "absolute", url: absolute.href, marker },
      { kind: "document-baseURI", url: relative.href, marker },
    ];
    blobURL = URL.createObjectURL(
      new Blob([`(${workerMain.toString()})()`], { type: "text/javascript" }),
    );
    worker = new Worker(blobURL);
    const completed = new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => resolve(data);
      worker.onerror = (event) => {
        event.preventDefault();
        reject(Error(event.message || "Blob worker failed"));
      };
    });
    worker.postMessage(requests);
    result.fetches = await deadline(completed, timeoutMs, "Blob worker fetch");
    result.workerFetchIntercepted =
      result.fetches.length === 2 &&
      result.fetches.every((fetch) => fetch.intercepted);
  } catch (error) {
    result.error = String(error);
  } finally {
    worker?.terminate();
    if (blobURL) URL.revokeObjectURL(blobURL);
    await registration?.unregister().catch(() => {});
  }
  return result;
}
