import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { isIP } from "node:net";
import { Agent } from "undici";
import { blockedAddress, contactHostProblem, type ContactHostOptions } from "@lampstand/shared";

/**
 * The one way the API connects OUT to an address an administrator typed (a controller, a DNS server, a chat webhook, a
 * livestream link). Three rules, all in one place so they cannot drift apart again:
 *
 *  1. The host is judged by the shared `contactHostProblem` before anything is sent: never this machine, a link-local
 *     address (cloud metadata) or one of the stack's own containers. Private LAN addresses are the point and stay allowed.
 *  2. A NAME is judged on the address the connection really uses. The check runs inside the socket's own DNS lookup
 *     (`guardedLookup`), so there is no gap between "resolved and found fine" and "resolved again and connected" for a DNS
 *     server that answers differently the second time (rebinding).
 *  3. Redirects are never followed blindly: a GET may follow up to three, each target's host checked first; anything else
 *     is handed back as the 3xx it is.
 */
export class OutboundBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundBlockedError";
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** `dns.lookup` that refuses to hand back a blocked address. Used as the `lookup` of the socket, so it judges what is connected to. */
export function guardedLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as LookupAddress[];
    if (list.length === 0) return callback(new OutboundBlockedError(`${hostname} could not be found (DNS).`) as NodeJS.ErrnoException, "", 0);
    // One blocked answer spoils the set: a name that also points at loopback is not one this dashboard should be chasing.
    if (list.some((a) => blockedAddress(a.address))) {
      return callback(new OutboundBlockedError(`${hostname} points at an address the dashboard may not contact.`) as NodeJS.ErrnoException, "", 0);
    }
    if (options.all) return callback(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
}

const agents = new Map<boolean, Agent>();

/** A pooled undici agent whose sockets resolve through `guardedLookup`; one per TLS-verification mode. */
export function outboundAgent(verifyTls = true): Agent {
  let agent = agents.get(verifyTls);
  if (!agent) {
    agent = new Agent({ connect: { rejectUnauthorized: verifyTls, lookup: guardedLookup } });
    agents.set(verifyTls, agent);
  }
  return agent;
}

/**
 * Throws when `host` (a name or address literal, no port) may not be contacted, judged now: the shared rules, then DNS.
 * For callers that hand the address to something else (yt-dlp, ffmpeg) and so cannot use `outboundFetch`; that route has
 * a residual gap for a name that changes its answer between this check and the program's own lookup.
 */
export async function assertOutboundHost(host: string, options: ContactHostOptions = {}): Promise<void> {
  const problem = contactHostProblem(host, options);
  if (problem) throw new OutboundBlockedError(problem);
  const h = host.trim().replace(/^\[|\]$/g, "");
  if (h === "" || isIP(h) !== 0) return;
  await new Promise<void>((resolve, reject) => {
    guardedLookup(h, {}, (err) => (err ? reject(err) : resolve()));
  });
}

export interface OutboundInit extends Omit<RequestInit, "redirect" | "dispatcher"> {
  /** false for a controller with a self-signed certificate (the connector's own "verify TLS" setting). Default true. */
  verifyTls?: boolean;
  /** Keep one-word names working for connectors that always accepted them (the stack's containers stay refused). */
  allowShortNames?: boolean;
  /** Follow redirects of a GET (each target checked first), at most this many. Default 3; 0 returns the 3xx. */
  maxRedirects?: number;
}

/** `fetch` for an administrator-typed address. See the rules above. */
export async function outboundFetch(url: string, init: OutboundInit = {}): Promise<Response> {
  const { verifyTls = true, allowShortNames = false, maxRedirects = 3, ...rest } = init;
  const method = (rest.method ?? "GET").toUpperCase();
  const followable = method === "GET" || method === "HEAD";
  let current = url;
  for (let hop = 0; ; hop++) {
    let target: URL;
    try {
      target = new URL(current);
    } catch {
      throw new OutboundBlockedError("That is not a web address.");
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") throw new OutboundBlockedError("Only http and https addresses can be used.");
    const problem = contactHostProblem(target.hostname, { allowShortNames });
    if (problem) throw new OutboundBlockedError(problem);
    const res = await fetch(current, { ...rest, redirect: "manual", dispatcher: outboundAgent(verifyTls) } as RequestInit & { dispatcher: Agent });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location && followable && hop < maxRedirects) {
      await res.body?.cancel().catch(() => undefined);
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
}

/** The readable cause when a request failed: the guard's own sentence, else undici's cause. */
export function outboundBlockedMessage(err: unknown): string | null {
  for (let e: unknown = err, depth = 0; e && depth < 4; depth++) {
    if (e instanceof OutboundBlockedError) return e.message;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}
