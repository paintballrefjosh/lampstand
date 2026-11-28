import { describe, expect, it } from "vitest";
import { SHOW_ALL_HOSTS, parseHostFilter, showsHost } from "./host-filter";

describe("host filter", () => {
  const host = (status: "up" | "down" | "degraded" | "unknown", enabled = true) => ({ status, enabled });
  const none = { down: false, disabled: false, up: false };

  it("each switch hides only its own hosts", () => {
    expect(showsHost({ ...SHOW_ALL_HOSTS, down: false }, host("down"))).toBe(false);
    expect(showsHost({ ...SHOW_ALL_HOSTS, down: false }, host("up"))).toBe(true);
    expect(showsHost({ ...SHOW_ALL_HOSTS, up: false }, host("up"))).toBe(false);
    expect(showsHost({ ...SHOW_ALL_HOSTS, up: false }, host("down"))).toBe(true);
    expect(showsHost({ ...SHOW_ALL_HOSTS, disabled: false }, host("up", false))).toBe(false);
  });

  it("judges a switched-off host as disabled, not by its old status", () => {
    expect(showsHost({ ...none, disabled: true }, host("down", false))).toBe(true);
    expect(showsHost({ ...none, up: true, down: true }, host("up", false))).toBe(false);
  });

  it("always shows degraded and unread hosts", () => {
    expect(showsHost(none, host("degraded"))).toBe(true);
    expect(showsHost(none, host("unknown"))).toBe(true);
  });

  it("reads back what was saved and shows everything otherwise", () => {
    expect(parseHostFilter(JSON.stringify({ down: true, disabled: false, up: false }))).toEqual({ down: true, disabled: false, up: false });
    expect(parseHostFilter(JSON.stringify({ up: false }))).toEqual({ down: true, disabled: true, up: false });
    for (const bad of [null, "", "nonsense", "null", "7"]) expect(parseHostFilter(bad)).toEqual(SHOW_ALL_HOSTS);
  });
});
