import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { BlockList, isIP } from "node:net";
import { CLIENT_IP_KEYS, resolveClientIpPolicy, trustHop, type ClientIpPolicy } from "@lampstand/shared";
import { SettingsService } from "../settings/settings.service";

/**
 * The client-address policy in force on this node (see packages/shared/src/client-ip.ts). Fastify's `trustProxy` is set
 * once when the server is built and must answer synchronously, so `main.ts` gives it `trustProxyHop`, which reads the
 * policy held here; `ClientIpPolicyService` refreshes it from the settings every few seconds. Until the first read it is
 * the `.env` value or "any", which is what the site did before the setting existed.
 */
interface Compiled {
  policy: ClientIpPolicy;
  list: BlockList;
}

function compile(policy: ClientIpPolicy): Compiled {
  const list = new BlockList();
  for (const cidr of policy.cidrs) {
    const [addr, bits] = cidr.split("/") as [string, string];
    const family = isIP(addr) === 6 ? "ipv6" : "ipv4";
    try {
      list.addSubnet(addr, Number(bits), family);
    } catch {
      // parseTrustedProxies already refused anything unreadable; a value Node still rejects is simply not trusted.
    }
  }
  return { policy, list };
}

/** `::ffff:10.0.0.1` (an IPv4 client on a dual-stack socket) is 10.0.0.1. */
function plain(addr: string): string {
  const a = addr.trim();
  return a.toLowerCase().startsWith("::ffff:") && isIP(a.slice(7)) === 4 ? a.slice(7) : a;
}

export function inTrustedList(list: BlockList, addr: string): boolean {
  const a = plain(addr);
  const family = isIP(a);
  if (family === 0) return false;
  return list.check(a, family === 6 ? "ipv6" : "ipv4");
}

let current: Compiled = compile(resolveClientIpPolicy({ trustedProxies: "", strict: false, envTrustedProxies: process.env.TRUSTED_PROXIES }));

/** Fastify `trustProxy`: whether to look past the address at `hop` (0 = the connecting socket). */
export function trustProxyHop(addr: string, hop: number): boolean {
  const c = current;
  return trustHop(c.policy, (a) => inTrustedList(c.list, a), addr, hop);
}

export function currentClientIpPolicy(): ClientIpPolicy {
  return current.policy;
}

/** Whether an address is one of the current policy's trusted proxies. */
export function isTrustedProxy(addr: string): boolean {
  return inTrustedList(current.list, addr);
}

/** For tests: install a policy directly. */
export function setClientIpPolicy(policy: ClientIpPolicy): void {
  current = compile(policy);
}

const REFRESH_MS = 5_000;

@Injectable()
export class ClientIpPolicyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClientIpPolicyService.name);
  private timer: NodeJS.Timeout | null = null;
  private lastKey = "";

  constructor(private readonly settings: SettingsService) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
    // Per-node state, not cluster work: every node keeps its own copy (the settings cache is already shared by the bus).
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh(): Promise<void> {
    try {
      const [trustedProxies, strict] = await Promise.all([
        this.settings.get(CLIENT_IP_KEYS.trustedProxies),
        this.settings.get(CLIENT_IP_KEYS.strict),
      ]);
      const policy = resolveClientIpPolicy({ trustedProxies, strict, envTrustedProxies: process.env.TRUSTED_PROXIES });
      const key = JSON.stringify(policy);
      if (key === this.lastKey) return;
      current = compile(policy);
      if (this.lastKey !== "") this.logger.log(`client address policy: ${policy.mode}${policy.cidrs.length ? ` (${policy.cidrs.join(" ")})` : ""}`);
      this.lastKey = key;
    } catch {
      // The database is unreachable: keep the policy we have rather than fall back to believing anything.
    }
  }
}
