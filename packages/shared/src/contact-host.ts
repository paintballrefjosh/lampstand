import { blockedAddress } from "./schemas/livestream";

/**
 * Hosts that mean "something inside this stack": the compose network resolves a one-word name to a container, so a
 * setting that names one would let an admin point a connector at the API, the database or the object store.
 */
export const STACK_HOST_NAMES: ReadonlySet<string> = new Set([
  "api",
  "web",
  "proxy",
  "caddy",
  "internal",
  "healthcheck",
  "meilisearch",
  "garage",
  "garage-init",
  "monitor",
  "cockroach",
  "cockroach-init",
  "localhost",
]);

/** Names cloud platforms answer on a link-local address (never a church's own equipment). */
const METADATA_NAMES: ReadonlySet<string> = new Set(["metadata", "metadata.google.internal", "instance-data", "instance-data.ec2.internal"]);

export interface ContactHostOptions {
  /**
   * Let a one-word name through (`pp7-mac`, `unifi`). Connectors that have always been typed that way keep working;
   * the stack's own container names are still refused by name. Leave it off for anything new.
   */
  allowShortNames?: boolean;
}

/** The host exactly as a connection would use it: lower case, no brackets or trailing dot, numeric spellings written out. */
export function normaliseContactHost(host: string): string | null {
  const trimmed = host.trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (trimmed === "") return "";
  try {
    // The URL parser is what `fetch` will use, so judge what IT sees: `2130706433`, `0x7f.1` and `127.1` all become 127.0.0.1.
    const u = new URL(`http://${trimmed.includes(":") ? `[${trimmed}]` : trimmed}`);
    return u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  } catch {
    return null;
  }
}

/**
 * Why the dashboard may not connect OUT to this host, or null when it may. Pure, so a setting can be refused when it is
 * saved; the connecting code asks again after DNS (`assertContactHost` in the API), because a name can point anywhere.
 * Private LAN addresses are allowed: a mail server or a switch on the church network is the point.
 */
export function contactHostProblem(host: string, options: ContactHostOptions = {}): string | null {
  const h = normaliseContactHost(host);
  if (h === null) return "That is not a valid host name or address.";
  if (h === "") return null;
  if (blockedAddress(h)) return `${h} is not an address the dashboard may contact (this machine itself, or a link-local address).`;
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":");
  if (isIpLiteral) return null;
  if (h.endsWith(".localhost") || METADATA_NAMES.has(h)) return `"${h}" is not a host the dashboard may contact.`;
  if (STACK_HOST_NAMES.has(h) || /^cockroach/.test(h) || (!options.allowShortNames && !h.includes("."))) {
    return `"${h}" is not allowed: use the server's full name or its address.`;
  }
  return null;
}

/**
 * Why a typed address (`https://dns1.example.org:53443`) may not be used, or null. http and https only, no credentials in
 * it, and the host judged by `contactHostProblem`. An empty string means "not set" and is fine.
 */
export function contactUrlProblem(raw: string, options: ContactHostOptions = {}): string | null {
  const text = raw.trim();
  if (text === "") return null;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return "That is not a web address. Start it with http:// or https://.";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "Only http and https addresses can be used.";
  if (u.username || u.password) return "Put no user name or password in the address.";
  if (u.hostname === "") return "That address has no host.";
  return contactHostProblem(u.hostname, options);
}
