import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import {
  forwardedChain,
  normaliseProxyCidr,
  parseTrustedProxies,
  pickClientIp,
  resolveClientIpPolicy,
  trustedProxiesProblem,
  validateSettingValue,
  type ClientIpPolicy,
} from "@lampstand/shared";
import { setClientIpPolicy, trustProxyHop } from "../src/auth/client-ip";

/**
 * Which forwarded address counts as the person's. The Fastify cases build a server the way main.ts does (`trustProxy:
 * trustProxyHop`) and ask it for `req.ip`, so they test what the API really records, not a copy of the rule. Caddy sits
 * in front and appends the address it was connected from, so the header the API sees is `<what the sender wrote...>,
 * <what connected to Caddy>`, and the socket is Caddy (or the web container).
 */
const CADDY = "172.18.0.5";
const LB = "10.0.0.7";
const CLIENT = "203.0.113.9";
const FORGED = "10.66.3.7";

async function ipFor(policy: ClientIpPolicy, xff: string | null): Promise<string> {
  setClientIpPolicy(policy);
  const app = Fastify({ trustProxy: trustProxyHop });
  app.get("/", async (req) => ({ ip: req.ip, host: req.host }));
  const res = await app.inject({
    method: "GET",
    url: "/",
    remoteAddress: CADDY,
    headers: { host: "caddy:8100", "x-forwarded-host": "church.example.org", ...(xff ? { "x-forwarded-for": xff } : {}) },
  });
  await app.close();
  const body = res.json() as { ip: string; host: string };
  // Hop 0 is always trusted, so the public host name still comes from X-Forwarded-Host as with `trustProxy: true`.
  expect(body.host).toBe("church.example.org");
  return body.ip;
}

const any: ClientIpPolicy = { mode: "any", cidrs: [], fromEnv: false };
const strictLb: ClientIpPolicy = { mode: "strict", cidrs: ["10.0.0.0/24"], fromEnv: false };
const strictNone: ClientIpPolicy = { mode: "strict", cidrs: [], fromEnv: false };
const standardLb: ClientIpPolicy = { mode: "standard", cidrs: ["10.0.0.0/24"], fromEnv: false };

afterEach(() => setClientIpPolicy(any));

describe("the address the API records", () => {
  it("'any' believes the leftmost entry, so a sender picks it (the old behaviour, kept as the default)", async () => {
    expect(await ipFor(any, `${FORGED}, ${CLIENT}`)).toBe(FORGED);
    expect(await ipFor(any, CLIENT)).toBe(CLIENT);
  });

  it("strict with nothing trusted takes the address that connected to Caddy, whatever the sender wrote", async () => {
    expect(await ipFor(strictNone, `${FORGED}, ${CLIENT}`)).toBe(CLIENT);
    expect(await ipFor(strictNone, `1.1.1.1, ${FORGED}, ${CLIENT}`)).toBe(CLIENT);
    expect(await ipFor(strictNone, CLIENT)).toBe(CLIENT);
  });

  it("strict behind an appending load balancer skips the balancer and ignores the sender's entries", async () => {
    // The balancer appended the client, Caddy appended the balancer.
    expect(await ipFor(strictLb, `${FORGED}, ${CLIENT}, ${LB}`)).toBe(CLIENT);
    expect(await ipFor(strictLb, `${CLIENT}, ${LB}`)).toBe(CLIENT);
    // Someone reaching the node directly, past the balancer: their own address, not their claim.
    expect(await ipFor(strictLb, `${FORGED}, ${CLIENT}`)).toBe(CLIENT);
  });

  it("strict matches IPv6 subnets and IPv4-mapped addresses", async () => {
    const v6: ClientIpPolicy = { mode: "strict", cidrs: ["fd00::/8", "10.0.0.0/24"], fromEnv: false };
    expect(await ipFor(v6, `${CLIENT}, fd00::1`)).toBe(CLIENT);
    expect(await ipFor(v6, `${CLIENT}, ::ffff:10.0.0.7`)).toBe(CLIENT);
    expect(await ipFor(v6, `${FORGED}, 2001:db8::5`)).toBe("2001:db8::5");
  });

  it("standard believes the leftmost entry only when a trusted proxy connected", async () => {
    expect(await ipFor(standardLb, `${CLIENT}, ${LB}`)).toBe(CLIENT);
    expect(await ipFor(standardLb, `${FORGED}, ${CLIENT}, ${LB}`)).toBe(FORGED);
    expect(await ipFor(standardLb, `${FORGED}, ${CLIENT}`)).toBe(CLIENT);
  });

  it("with no forwarded header at all, the socket is the address (MCP's in-process calls)", async () => {
    expect(await ipFor(strictLb, null)).toBe(CADDY);
    expect(await ipFor(any, null)).toBe(CADDY);
  });

  it("pickClientIp agrees with Fastify for the Security overview", () => {
    const inLb = (a: string) => a.startsWith("10.0.0.");
    expect(pickClientIp(strictLb, inLb, [FORGED, CLIENT, LB])).toBe(CLIENT);
    expect(pickClientIp(standardLb, inLb, [FORGED, CLIENT, LB])).toBe(FORGED);
    expect(pickClientIp(any, inLb, [FORGED, CLIENT])).toBe(FORGED);
    expect(pickClientIp(strictNone, () => false, [FORGED, CLIENT])).toBe(CLIENT);
    expect(pickClientIp(strictNone, () => false, [])).toBeNull();
  });
});

describe("the settings", () => {
  it("parses addresses and subnets, IPv4 and IPv6", () => {
    expect(parseTrustedProxies("10.0.0.0/24, 192.168.1.5\nfd00::/8 2001:db8::1")).toEqual({
      cidrs: ["10.0.0.0/24", "192.168.1.5/32", "fd00::/8", "2001:db8::1/128"],
      bad: [],
    });
    expect(parseTrustedProxies("10.0.0.0/33 300.1.1.1 lb.local 10.0.0.1")).toEqual({ cidrs: ["10.0.0.1/32"], bad: ["10.0.0.0/33", "300.1.1.1", "lb.local"] });
    expect(normaliseProxyCidr("::ffff:10.0.0.1")).toBe("::ffff:10.0.0.1/128");
    expect(normaliseProxyCidr("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(normaliseProxyCidr("fd00::/129")).toBeNull();
  });

  it("refuses a list it cannot read, at save time", () => {
    expect(trustedProxiesProblem("")).toBeNull();
    expect(trustedProxiesProblem("10.0.0.0/24 fd00::/8")).toBeNull();
    expect(trustedProxiesProblem("10.0.0.0/24 nope")).toMatch(/nope/);
    expect(trustedProxiesProblem(42)).not.toBeNull();
    expect(validateSettingValue("auth.trusted_proxies", "lb.example.org")).not.toBeNull();
    expect(validateSettingValue("auth.trusted_proxies", "10.1.0.0/16")).toBeNull();
  });

  it("resolves the policy: settings first, then TRUSTED_PROXIES from .env (strict), else 'any'", () => {
    expect(resolveClientIpPolicy({ trustedProxies: "", strict: false })).toEqual({ mode: "any", cidrs: [], fromEnv: false });
    expect(resolveClientIpPolicy({ trustedProxies: "", strict: true })).toEqual({ mode: "strict", cidrs: [], fromEnv: false });
    expect(resolveClientIpPolicy({ trustedProxies: "10.0.0.0/24", strict: false })).toEqual({ mode: "standard", cidrs: ["10.0.0.0/24"], fromEnv: false });
    expect(resolveClientIpPolicy({ trustedProxies: "10.0.0.0/24", strict: true, envTrustedProxies: "192.168.0.0/16" })).toEqual({
      mode: "strict",
      cidrs: ["10.0.0.0/24"],
      fromEnv: false,
    });
    // An install configured the old way keeps working: the .env list, read strictly as Caddy did.
    expect(resolveClientIpPolicy({ trustedProxies: "", strict: false, envTrustedProxies: "192.168.0.0/16" })).toEqual({
      mode: "strict",
      cidrs: ["192.168.0.0/16"],
      fromEnv: true,
    });
    // The compose default "0.0.0.0/0" means "trust everyone", not a list.
    expect(resolveClientIpPolicy({ trustedProxies: "", strict: false, envTrustedProxies: "0.0.0.0/0" }).mode).toBe("any");
    expect(resolveClientIpPolicy({ trustedProxies: undefined, strict: undefined }).mode).toBe("any");
  });
});

describe("what the web passes on", () => {
  it("keeps the whole chain, cut to the rightmost 20 entries", () => {
    expect(forwardedChain(" 1.1.1.1 ,2.2.2.2,, 3.3.3.3 ")).toBe("1.1.1.1, 2.2.2.2, 3.3.3.3");
    expect(forwardedChain(null)).toBe("");
    const long = Array.from({ length: 30 }, (_, i) => `10.0.0.${i}`).join(",");
    const kept = forwardedChain(long).split(", ");
    expect(kept).toHaveLength(20);
    expect(kept.at(-1)).toBe("10.0.0.29");
  });
});
