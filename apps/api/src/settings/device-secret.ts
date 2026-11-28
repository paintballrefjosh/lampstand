import { MONITOR_SECRET_PLACEHOLDER } from "@lampstand/shared";
import { decryptStoredSecret, encryptSecret, isEncrypted } from "./crypto";

/**
 * A credential saved on a device row (a printer's SNMP community or Fiery API key, a UPS's community). Such rows are
 * read by everyone with the module's user tier, so the value never leaves the API: every answer carries
 * `DEVICE_SECRET_PLACEHOLDER` ("[saved]") instead, and the row stores it encrypted (`enc:v1:`, like settings secrets).
 * Writes follow the monitor-options rule: the placeholder (or the key left out) keeps the saved value, "" or null
 * removes it. Rows saved before 2026-11-13 hold plain text; they are read as they are and sealed by the module's poller.
 */
export const DEVICE_SECRET_PLACEHOLDER = MONITOR_SECRET_PLACEHOLDER;

/** What a stored credential looks like in an API answer. */
export function presentDeviceSecret(stored: string | null | undefined): string | null {
  return stored ? DEVICE_SECRET_PLACEHOLDER : null;
}

/** The column value to write for an UPDATE: `undefined` = leave the column alone. */
export function sealDeviceSecretUpdate(input: string | null | undefined): string | null | undefined {
  if (input === undefined || input === DEVICE_SECRET_PLACEHOLDER) return undefined;
  if (input === null || input.trim() === "") return null;
  return encryptSecret(input.trim());
}

/** The column value to write for an INSERT (there is nothing saved to keep, so the placeholder means none). */
export function sealDeviceSecretCreate(input: string | null | undefined): string | null {
  return sealDeviceSecretUpdate(input) ?? null;
}

/** The plain credential, for talking to the device. Throws `UnreadableSecretError` when saved under another AUTH_SECRET. */
export function openDeviceSecret(stored: string | null | undefined, what: string): string | null {
  if (!stored) return null;
  return decryptStoredSecret(stored, what);
}

/** A stored value still in plain text (saved before encryption), which the poller should seal. */
export function needsSealing(stored: string | null | undefined): stored is string {
  return typeof stored === "string" && stored !== "" && !isEncrypted(stored);
}
