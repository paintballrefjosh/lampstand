import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OutboundBlockedError, assertOutboundHost, guardedLookup, outboundBlockedMessage, outboundFetch } from "../src/net/outbound";
import { propresenterUrl } from "../src/propresenter/propresenter.service";

describe("guardedLookup", () => {
  const lookupOf = (host: string, all = false) =>
    new Promise<{ err: Error | null; result: unknown }>((resolve) => {
      guardedLookup(host, { all }, (err, address) => resolve({ err, result: address }));
    });

  it("refuses a name that resolves to this machine, in both lookup shapes", async () => {
    for (const all of [false, true]) {
      const { err } = await lookupOf("localhost", all);
      expect(err).toBeInstanceOf(OutboundBlockedError);
    }
  });

  it("refuses an address literal that is loopback or link-local", async () => {
    for (const host of ["127.0.0.1", "169.254.169.254", "::1"]) {
      const { err } = await lookupOf(host);
      expect(err, host).toBeInstanceOf(OutboundBlockedError);
    }
  });

  it("hands back a permitted address in the shape the caller asked for", async () => {
    const one = await lookupOf("10.1.2.3");
    expect(one.err).toBeNull();
    expect(one.result).toBe("10.1.2.3");
    const many = await lookupOf("10.1.2.3", true);
    expect(many.err).toBeNull();
    expect(many.result).toEqual([{ address: "10.1.2.3", family: 4 }]);
  });
});

describe("assertOutboundHost", () => {
  it("refuses inward hosts before and after DNS, and a name that cannot be found", async () => {
    for (const host of ["127.0.0.1", "localhost", "api", "169.254.169.254", "[::1]", "2130706433"]) {
      await expect(assertOutboundHost(host), host).rejects.toThrow();
    }
    await expect(assertOutboundHost("no-such-host.invalid")).rejects.toThrow();
  });

  it("allows a private address literal", async () => {
    await expect(assertOutboundHost("10.0.0.5")).resolves.toBeUndefined();
    await expect(assertOutboundHost("192.168.1.20")).resolves.toBeUndefined();
  });
});

describe("outboundFetch", () => {
  let hits = 0;
  let port = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
    res.end();
  });
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("never connects to this machine, so a server there is not reached", async () => {
    hits = 0;
    for (const url of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`, `http://[::ffff:127.0.0.1]:${port}/`, `http://[::127.0.0.1]:${port}/`, `http://2130706433:${port}/`]) {
      const err = await outboundFetch(url).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, url).toBeInstanceOf(OutboundBlockedError);
    }
    expect(hits).toBe(0);
  });

  it("refuses one of the stack's containers by name even where a one-word name is allowed", async () => {
    await expect(outboundFetch("http://api:3001/api/v1/readyz", { allowShortNames: true })).rejects.toBeInstanceOf(OutboundBlockedError);
    await expect(outboundFetch("http://garage:3900/", { allowShortNames: true })).rejects.toBeInstanceOf(OutboundBlockedError);
  });

  it("refuses other schemes and a malformed address", async () => {
    await expect(outboundFetch("file:///etc/passwd")).rejects.toBeInstanceOf(OutboundBlockedError);
    await expect(outboundFetch("not a url")).rejects.toBeInstanceOf(OutboundBlockedError);
  });

  it("names the guard's own sentence when a request fails because of it", async () => {
    const err = await outboundFetch("http://127.0.0.1:1/").catch((e: unknown) => e);
    expect(outboundBlockedMessage(err)).toMatch(/may contact/);
    expect(outboundBlockedMessage(new Error("boom"))).toBeNull();
  });
});

describe("the ProPresenter address", () => {
  it("is built only from a plain host and a port, so the host cannot choose the path", () => {
    expect(propresenterUrl("10.0.0.8", 1025, "/version")).toBe("http://10.0.0.8:1025/version");
    expect(propresenterUrl("pp7-mac", 1025, "/v1/status/slide")).toBe("http://pp7-mac:1025/v1/status/slide");
    for (const host of ["api:3001/api/v1/readyz#", "10.0.0.8/x", "10.0.0.8?x=1", "u@10.0.0.8", "127.0.0.1", "api", "[::1]", "2130706433", ""]) {
      expect(propresenterUrl(host, 1025, "/version"), host).toBeNull();
    }
    expect(propresenterUrl("10.0.0.8", 0, "/version")).toBeNull();
    expect(propresenterUrl("10.0.0.8", 99999, "/version")).toBeNull();
  });
});
