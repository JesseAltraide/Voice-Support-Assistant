import { describe, expect, it, vi } from "vitest";
import { isTransient, withRetry } from "./retry.js";

describe("isTransient", () => {
  it.each([
    ["a dropped socket", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })],
    ["a refused connection", Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })],
    ["a DNS blip", Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" })],
    ["a timeout", Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })],
    ["undici's opaque failure", new Error("fetch failed")],
    ["a gateway error", new Error("503 Service Unavailable")],
    ["rate limiting", new Error("429 Too Many Requests")],
    ["an overloaded upstream", new Error("Overloaded")],
  ])("treats %s as transient", (_name, err) => {
    expect(isTransient(err)).toBe(true);
  });

  it.each([
    ["a unique violation", Object.assign(new Error("duplicate key"), { code: "23505" })],
    ["a missing table", new Error("Could not find the table 'public.customers' in the schema cache")],
    ["a validation error", new Error("conversation already ended")],
    ["a permission error", new Error("401 Unauthorized")],
  ])("treats %s as permanent", (_name, err) => {
    expect(isTransient(err)).toBe(false);
  });

  it("negative: junk is permanent, so nothing retries forever on an unknown shape", () => {
    expect(isTransient(null)).toBe(false);
    expect(isTransient("boom")).toBe(false);
    expect(isTransient(undefined)).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns the first success without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    expect(await withRetry(fn, { attempts: 3, baseDelayMs: 1 })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure and succeeds", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValue("ok");
    expect(await withRetry(fn, { attempts: 3, baseDelayMs: 1 })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("negative: never retries a permanent failure", async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error("duplicate key"), { code: "23505" }));
    await expect(withRetry(fn, { attempts: 3, baseDelayMs: 1 })).rejects.toThrow("duplicate key");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after the cap and rethrows the last error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fetch failed"));
    await expect(withRetry(fn, { attempts: 3, baseDelayMs: 1 })).rejects.toThrow("fetch failed");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("stops retrying once the deadline has passed, so a turn cannot overrun", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fetch failed"));
    await expect(withRetry(fn, { attempts: 5, baseDelayMs: 40, deadlineMs: 50 })).rejects.toThrow("fetch failed");
    expect(fn.mock.calls.length).toBeLessThan(5);
  });
});
