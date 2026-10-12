// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://example.atlassian.net/"}

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ContentScriptContext } from "wxt/utils/content-script-context";

const api = vi.hoisted(() => ({ current: vi.fn(), create: vi.fn(), update: vi.fn() }));
vi.mock("../entrypoints/utils/timeEntries", () => ({ getCurrentTimeEntry: api.current }));
vi.mock("../entrypoints/utils/api", () => ({
  apiClient: () => ({ createTimeEntry: api.create, updateTimeEntry: api.update }),
}));

const platforms = [
  {
    name: "Jira",
    url: "https://example.atlassian.net/browse/TEST-1",
    html: '<div data-testid="issue.views.issue-base.foundation.status.actions-wrapper"><div><button>Automation</button></div></div>',
    buttonId: "solidtime-jira-tracking-btn",
    start: "Start Timer",
    stop: "Stop Timer",
  },
  {
    name: "Linear",
    url: "https://linear.app/team/issue/TEST-1/test-issue",
    html: '<div><div><span>Labels</span></div><div><span>Project</span></div></div>',
    buttonId: "solidtime-start-tracking-btn",
    start: "Start Tracking",
    stop: "Stop Tracking",
  },
  {
    name: "Plane",
    url: "https://app.plane.so/team/browse/TEST-1",
    html: '<div class="flex items-center flex-wrap gap-2"><button>Add relation</button></div>',
    buttonId: "solidtime-plane-tracking-btn",
    start: "Start Tracking",
    stop: "Stop Tracking",
  },
];

let stored: Record<string, unknown>;
let cleanups: (() => void)[];
let observers: MutationObserver[];

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  localStorage.clear();
  cleanups = [];
  observers = [];
  api.current.mockResolvedValue({ data: { id: "running-entry", organization_id: "organization" } });
  api.update.mockResolvedValue({});
  api.create.mockResolvedValue({});
  stored = {
    access_token: "existing-access", refresh_token: "existing-refresh",
    current_organization_id: "organization", currentMembershipId: "member",
  };
  const listeners: ((changes: Record<string, { newValue: unknown }>, area: string) => void)[] = [];
  vi.stubGlobal("browser", {
    storage: {
      local: {
        get: async () => ({ ...stored }),
        set: async (values: Record<string, unknown>) => {
          Object.assign(stored, values);
          const changes = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }]));
          listeners.forEach((listener) => listener(changes, "local"));
        },
      },
      onChanged: { addListener: (listener: typeof listeners[number]) => listeners.push(listener) },
    },
  });
  vi.stubGlobal("defineContentScript", (config: unknown) => config);
  vi.stubGlobal("alert", vi.fn());
  const OriginalObserver = MutationObserver;
  vi.stubGlobal("MutationObserver", class extends OriginalObserver {
    constructor(callback: MutationCallback) {
      super(callback);
      observers.push(this);
    }
  });
  vi.spyOn(window, "addEventListener");
});

afterEach(() => {
  cleanups.forEach((cleanup) => cleanup());
  observers.forEach((observer) => observer.disconnect());
  for (const [event, listener, options] of vi.mocked(window.addEventListener).mock.calls) {
    window.removeEventListener(event, listener, options);
  }
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(platforms.flatMap((platform) => [false, true].map((migrateBeforeButton) => ({
  ...platform, migrateBeforeButton,
}))))("$name stops the running timer after popup migration (during page load: $migrateBeforeButton)", async (platform) => {
  const url = new URL(platform.url);
  for (const key of ["hostname", "pathname", "href"] as const) {
    vi.spyOn(window.location, key, "get").mockReturnValue(url[key]);
  }
  document.body.innerHTML = platform.migrateBeforeButton ? "" : platform.html;
  const auth = await import("../entrypoints/utils/oauth");
  await auth.authReady;
  const { default: content } = await import("../entrypoints/content");
  await content.main({
    isInvalid: false,
    onInvalidated: (cleanup: () => void) => cleanups.push(cleanup),
  } as unknown as ContentScriptContext);
  const button = () => document.getElementById(platform.buttonId)!;
  if (!platform.migrateBeforeButton) {
    await vi.waitFor(() => expect(button()?.textContent).toBe(platform.start));
  }
  expect(api.current).not.toHaveBeenCalled();

  await browser.storage.local.set({
    instance_endpoint: "https://app.solidtime.io",
    instance_client_id: "019b27e8-a52a-71d8-8d67-071cff97f315",
  });
  if (platform.migrateBeforeButton) {
    document.body.innerHTML = platform.html;
  }
  await vi.waitFor(() => expect(button()?.textContent).toBe(platform.stop));
  expect(document.querySelectorAll(`#${platform.buttonId}`)).toHaveLength(1);
  button().click();
  await vi.waitFor(() => expect(api.update).toHaveBeenCalledOnce());
  expect(api.create).not.toHaveBeenCalled();
  expect(api.update).toHaveBeenCalledWith(
    expect.objectContaining({ id: "running-entry", end: expect.any(String) }),
    { params: { organization: "organization", timeEntry: "running-entry" } },
  );
});
