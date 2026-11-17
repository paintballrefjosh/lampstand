import { networkInterfaces } from "node:os";

/**
 * This machine's own non-loopback IPv4 address. A fake device a test serves must listen here, not on 127.0.0.1: the
 * dashboard refuses to connect out to loopback (`outboundFetch`), which is what the tests for that rule rely on.
 */
export function lanAddress(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  throw new Error("no non-loopback IPv4 address to serve the fake device on");
}
