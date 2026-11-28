/**
 * Which address counts as the person's own (rate limits, failed sign-in counts, the audit log, the sessions list).
 *
 * A request reaches the API through Caddy (and often through the web container too). Caddy adds the address it was
 * connected FROM to the right of `X-Forwarded-For`; everything to the left of that is whatever the connecting side wrote,
 * which a browser or a script can make up. Which entries to believe is the site admin's choice (Admin > Settings >
 * Authentication), read on every request:
 *
 * - `any` (no trusted proxies, strict off): the leftmost entry. Anyone can choose the address the site records for them
 *   and step around every per-address limit. This was the only behaviour until 2026-11-13 and stays the default so an
 *   upgrade changes nothing; the Security overview warns about it.
 * - `strict`: read from the right and take the first address that is NOT a trusted proxy. With an empty list that is the
 *   address that connected to the site, which is right when nothing sits in front of it.
 * - `standard`: if whoever connected is a trusted proxy, believe the leftmost entry it passed on; otherwise take the
 *   connecting address. Right only when the proxy REPLACES the header rather than appending to it.
 *
 * `TRUSTED_PROXIES` in `.env` (how this was configured before) is used while the list in the settings is blank, and
 * implies strict, as it did for Caddy.
 */

export const CLIENT_IP_KEYS = {
  trustedProxies: "auth.trusted_proxies",
  strict: "auth.trusted_proxies_strict",
} as const;

export type ClientIpMode = "any" | "strict" | "standard";

export interface ClientIpPolicy {
  mode: ClientIpMode;
  /** Trusted proxy subnets, `a.b.c.d/n` or IPv6 `x::y/n`. */
  cidrs: string[];
  /** The list came from `TRUSTED_PROXIES` in `.env`, not from the settings. */
  fromEnv: boolean;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function isIpv6(s: string): boolean {
  if (!/^[0-9a-fA-F:.]+$/.test(s) || !s.includes(":")) return false;
  const parts = s.split("::");
  if (parts.length > 2) return false;
  // An embedded IPv4 tail (::ffff:10.0.0.1) counts as two groups.
  const groupsOf = (p: string): number | null => {
    if (p === "") return 0;
    const gs = p.split(":");
    let n = 0;
    for (let i = 0; i < gs.length; i++) {
      const g = gs[i]!;
      if (i === gs.length - 1 && g.includes(".")) {
        if (!IPV4.test(g)) return null;
        n += 2;
      } else if (/^[0-9a-fA-F]{1,4}$/.test(g)) n += 1;
      else return null;
    }
    return n;
  };
  const counts = parts.map(groupsOf);
  if (counts.some((c) => c === null)) return false;
  const total = (counts as number[]).reduce((a, b) => a + b, 0);
  return parts.length === 2 ? total <= 7 : total === 8;
}

/** One address or subnet: `10.0.0.5`, `10.0.0.0/24`, `fd00::/8`. A bare address gets /32 or /128. */
export function normaliseProxyCidr(raw: string): string | null {
  const s = raw.trim();
  const slash = s.indexOf("/");
  const addr = slash === -1 ? s : s.slice(0, slash);
  const bitsText = slash === -1 ? null : s.slice(slash + 1);
  const v4 = IPV4.test(addr);
  const v6 = !v4 && isIpv6(addr);
  if (!v4 && !v6) return null;
  const max = v4 ? 32 : 128;
  if (bitsText === null) return `${addr.toLowerCase()}/${max}`;
  if (!/^\d{1,3}$/.test(bitsText) || Number(bitsText) > max) return null;
  return `${addr.toLowerCase()}/${Number(bitsText)}`;
}

/** Parse the admin's list (spaces, commas or new lines between entries). */
export function parseTrustedProxies(text: string): { cidrs: string[]; bad: string[] } {
  const cidrs: string[] = [];
  const bad: string[] = [];
  for (const raw of text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)) {
    const n = normaliseProxyCidr(raw);
    if (n) cidrs.push(n);
    else bad.push(raw);
  }
  return { cidrs: [...new Set(cidrs)], bad };
}

/** The setting's error message, or null when the list is fine. */
export function trustedProxiesProblem(value: unknown): string | null {
  if (typeof value !== "string") return "Enter addresses or subnets separated by spaces or commas.";
  if (value.length > 4000) return "That list is too long.";
  const { cidrs, bad } = parseTrustedProxies(value);
  if (bad.length) return `Not an address or subnet: ${bad.slice(0, 5).join(", ")}`;
  if (cidrs.length > 100) return "List at most 100 addresses or subnets.";
  return null;
}

/** The policy in force, from the two settings and the older `.env` value. Unreadable entries are left out. */
export function resolveClientIpPolicy(input: { trustedProxies: unknown; strict: unknown; envTrustedProxies?: string | null }): ClientIpPolicy {
  const fromSetting = typeof input.trustedProxies === "string" ? parseTrustedProxies(input.trustedProxies).cidrs : [];
  const fromEnv = fromSetting.length === 0 ? parseTrustedProxies(input.envTrustedProxies ?? "").cidrs : [];
  // The .env value only ever meant one thing to Caddy: a list of proxies, read right to left. "0.0.0.0/0" there is the
  // compose default for "trust everyone", not a list.
  const envList = fromEnv.filter((c) => c !== "0.0.0.0/0" && c !== "::/0");
  if (envList.length > 0) return { mode: "strict", cidrs: envList, fromEnv: true };
  const strict = input.strict === true;
  if (fromSetting.length === 0 && !strict) return { mode: "any", cidrs: [], fromEnv: false };
  return { mode: strict ? "strict" : "standard", cidrs: fromSetting, fromEnv: false };
}

/**
 * Whether to look past the address at `hop` (0 = whoever connected to the API, 1 = the address Caddy saw, then each
 * `X-Forwarded-For` entry from right to left). The first address NOT looked past is the person's. This is the trust
 * function Fastify's proxy-addr calls; `inList` tells whether an address is one of the policy's proxies.
 */
export function trustHop(policy: ClientIpPolicy, inList: (addr: string) => boolean, addr: string, hop: number): boolean {
  // Only Caddy and the web container can connect to the API (it publishes no port), so hop 0 is always one of ours.
  if (hop === 0) return true;
  switch (policy.mode) {
    case "any":
      return true;
    case "strict":
      return inList(addr);
    case "standard":
      // proxy-addr stops at the first untrusted hop, so a call for hop 2+ means hop 1 was a trusted proxy.
      return hop === 1 ? inList(addr) : true;
  }
}

/**
 * The same answer for a plain list of addresses (leftmost first, as in the header, with the connecting address last).
 * Used by the Security overview to show an admin what the site sees for them.
 */
export function pickClientIp(policy: ClientIpPolicy, inList: (addr: string) => boolean, chain: readonly string[]): string | null {
  if (chain.length === 0) return null;
  const fromRight = [...chain].reverse();
  for (let i = 0; i < fromRight.length - 1; i++) {
    if (!trustHop(policy, inList, fromRight[i]!, i + 1)) return fromRight[i]!;
  }
  return fromRight[fromRight.length - 1]!;
}

/**
 * The `X-Forwarded-For` value the web passes on to the API: the whole chain as it arrived (the API decides which entry is
 * the person's), cut to the RIGHTMOST 20 entries, because the right end is what Caddy and the proxies wrote and the left
 * end is whatever the sender chose.
 */
export function forwardedChain(header: string | null | undefined): string {
  if (!header) return "";
  const entries = header.split(",").map((s) => s.trim()).filter(Boolean);
  return entries.slice(-20).join(", ");
}
