// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://github.com/"}

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({ requests: [] as string[] }));
vi.mock("@solidtime/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solidtime/api")>();
  return {
    ...actual,
    createApiClient: (...args: Parameters<typeof actual.createApiClient>) => {
      const client = actual.createApiClient(...args);
      client.axios.defaults.adapter = async (config) => {
        server.requests.push(config.baseURL!);
        if (config.baseURL !== "https://self-hosted.example/api") {
          throw { config, response: { status: 401 } };
        }
        return { config, status: 200, statusText: "OK", headers: {}, data: { data: null } };
      };
      return client;
    },
  };
});

let stored: Record<string, unknown>;
let listeners: ((changes: Record<string, { newValue?: unknown }>, area: string) => void)[];
const sendMessage = vi.fn();

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  server.requests.length = 0;
  stored = {
    instance_endpoint: "https://self-hosted.example",
    instance_client_id: "self-hosted-client",
    access_token: "test-access-token",
    refresh_token: "test-refresh-token",
  };
  listeners = [];
  sendMessage.mockReset().mockResolvedValue({ success: false, error: "Refresh rejected by wrong instance" });
  vi.stubGlobal("browser", {
    storage: {
      local: {
        get: vi.fn(async () => ({ ...stored })),
        set: vi.fn(async (values) => {
          Object.assign(stored, values);
          listeners.forEach((listener) => listener(
            Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }])),
            "local",
          ));
        }),
        remove: vi.fn(async (keys: string[]) => {
          keys.forEach((key) => delete stored[key]);
          listeners.forEach((listener) => listener(
            Object.fromEntries(keys.map((key) => [key, {}])), "local",
          ));
        }),
      },
      onChanged: { addListener: (listener: typeof listeners[number]) => listeners.push(listener) },
    },
    runtime: { sendMessage },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("keeps a self-hosted login when a content script checks the active timer", async () => {
  const auth = await import("../entrypoints/utils/oauth");
  const { getCurrentTimeEntry } = await import("../entrypoints/utils/timeEntries");
  await vi.waitFor(() => expect(auth.isLoggedIn.value).toBe(true));

  await getCurrentTimeEntry().catch(() => {});

  expect({ requests: server.requests, loggedIn: auth.isLoggedIn.value }).toEqual({
    requests: ["https://self-hosted.example/api"], loggedIn: true,
  });
  expect(stored.access_token).toBe("test-access-token");
});

it("does not read instance settings from the host website", async () => {
  localStorage.setItem("instance_endpoint", "https://untrusted.example");
  localStorage.setItem("instance_client_id", "untrusted-client");
  const auth = await import("../entrypoints/utils/oauth");
  const { apiClient } = await import("../entrypoints/utils/api");
  await apiClient().getMe();

  expect(server.requests).toEqual(["https://self-hosted.example/api"]);
  expect(auth.clientId.value).toBe("self-hosted-client");
  expect(localStorage.getItem("instance_endpoint")).toBe("https://untrusted.example");
});

it("waits for stored settings before sending the first API request", async () => {
  const snapshot = { ...stored };
  let finishLoading!: (value: typeof snapshot) => void;
  vi.mocked(browser.storage.local.get).mockImplementationOnce(
    () => new Promise((resolve) => { finishLoading = resolve; }),
  );
  const { apiClient } = await import("../entrypoints/utils/api");
  const request = apiClient().getMe();
  await Promise.resolve();
  expect(server.requests).toEqual([]);
  finishLoading(snapshot);
  await request;

  expect(server.requests).toEqual(["https://self-hosted.example/api"]);
});

it("migrates existing popup settings without losing the login", async () => {
  delete stored.instance_endpoint;
  delete stored.instance_client_id;
  vi.spyOn(window.location, "protocol", "get").mockReturnValue("chrome-extension:");
  localStorage.setItem("instance_endpoint", "https://self-hosted.example");
  localStorage.setItem("instance_client_id", "self-hosted-client");
  const auth = await import("../entrypoints/utils/oauth");
  await auth.authReady;

  expect(stored).toMatchObject({
    instance_endpoint: "https://self-hosted.example",
    instance_client_id: "self-hosted-client",
    access_token: "test-access-token",
  });
  expect(auth.isLoggedIn.value).toBe(true);
});

it("holds existing tokens until popup migration reaches the content script", async () => {
  delete stored.instance_endpoint;
  delete stored.instance_client_id;
  localStorage.setItem("instance_endpoint", "https://untrusted.example");
  const auth = await import("../entrypoints/utils/oauth");
  await auth.authReady;
  expect(auth.isLoggedIn.value).toBe(false);
  expect(stored.access_token).toBe("test-access-token");

  await browser.storage.local.set({
    instance_endpoint: "https://self-hosted.example",
    instance_client_id: "self-hosted-client",
  });
  await vi.waitFor(() => expect(auth.isLoggedIn.value).toBe(true));
  expect(auth.endpoint.value).toBe("https://self-hosted.example");
});

it("preserves tokens on save but clears them when switching instances", async () => {
  const auth = await import("../entrypoints/utils/oauth");
  await auth.saveInstanceSettings("https://self-hosted.example", "self-hosted-client");
  expect(stored.access_token).toBe("test-access-token");

  await auth.saveInstanceSettings("https://another.example", "another-client");
  expect(stored).toMatchObject({
    instance_endpoint: "https://another.example",
    instance_client_id: "another-client",
    access_token: "",
    refresh_token: "",
  });
  expect(auth.isLoggedIn.value).toBe(false);
});

it("refreshes tokens with the shared instance URL and client ID", async () => {
  sendMessage.mockResolvedValue({
    success: true,
    data: { access_token: "test-new-access", refresh_token: "test-new-refresh" },
  });
  const auth = await import("../entrypoints/utils/oauth");
  await auth.refreshAccessToken();

  expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
    type: "REFRESH_TOKEN",
    payload: {
      endpoint: "https://self-hosted.example",
      clientId: "self-hosted-client",
      refreshToken: "test-refresh-token",
    },
  });
  expect(auth.isLoggedIn.value).toBe(true);
  expect(stored.access_token).toBe("test-new-access");
});
