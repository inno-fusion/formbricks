import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AuthenticationError,
  OperationNotAllowedError,
  ResourceNotFoundError,
} from "@formbricks/types/errors";
import type { AuthenticatedActionClientCtx } from "@/lib/utils/action-client/types/context";
import { rateLimitConfigs } from "@/modules/core/rate-limit/rate-limit-configs";
import { type TRecheckLicenseAction, recheckLicenseAction } from "./actions";
import { LicenseApiError } from "./lib/license";

const mocks = vi.hoisted(() => ({
  bypass: true,
  cloud: false,
  can: vi.fn(),
  applyRateLimit: vi.fn(),
  getOrganization: vi.fn(),
  getOrganizationIdFromWorkspaceId: vi.fn(),
  clearLicenseCache: vi.fn(),
  getCacheKeys: vi.fn(),
  fetchLicenseFresh: vi.fn(),
  computeFreshLicenseState: vi.fn(),
  cacheSet: vi.fn(),
  fetch: vi.fn(),
}));

// Exercise the action handler while retaining the real organization authorization helper.
vi.mock("@/lib/utils/action-client", () => ({
  authenticatedActionClient: {
    inputSchema: vi.fn(() => ({ action: vi.fn((handler) => handler) })),
  },
}));
vi.mock("@/lib/constants", () => ({
  get ENTERPRISE_BYPASS() {
    return mocks.bypass;
  },
  get IS_FORMBRICKS_CLOUD() {
    return mocks.cloud;
  },
}));
vi.mock("@/lib/authorization", () => ({ can: mocks.can }));
vi.mock("@/lib/cache", () => ({ cache: { set: mocks.cacheSet } }));
vi.mock("@/lib/organization/service", () => ({ getOrganization: mocks.getOrganization }));
vi.mock("@/lib/utils/helper", () => ({
  getOrganizationIdFromWorkspaceId: mocks.getOrganizationIdFromWorkspaceId,
}));
vi.mock("@/modules/core/rate-limit/helpers", () => ({ applyRateLimit: mocks.applyRateLimit }));
vi.mock("./lib/license", () => ({
  FAILED_FETCH_TTL_MS: 600000,
  FETCH_LICENSE_TTL_MS: 86400000,
  LicenseApiError: class extends Error {
    constructor(
      message: string,
      public readonly status: number
    ) {
      super(message);
    }
  },
  clearLicenseCache: mocks.clearLicenseCache,
  getCacheKeys: mocks.getCacheKeys,
  fetchLicenseFresh: mocks.fetchLicenseFresh,
  computeFreshLicenseState: mocks.computeFreshLicenseState,
}));

const runRecheck = () =>
  (
    recheckLicenseAction as unknown as (args: {
      ctx: AuthenticatedActionClientCtx;
      parsedInput: TRecheckLicenseAction;
    }) => Promise<{ active: boolean; status: string }>
  )({
    ctx: { user: { id: "user-1" } } as AuthenticatedActionClientCtx,
    parsedInput: { workspaceId: "cm9zr4mps000008l8btfy1vtz" },
  });

const expectNoLicenseIO = () => {
  expect(mocks.clearLicenseCache).not.toHaveBeenCalled();
  expect(mocks.getCacheKeys).not.toHaveBeenCalled();
  expect(mocks.fetchLicenseFresh).not.toHaveBeenCalled();
  expect(mocks.computeFreshLicenseState).not.toHaveBeenCalled();
  expect(mocks.cacheSet).not.toHaveBeenCalled();
  expect(mocks.fetch).not.toHaveBeenCalled();
};

describe("recheckLicenseAction", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.bypass = true;
    mocks.cloud = false;
    mocks.applyRateLimit.mockResolvedValue(undefined);
    mocks.can.mockResolvedValue(true);
    mocks.getOrganizationIdFromWorkspaceId.mockResolvedValue("org-1");
    mocks.getOrganization.mockResolvedValue({ id: "org-1" });
    mocks.getCacheKeys.mockReturnValue({ FETCH_LICENSE_CACHE_KEY: "license-cache" });
    mocks.fetchLicenseFresh.mockResolvedValue(null);
    mocks.computeFreshLicenseState.mockResolvedValue({ active: false, status: "no_license" });
    mocks.fetch.mockRejectedValue(new Error("Unexpected network request"));
    vi.stubGlobal("fetch", mocks.fetch);
  });

  test("returns active for an authorized bypass recheck without cache changes or network", async () => {
    await expect(runRecheck()).resolves.toEqual({ active: true, status: "active" });

    expect(mocks.applyRateLimit).toHaveBeenCalledWith(rateLimitConfigs.actions.licenseRecheck, "user-1");
    expect(mocks.can.mock.calls).toEqual([
      [{ type: "user", id: "user-1" }, "organization.read", { type: "organization", id: "org-1" }],
      [{ type: "user", id: "user-1" }, "organization.manage", { type: "organization", id: "org-1" }],
    ]);
    expectNoLicenseIO();
  });

  test("bypass does not permit rechecks on cloud", async () => {
    mocks.cloud = true;
    await expect(runRecheck()).rejects.toThrow(OperationNotAllowedError);
    expect(mocks.can).not.toHaveBeenCalled();
    expectNoLicenseIO();
  });

  test("bypass does not skip rate limiting", async () => {
    mocks.applyRateLimit.mockRejectedValue(new Error("Rate limit exceeded"));
    await expect(runRecheck()).rejects.toThrow("Rate limit exceeded");
    expect(mocks.getOrganization).not.toHaveBeenCalled();
    expectNoLicenseIO();
  });

  test("bypass does not grant a non-member access", async () => {
    mocks.can.mockResolvedValue(false);
    await expect(runRecheck()).rejects.toThrow(AuthenticationError);
    expect(mocks.can).toHaveBeenCalledTimes(1);
    expectNoLicenseIO();
  });

  test("bypass does not grant a member without management permission access", async () => {
    mocks.can.mockImplementation(async (_actor, action) => action === "organization.read");
    await expect(runRecheck()).rejects.toThrow(
      new OperationNotAllowedError("Only owners and managers can recheck license")
    );
    expectNoLicenseIO();
  });

  test("bypass propagates authorization failures", async () => {
    mocks.can.mockRejectedValue(new Error("Authorization unavailable"));
    await expect(runRecheck()).rejects.toThrow("Authorization unavailable");
    expectNoLicenseIO();
  });

  test("bypass still requires an existing organization", async () => {
    mocks.getOrganization.mockResolvedValue(null);
    await expect(runRecheck()).rejects.toThrow(ResourceNotFoundError);
    expectNoLicenseIO();
  });

  test("disabled bypass keeps the fresh-license cache and state path", async () => {
    mocks.bypass = false;
    const license = { status: "active", features: {} };
    mocks.fetchLicenseFresh.mockResolvedValue(license);
    mocks.computeFreshLicenseState.mockResolvedValue({ active: true, status: "active" });

    await expect(runRecheck()).resolves.toEqual({ active: true, status: "active" });
    expect(mocks.clearLicenseCache).toHaveBeenCalledOnce();
    expect(mocks.fetchLicenseFresh).toHaveBeenCalledOnce();
    expect(mocks.cacheSet).toHaveBeenCalledWith("license-cache", { value: license }, 86400000);
    expect(mocks.computeFreshLicenseState).toHaveBeenCalledWith(license);
  });

  test("disabled bypass keeps failed-fetch caching and inactive state", async () => {
    mocks.bypass = false;
    await expect(runRecheck()).resolves.toEqual({ active: false, status: "no_license" });
    expect(mocks.cacheSet).toHaveBeenCalledWith("license-cache", { value: null }, 600000);
    expect(mocks.computeFreshLicenseState).toHaveBeenCalledWith(null);
  });

  test.each([
    [400, "invalid_license"],
    [403, "instance_mismatch"],
  ])("disabled bypass preserves license API error %s", async (status, expectedStatus) => {
    mocks.bypass = false;
    mocks.fetchLicenseFresh.mockRejectedValue(new LicenseApiError("License rejected", status));
    await expect(runRecheck()).resolves.toEqual({ active: false, status: expectedStatus });
    expect(mocks.cacheSet).not.toHaveBeenCalled();
    expect(mocks.computeFreshLicenseState).not.toHaveBeenCalled();
  });
});
