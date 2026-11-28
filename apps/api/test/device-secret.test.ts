import { beforeAll, describe, expect, it } from "vitest";
import {
  DEVICE_SECRET_PLACEHOLDER,
  needsSealing,
  openDeviceSecret,
  presentDeviceSecret,
  sealDeviceSecretCreate,
  sealDeviceSecretUpdate,
} from "../src/settings/device-secret";
import { UnreadableSecretError, isEncrypted } from "../src/settings/crypto";

/**
 * Printer and UPS credentials (SNMP community, Fiery API key). Until 2026-11-13 every printer reader (the baseline `user`
 * group) got them in clear from GET /printers, and every Monitoring reader the UPS community; now an answer only says
 * "[saved]", the row holds them encrypted, and editing a device without retyping keeps them.
 */
beforeAll(() => {
  process.env.AUTH_SECRET ||= "device-secret-test-secret-device-secret-test";
});

describe("device credentials", () => {
  it("are never returned, only whether one is saved", () => {
    expect(presentDeviceSecret("enc:v1:abc")).toBe(DEVICE_SECRET_PLACEHOLDER);
    expect(presentDeviceSecret("public")).toBe(DEVICE_SECRET_PLACEHOLDER);
    expect(presentDeviceSecret(null)).toBeNull();
    expect(presentDeviceSecret("")).toBeNull();
  });

  it("are stored encrypted and read back", () => {
    const stored = sealDeviceSecretCreate("  s3cret-community ");
    expect(isEncrypted(stored)).toBe(true);
    expect(stored).not.toContain("s3cret");
    expect(openDeviceSecret(stored, "SNMP community")).toBe("s3cret-community");
  });

  it("an update with the placeholder or without the key keeps the saved value; blank or null removes it", () => {
    expect(sealDeviceSecretUpdate(undefined)).toBeUndefined();
    expect(sealDeviceSecretUpdate(DEVICE_SECRET_PLACEHOLDER)).toBeUndefined();
    expect(sealDeviceSecretUpdate("")).toBeNull();
    expect(sealDeviceSecretUpdate("   ")).toBeNull();
    expect(sealDeviceSecretUpdate(null)).toBeNull();
    expect(isEncrypted(sealDeviceSecretUpdate("new"))).toBe(true);
    // Creating with the placeholder saves nothing (there is nothing to keep).
    expect(sealDeviceSecretCreate(DEVICE_SECRET_PLACEHOLDER)).toBeNull();
  });

  it("plain values saved before encryption still work and are flagged for sealing", () => {
    expect(openDeviceSecret("public", "SNMP community")).toBe("public");
    expect(needsSealing("public")).toBe(true);
    expect(needsSealing(sealDeviceSecretCreate("public"))).toBe(false);
    expect(needsSealing(null)).toBe(false);
    expect(needsSealing("")).toBe(false);
  });

  it("a value saved under another AUTH_SECRET says so instead of failing silently", () => {
    const foreign = "enc:v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA";
    expect(() => openDeviceSecret(foreign, "Fiery API key")).toThrow(UnreadableSecretError);
    expect(() => openDeviceSecret(foreign, "Fiery API key")).toThrow(/Fiery API key/);
  });
});
