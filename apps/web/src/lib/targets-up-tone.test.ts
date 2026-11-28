import { describe, expect, it } from "vitest";
import { targetsUpTone } from "./targets-up-tone";

describe("targets up colour", () => {
  const t = (up: number, down: number, total = 10) => ({ up, down, total });

  it("is good only when every monitored host is up", () => {
    expect(targetsUpTone(t(10, 0))).toBe("good");
    expect(targetsUpTone(t(9, 0))).toBe("warn");
  });

  it("warns for up to three down and is bad beyond that", () => {
    expect(targetsUpTone(t(9, 1))).toBe("warn");
    expect(targetsUpTone(t(7, 3))).toBe("warn");
    expect(targetsUpTone(t(6, 4))).toBe("bad");
    expect(targetsUpTone(t(0, 10))).toBe("bad");
  });

  it("counts only down hosts towards red", () => {
    expect(targetsUpTone(t(2, 0))).toBe("warn");
  });

  it("says nothing when no host is monitored", () => {
    expect(targetsUpTone(t(0, 0, 0))).toBe("ok");
  });
});
