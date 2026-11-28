import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret } from "../src/settings/crypto";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = "a-test-auth-secret";
});
afterEach(() => {
  if (saved === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = saved;
});

describe("saved secrets", () => {
  it("reads back what it wrote", () => {
    expect(decryptSecret(encryptSecret("smtp-password"))).toBe("smtp-password");
  });
  it("fails for a value saved under another AUTH_SECRET", async () => {
    const enc = encryptSecret("x");
    process.env.AUTH_SECRET = "another-secret";
    vi.resetModules(); // the key is cached per process
    const fresh = await import("../src/settings/crypto");
    expect(() => fresh.decryptSecret(enc)).toThrow();
  });
});
