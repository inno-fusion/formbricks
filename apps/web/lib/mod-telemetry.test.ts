import { afterEach, describe, expect, test, vi } from "vitest";

const { settings } = vi.hoisted(() => ({
  settings: { ENTERPRISE_BYPASS: "0", TELEMETRY_DISABLED: "0", POSTHOG_KEY: "configured-key" },
}));
vi.mock("./env", () => ({ env: settings }));
vi.unmock("./constants");
vi.mock("server-only", () => ({}));

afterEach(() => {
  settings.ENTERPRISE_BYPASS = "0";
  settings.TELEMETRY_DISABLED = "0";
  vi.resetModules();
});

describe("mod telemetry settings", () => {
  test.each([
    ["1", "0"],
    ["0", "1"],
    ["1", "1"],
  ])("does not expose a PostHog key with bypass=%s or telemetry-disabled=%s", async (bypass, disabled) => {
    settings.ENTERPRISE_BYPASS = bypass;
    settings.TELEMETRY_DISABLED = disabled;
    const { POSTHOG_KEY } = await import("./constants");
    expect(POSTHOG_KEY).toBeUndefined();
  });

  test("retains normal upstream behavior when neither opt-out is active", async () => {
    const { POSTHOG_KEY } = await import("./constants");
    expect(POSTHOG_KEY).toBe("configured-key");
  });
});
