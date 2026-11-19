// SafariDriver uses bounded HTTP calls and page polling; navigation must not wait for load.
export function selectSimulator(runtimes, types) {
  const runtime = runtimes.runtimes
    .filter(
      (r) =>
        r.isAvailable &&
        /^iOS \d+(?:\.\d+){1,2}$/.test(r.name) &&
        /^\d+(?:\.\d+){1,2}$/.test(r.version),
    )
    .sort((a, b) =>
      b.version.localeCompare(a.version, "en", { numeric: true }),
    )[0];
  const type = types.devicetypes.find((t) => t.name === "iPhone 13");
  if (!runtime || !type)
    throw Error("stable iOS runtime and exact iPhone 13 device type required");
  return {
    runtime: runtime.identifier,
    version: runtime.version,
    type: type.identifier,
  };
}

export function capabilities(udid) {
  return {
    capabilities: {
      alwaysMatch: {
        browserName: "safari",
        pageLoadStrategy: "none",
        ...(udid
          ? {
              platformName: "iOS",
              "safari:useSimulator": true,
              "safari:deviceUDID": udid,
            }
          : {}),
      },
    },
  };
}

export function errorDetails(error) {
  return {
    error: String(error),
    ...(error?.cause
      ? {
          cause: {
            code: error.cause.code ?? null,
            message: error.cause.message ?? String(error.cause),
            ...(error.cause.errors
              ? {
                  errors: error.cause.errors.map((e) => ({
                    code: e.code ?? null,
                    message: e.message,
                  })),
                }
              : {}),
          },
        }
      : {}),
  };
}

export async function request(
  base,
  method,
  path,
  body,
  {
    timeoutMs = 30000,
    commands = /** @type {Record<string, unknown>[]} */ ([]),
    fetchImpl = fetch,
  } = {},
) {
  const started = Date.now();
  const command = { method, path, timeoutMs, ok: false };
  try {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const document = await response.json();
    if (!response.ok || document.value?.error) {
      const error = new Error(
        `SafariDriver ${method} ${path}: ${JSON.stringify(document.value)}`,
      );
      error.webdriverError = document.value?.error;
      error.webdriverMessage = document.value?.message;
      throw error;
    }
    command.ok = true;
    return document.value;
  } catch (error) {
    Object.assign(command, errorDetails(error));
    throw error;
  } finally {
    commands.push({ ...command, elapsedMs: Date.now() - started });
  }
}

function retryableSessionError(error) {
  // A cold simulator may reject session creation while its services start.
  if (
    /remote automation is turned off|no (?:matching |usable )?(?:simulator|device|host)/i.test(
      error.webdriverMessage ?? "",
    )
  )
    return false;
  return ["session not created", "unknown error"].includes(
    error.webdriverError,
  );
}

export async function createSession(
  base,
  udid,
  {
    commands = /** @type {Record<string, unknown>[]} */ ([]),
    sessionRetryMs = 5000,
    requestImpl = request,
    sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  } = {},
) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await requestImpl(base, "POST", "/session", capabilities(udid), {
        timeoutMs: 120000,
        commands,
      });
    } catch (error) {
      if (attempt === 3 || !retryableSessionError(error)) throw error;
      await sleep(sessionRetryMs);
    }
  }
}

export async function runPage(
  base,
  url,
  udid,
  {
    timeoutMs = 600000,
    pollMs = 250,
    commands = /** @type {Record<string, unknown>[]} */ ([]),
    sessionRetryMs = 5000,
  } = {},
) {
  const session = await createSession(base, udid, { commands, sessionRetryMs });
  const send = (method, path, body) =>
    request(base, method, path, body, { commands });
  const path = `/session/${session.sessionId}`;
  let failure;
  let finalResult;
  try {
    await send("POST", `${path}/timeouts`, {
      implicit: 0,
      pageLoad: 30000,
      script: 30000,
    });
    await send("POST", `${path}/url`, { url });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await send("POST", `${path}/execute/sync`, {
        script: "return window.__rtcResult || null",
        args: [],
      });
      if (result) {
        finalResult = { ...result, capabilities: session.capabilities };
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    if (!finalResult) throw Error("Safari page result timeout");
  } catch (error) {
    failure = error;
  }
  try {
    await send("DELETE", path);
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
  return finalResult;
}
