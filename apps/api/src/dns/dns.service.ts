import {
  Injectable,
  BadRequestException,
  BadGatewayException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  hasManagedMarker,
  type DnsNode,
  type DnsPtrOutcome,
  type DnsPtrRefusal,
  type DnsPtrState,
  type DnsRecord,
  type DnsRecordCreateInput,
  type DnsRecordData,
  type DnsRecordDeleteInput,
  type DnsRecordUpdateInput,
  type DnsRecordWriteResult,
  type DnsStats,
  type DnsStatsRange,
  type DnsSummary,
  type DnsTestInput,
  type DnsTopEntry,
  type DnsZone,
} from "@lampstand/shared";
import { SettingsService } from "../settings/settings.service";
import { ptrName, reverseZoneFor } from "./sync-plan";
import {
  technitiumCall,
  TechnitiumError,
  tsOrNull,
  formatRData,
  parseRData,
  dataParams,
  newDataParams,
  sameData,
  type TechnitiumConfig,
  type TSessionInfo,
  type TClusterState,
  type TZone,
  type TRecord,
  type TStats,
  type TTopEntry,
} from "./technitium";

// DNSSEC bookkeeping records — noise in a records table; Technitium manages them.
const HIDDEN_RECORD_TYPES = new Set(["RRSIG", "NSEC", "NSEC3", "NSEC3PARAM", "DNSKEY"]);

// Cluster member states that count as healthy.
const HEALTHY_NODE_STATES = new Set(["Self", "Connected"]);

/** Where a reverse record goes, and what is at that name now. */
interface PtrPlan {
  zone: string;
  name: string;
  existing: DnsRecord[];
  /** Set when the zone has to be created first. */
  newZone?: { catalog: string | undefined };
}

/** What the caller allows a reverse record write to do. */
interface PtrConsent {
  /** The zone of the A record. */
  forwardZone: string;
  createZone: boolean;
  replace: string[];
  /** The name the edited record had: its own reverse record follows it without asking. */
  previousName?: string;
}

/** The reverse record that points back at an A record about to be deleted. */
interface OwnPtr {
  zone: string;
  name: string;
  record: DnsRecord;
}

// Zone names as they appear in a path segment: labels of letters, digits, `-`
// and `_`, dot-separated (reverse zones like `10.10.in-addr.arpa` included).
const ZONE_NAME_RE = /^(?=.{1,253}$)[a-z0-9_-]+(\.[a-z0-9_-]+)*\.?$/i;

/**
 * IT → DNS. Read-only view over a Technitium DNS Server cluster
 * (phase 1): connection/cluster health, zones, records, query stats. Settings
 * are re-read on every request so a rotated token or a new primary URL after a
 * failover takes effect immediately.
 */
@Injectable()
export class DnsService {
  constructor(private readonly settings: SettingsService) {}

  private async config(): Promise<TechnitiumConfig | null> {
    const baseUrl = (await this.settings.get("dns.primary_url")) as string | undefined;
    const apiToken = (await this.settings.get("dns.api_token")) as string | undefined;
    const verifyTls = ((await this.settings.get("dns.verify_tls")) as boolean | undefined) ?? false;
    if (!baseUrl?.trim() || !apiToken) return null;
    return { baseUrl: baseUrl.trim().replace(/\/+$/, ""), apiToken, verifyTls };
  }

  /** The Technitium connection, or 503 when unconfigured. Shared with the IPAM sync. */
  async requireConfig(): Promise<TechnitiumConfig> {
    const cfg = await this.config();
    if (!cfg) throw new ServiceUnavailableException("DNS is not configured");
    return cfg;
  }

  /** Map a client error to the HTTP error the controller surfaces. */
  private toHttp(err: unknown): Error {
    if (err instanceof TechnitiumError) {
      return err.kind === "api"
        ? new BadGatewayException(err.message)
        : new ServiceUnavailableException(err.message);
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  /**
   * Tab badge + Overview header. Always resolves: on failure `reachable` is
   * false and `error` carries the reason.
   */
  async summary(): Promise<DnsSummary> {
    const empty: DnsSummary = {
      configured: false,
      reachable: false,
      error: null,
      version: null,
      server: null,
      clustered: false,
      nodes: null,
      zoneCount: 0,
      unreachableNodes: 0,
    };
    const cfg = await this.config();
    if (!cfg) return empty;
    try {
      const [session, zones, cluster] = await Promise.all([
        technitiumCall<TSessionInfo>(cfg, "user/session/get"),
        technitiumCall<{ zones?: TZone[] }>(cfg, "zones/list"),
        // The node list needs Administration: View; without it the rest of
        // the summary is still useful, so a refusal just means "no nodes".
        technitiumCall<TClusterState>(cfg, "admin/cluster/state").catch((err: unknown) => {
          if (err instanceof TechnitiumError && err.kind === "api") return null;
          throw err;
        }),
      ]);
      const clustered = Boolean(session.info?.clusterInitialized ?? cluster?.clusterInitialized);
      const nodes: DnsNode[] | null =
        clustered && cluster?.clusterNodes
          ? cluster.clusterNodes.map((n) => ({
              name: n.name ?? "",
              url: n.url ?? null,
              ipAddress: n.ipAddress ?? null,
              type: n.type ?? "Unknown",
              state: n.state ?? "Unknown",
              version: n.version ?? null,
              lastSeen: tsOrNull(n.lastSeen),
            }))
          : null;
      return {
        configured: true,
        reachable: true,
        error: null,
        version: session.info?.version ?? cluster?.version ?? null,
        server: session.info?.dnsServerDomain ?? cluster?.dnsServerDomain ?? null,
        clustered,
        nodes,
        zoneCount: (zones.zones ?? []).filter((z) => !z.internal).length,
        unreachableNodes: nodes ? nodes.filter((n) => !HEALTHY_NODE_STATES.has(n.state)).length : 0,
      };
    } catch (err) {
      return { ...empty, configured: true, error: (err as Error).message };
    }
  }

  /** Authoritative zones, built-in internal ones (localhost, 0.in-addr.arpa…) hidden. */
  async zones(): Promise<DnsZone[]> {
    const cfg = await this.config();
    if (!cfg) return [];
    let res: { zones?: TZone[] };
    try {
      res = await technitiumCall<{ zones?: TZone[] }>(cfg, "zones/list");
    } catch (err) {
      throw this.toHttp(err);
    }
    return (res.zones ?? [])
      .filter((z) => !z.internal && z.name)
      .map((z) => ({
        name: z.name ?? "",
        type: z.type ?? "Unknown",
        disabled: Boolean(z.disabled),
        dnssecStatus: z.dnssecStatus ?? null,
        soaSerial: typeof z.soaSerial === "number" ? z.soaSerial : null,
        lastModified: tsOrNull(z.lastModified),
        syncFailed: Boolean(z.syncFailed),
        notifyFailed: Boolean(z.notifyFailed),
        isExpired: Boolean(z.isExpired),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Every record in one zone, DNSSEC bookkeeping types hidden. */
  async records(zone: string): Promise<DnsRecord[]> {
    if (!ZONE_NAME_RE.test(zone)) throw new BadRequestException("Invalid zone name");
    const cfg = await this.requireConfig();
    let res: { records?: TRecord[] };
    try {
      res = await technitiumCall<{ records?: TRecord[] }>(cfg, "zones/records/get", {
        domain: zone,
        zone,
        listZone: true,
      });
    } catch (err) {
      throw this.toHttp(err);
    }
    return (res.records ?? [])
      .filter((r) => r.type && !HIDDEN_RECORD_TYPES.has(r.type))
      .map(toRecord)
      .sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type) || a.value.localeCompare(b.value));
  }

  // ---- record writes ----
  //
  // Technitium records have no id, so update/delete first re-read the records
  // at that name and find the one matching the caller's (name, data). That
  // lookup doubles as the audit "before" snapshot, carries the record's current
  // TTL/disabled flag (an update that omits them resets TTL to 3600 and
  // re-enables the record), and lets us refuse records the IPAM sync owns.

  async createRecord(zone: string, input: DnsRecordCreateInput): Promise<DnsRecordWriteResult> {
    const z = this.checkZone(zone);
    const fqdn = toFqdn(input.name, z);
    if (input.createPtr) checkPtrRequest(input.data, fqdn);
    const cfg = await this.requireConfig();
    // Looked at before anything is written: a reverse record that cannot be made refuses the whole request.
    const plan =
      input.createPtr && input.data.type === "A"
        ? await this.planPtr(cfg, input.data.ipAddress, fqdn, {
            forwardZone: z,
            createZone: input.createPtrZone,
            replace: input.replacePtr,
          })
        : null;
    await this.write(cfg, "zones/records/add", {
      zone: z,
      domain: fqdn,
      type: input.data.type,
      ttl: input.ttl,
      comments: input.comments || undefined,
      ...dataParams(input.data),
    });
    const ptr = plan ? await this.writePtr(cfg, plan, fqdn, input.ttl) : undefined;
    const after = await this.findRecord(cfg, z, fqdn, input.data);
    return { id: resourceId(z, fqdn, input.data.type), zone: z, before: null, after, ptr };
  }

  async updateRecord(zone: string, input: DnsRecordUpdateInput): Promise<DnsRecordWriteResult> {
    const z = this.checkZone(zone);
    const fqdn = toFqdn(input.current.name, z);
    const newFqdn = toFqdn(input.name, z);
    if (input.createPtr) checkPtrRequest(input.data, newFqdn);
    const cfg = await this.requireConfig();
    const before = await this.requireRecord(cfg, z, fqdn, input.current.data);
    const plan =
      input.createPtr && input.data.type === "A"
        ? await this.planPtr(cfg, input.data.ipAddress, newFqdn, {
            forwardZone: z,
            createZone: input.createPtrZone,
            replace: input.replacePtr,
            previousName: fqdn,
          })
        : null;
    await this.write(cfg, "zones/records/update", {
      zone: z,
      domain: fqdn,
      type: input.data.type,
      newDomain: newFqdn !== fqdn ? newFqdn : undefined,
      ttl: input.ttl,
      disable: before.disabled,
      comments: input.comments,
      ...dataParams(input.current.data),
      ...newDataParams(input.data),
    });
    let ptr: DnsPtrOutcome | undefined;
    if (plan) {
      ptr = await this.writePtr(cfg, plan, newFqdn, input.ttl);
      const old = input.current.data;
      if (!ptr.error && old.type === "A" && ptrName(old.ipAddress) !== plan.name) {
        await this.removeOldPtr(cfg, old.ipAddress, fqdn, ptr);
      }
    }
    const after = await this.findRecord(cfg, z, newFqdn, input.data);
    return { id: resourceId(z, newFqdn, input.data.type), zone: z, before, after, ptr };
  }

  async deleteRecord(zone: string, input: DnsRecordDeleteInput): Promise<DnsRecordWriteResult> {
    const z = this.checkZone(zone);
    const cfg = await this.requireConfig();
    const fqdn = toFqdn(input.name, z);
    const before = await this.requireRecord(cfg, z, fqdn, input.data);
    // Looked at first: Technitium removes a reverse record that points back at the name along with the A record.
    let own: OwnPtr | null = null;
    let lookupError: string | null = null;
    const ip = input.data.type === "A" ? input.data.ipAddress : null;
    if (ip) {
      try {
        own = await this.ownPtr(cfg, ip, fqdn);
      } catch (err) {
        // Without knowing what is there, a reverse record to be kept could not be put back.
        if (!input.removePtr) throw err;
        lookupError = (err as Error).message;
      }
    }
    await this.write(cfg, "zones/records/delete", {
      zone: z,
      domain: fqdn,
      type: input.data.type,
      ...dataParams(input.data),
    });
    let ptr: DnsPtrOutcome | undefined;
    if (own) ptr = await this.settleDeletedPtr(cfg, own, fqdn, input.removePtr);
    else if (ip && lookupError) {
      ptr = { ...emptyOutcome("", ptrName(ip), fqdn), error: `the reverse record could not be checked: ${lookupError}` };
    }
    return { id: resourceId(z, fqdn, input.data.type), zone: z, before, after: null, ptr };
  }

  // ---- reverse records ----
  //
  // Written here rather than with Technitium's own `ptr` flag, so that a reverse record the IPAM sync owns is never
  // replaced and an address change removes only the old record that pointed at the edited name.

  /** The reverse record of one address, for showing before a change. */
  async ptrState(ip: string): Promise<DnsPtrState> {
    const cfg = await this.requireConfig();
    const name = ptrName(ip);
    const { match } = await this.reverseZone(cfg, name);
    if (!match?.name) return { name, zone: null, editable: false, records: [] };
    const records = await this.ptrRecords(cfg, match.name, name);
    return {
      name,
      zone: match.name,
      editable: match.type === "Primary",
      records: records.map((r) => ({ target: r.value, managed: r.managed })),
    };
  }

  /** The hosted reverse zone that holds `name` (if any), and every zone, as Technitium lists them. */
  private async reverseZone(cfg: TechnitiumConfig, name: string): Promise<{ match: TZone | null; zones: TZone[] }> {
    let res: { zones?: TZone[] };
    try {
      res = await technitiumCall<{ zones?: TZone[] }>(cfg, "zones/list");
    } catch (err) {
      throw this.toHttp(err);
    }
    const zones = (res.zones ?? []).filter((z) => !z.internal && z.name);
    const best = reverseZoneFor(
      name,
      zones.map((z) => (z.name ?? "").toLowerCase()),
    );
    return { match: zones.find((z) => z.name?.toLowerCase() === best) ?? null, zones };
  }

  /**
   * Check that `ip` can be given a reverse record for `target`, before anything is written. A missing zone or a record
   * that points elsewhere refuses the request (`DnsPtrRefusal`) unless the caller has agreed to it.
   */
  private async planPtr(cfg: TechnitiumConfig, ip: string, target: string, consent: PtrConsent): Promise<PtrPlan> {
    const name = ptrName(ip);
    const { match, zones } = await this.reverseZone(cfg, name);
    if (!match?.name) {
      const reverseZone = name.split(".").slice(1).join(".");
      if (!consent.createZone) {
        throw refusal({
          code: "dns_ptr_zone_missing",
          message: `There is no reverse zone for ${ip}. Create ${reverseZone} (createPtrZone) or turn off the reverse record. Nothing was changed.`,
          name,
          reverseZone,
        });
      }
      // The new zone joins the same catalog as the record's zone, so a cluster's secondaries serve it too.
      const catalog = zones.find((z) => z.name?.toLowerCase() === consent.forwardZone)?.catalog || undefined;
      return { zone: reverseZone, name, existing: [], newZone: { catalog } };
    }
    if (match.type !== "Primary") {
      throw new BadRequestException(
        `The reverse zone ${match.name} is a ${(match.type ?? "read-only").toLowerCase()} zone, so it can't be edited here. Nothing was changed.`,
      );
    }
    const existing = await this.ptrRecords(cfg, match.name, name);
    if (existing.some((r) => r.managed && !pointsAt(r, target))) {
      throw new ConflictException(
        `The reverse record ${name} is managed by the IPAM sync. Release it first, or turn off the reverse record. Nothing was changed.`,
      );
    }
    const others = existing.filter(
      (r) => !pointsAt(r, target) && !(consent.previousName && pointsAt(r, consent.previousName)),
    );
    if (others.some((r) => !consent.replace.some((agreed) => pointsAt(r, agreed)))) {
      const current = others.map((r) => r.value);
      throw refusal({
        code: "dns_ptr_exists",
        message: `The reverse record ${name} already points to ${current.join(", ")}. Saving would replace it with ${target} (replacePtr). Nothing was changed.`,
        name,
        current,
        target,
      });
    }
    return { zone: match.name, name, existing };
  }

  private async ptrRecords(cfg: TechnitiumConfig, zone: string, name: string): Promise<DnsRecord[]> {
    let res: { records?: TRecord[] };
    try {
      res = await technitiumCall<{ records?: TRecord[] }>(cfg, "zones/records/get", { domain: name, zone });
    } catch (err) {
      throw this.toHttp(err);
    }
    return (res.records ?? []).map(toRecord).filter((r) => r.type === "PTR" && r.name.toLowerCase() === name);
  }

  /**
   * Point the planned reverse record at `target`, creating its zone first when the plan says so. The A record is already
   * saved by now, so a failure is reported in the outcome, not thrown.
   */
  private async writePtr(cfg: TechnitiumConfig, plan: PtrPlan, target: string, ttl: number | undefined): Promise<DnsPtrOutcome> {
    const outcome = emptyOutcome(plan.zone, plan.name, target);
    const same = plan.existing.find((r) => pointsAt(r, target));
    // The sync already keeps exactly this record: leave it as the sync's.
    if (same?.managed && plan.existing.length === 1) return outcome;
    if (plan.newZone) {
      try {
        await this.write(cfg, "zones/create", { zone: plan.zone, type: "Primary", catalog: plan.newZone.catalog });
        outcome.createdZone = true;
      } catch (err) {
        outcome.error = `the reverse zone ${plan.zone} could not be created: ${(err as Error).message}`;
        return outcome;
      }
    }
    try {
      await this.write(cfg, "zones/records/add", {
        zone: plan.zone,
        domain: plan.name,
        type: "PTR",
        ptrName: target,
        ttl,
        comments: same?.comments ?? undefined,
        overwrite: true,
      });
      outcome.replaced = plan.existing.filter((r) => !pointsAt(r, target)).map((r) => r.value);
    } catch (err) {
      outcome.error = (err as Error).message;
    }
    return outcome;
  }

  /** The reverse record in an editable zone that points back at `target`, or null. */
  private async ownPtr(cfg: TechnitiumConfig, ip: string, target: string): Promise<OwnPtr | null> {
    const name = ptrName(ip);
    const { match } = await this.reverseZone(cfg, name);
    if (!match?.name || match.type !== "Primary") return null;
    const record = (await this.ptrRecords(cfg, match.name, name)).find((r) => pointsAt(r, target));
    return record ? { zone: match.name, name, record } : null;
  }

  /**
   * After an A record was deleted: make its reverse record gone or still there, as asked. One the sync owns is always
   * kept. Technitium has usually removed it already, so keeping it means writing it again as it was.
   */
  private async settleDeletedPtr(cfg: TechnitiumConfig, own: OwnPtr, target: string, remove: boolean): Promise<DnsPtrOutcome> {
    const outcome = emptyOutcome(own.zone, own.name, target);
    const keep = !remove || own.record.managed;
    const at = { zone: own.zone, domain: own.name, type: "PTR", ptrName: own.record.value };
    try {
      const there = (await this.ptrRecords(cfg, own.zone, own.name)).some((r) => pointsAt(r, target));
      if (!keep) {
        if (there) await this.write(cfg, "zones/records/delete", at);
        outcome.removed = own.name;
      } else if (!there) {
        const kept = { ...at, ttl: own.record.ttl, comments: own.record.comments ?? undefined };
        await this.write(cfg, "zones/records/add", kept);
        if (own.record.disabled) await this.write(cfg, "zones/records/update", { ...kept, disable: true });
      }
    } catch (err) {
      const what = keep ? "was removed with the A record and could not be put back" : "could not be removed";
      outcome.error = `the reverse record ${own.name} ${what}: ${(err as Error).message}`;
    }
    return outcome;
  }

  /** After an address change: remove the old address's hand-made reverse record, if it points at the old name. */
  private async removeOldPtr(cfg: TechnitiumConfig, oldIp: string, oldTarget: string, outcome: DnsPtrOutcome): Promise<void> {
    const name = ptrName(oldIp);
    try {
      const { match: zone } = await this.reverseZone(cfg, name);
      if (!zone?.name || zone.type !== "Primary") return;
      const stale = (await this.ptrRecords(cfg, zone.name, name)).find((r) => !r.managed && pointsAt(r, oldTarget));
      if (!stale) return;
      await this.write(cfg, "zones/records/delete", { zone: zone.name, domain: name, type: "PTR", ptrName: stale.value });
      outcome.removed = name;
    } catch (err) {
      outcome.error = `the old record ${name} could not be removed: ${(err as Error).message}`;
    }
  }

  private checkZone(zone: string): string {
    if (!ZONE_NAME_RE.test(zone)) throw new BadRequestException("Invalid zone name");
    return zone.toLowerCase().replace(/\.$/, "");
  }

  /**
   * POST a write. Technitium's own refusals (record exists, zone is a
   * read-only secondary, access denied, …) are the operator's to fix, so they
   * surface as 400 with Technitium's message rather than as a gateway error.
   */
  private async write(cfg: TechnitiumConfig, path: string, params: Record<string, string | number | boolean | undefined>): Promise<void> {
    try {
      await technitiumCall<unknown>(cfg, path, params, "POST");
    } catch (err) {
      if (err instanceof TechnitiumError && err.kind === "api") throw new BadRequestException(err.message);
      throw this.toHttp(err);
    }
  }

  /** The record at `fqdn` matching `data`, or null. */
  private async findRecord(
    cfg: TechnitiumConfig,
    zone: string,
    fqdn: string,
    data: DnsRecordData,
  ): Promise<DnsRecord | null> {
    let res: { records?: TRecord[] };
    try {
      res = await technitiumCall<{ records?: TRecord[] }>(cfg, "zones/records/get", { domain: fqdn, zone });
    } catch (err) {
      throw this.toHttp(err);
    }
    const match = (res.records ?? [])
      .map(toRecord)
      .find((r) => r.name.toLowerCase() === fqdn && r.data !== null && sameData(r.data, data));
    return match ?? null;
  }

  /** Like findRecord, but 404s when missing and 409s on a sync-owned record. */
  private async requireRecord(
    cfg: TechnitiumConfig,
    zone: string,
    fqdn: string,
    data: DnsRecordData,
  ): Promise<DnsRecord> {
    const rec = await this.findRecord(cfg, zone, fqdn, data);
    if (!rec) throw new NotFoundException("Record not found; it may have been changed elsewhere. Reload and try again.");
    if (rec.managed) {
      throw new ConflictException("This record is managed by the IPAM sync. Release it before editing by hand.");
    }
    return rec;
  }

  /**
   * Query stats for the Overview. Cluster-wide (`node=cluster`) when the
   * cluster is initialised, else the single node's.
   */
  async stats(range: DnsStatsRange): Promise<DnsStats> {
    const cfg = await this.requireConfig();
    try {
      const session = await technitiumCall<TSessionInfo>(cfg, "user/session/get");
      const cluster = Boolean(session.info?.clusterInitialized);
      const res = await technitiumCall<TStats>(cfg, "dashboard/stats/get", {
        type: range,
        utc: true,
        node: cluster ? "cluster" : undefined,
      });
      const st = res.stats ?? {};
      const n = (k: string): number => Math.trunc(st[k] ?? 0);
      const top = (rows: TTopEntry[] | undefined): DnsTopEntry[] =>
        (rows ?? []).map((r) => ({ name: r.name ?? "", domain: r.domain ?? null, hits: Math.trunc(r.hits ?? 0) }));
      return {
        range,
        cluster,
        totals: {
          queries: n("totalQueries"),
          noError: n("totalNoError"),
          serverFailure: n("totalServerFailure"),
          nxDomain: n("totalNxDomain"),
          refused: n("totalRefused"),
          authoritative: n("totalAuthoritative"),
          recursive: n("totalRecursive"),
          cached: n("totalCached"),
          blocked: n("totalBlocked"),
          dropped: n("totalDropped"),
          clients: n("totalClients"),
        },
        topClients: top(res.topClients),
        topDomains: top(res.topDomains),
        topBlockedDomains: top(res.topBlockedDomains),
      };
    } catch (err) {
      throw this.toHttp(err);
    }
  }

  /**
   * Settings-page "Test connection". Falls back to saved values for anything
   * the form left out. Reports which Technitium view permissions the token is
   * missing, since a token that authenticates but can't see zones looks like
   * an empty server otherwise. Always resolves.
   */
  async testConnection(overrides: DnsTestInput): Promise<{ ok: boolean; message: string }> {
    const stored = await this.config();
    const baseUrl = (overrides.baseUrl?.trim() || stored?.baseUrl || "").replace(/\/+$/, "");
    // Empty token = the masked secret input was left as "(unchanged)".
    const apiToken = overrides.apiToken || stored?.apiToken || "";
    const verifyTls =
      typeof overrides.verifyTls === "boolean" ? overrides.verifyTls : stored?.verifyTls ?? false;
    if (!baseUrl) return { ok: false, message: "Technitium primary URL is required" };
    if (!/^https?:\/\//i.test(baseUrl)) {
      return { ok: false, message: "Technitium primary URL must start with http:// or https://" };
    }
    if (!apiToken) return { ok: false, message: "Technitium API token is required" };
    try {
      const session = await technitiumCall<TSessionInfo>(
        { baseUrl, apiToken, verifyTls },
        "user/session/get",
      );
      const info = session.info ?? {};
      const perms = info.permissions ?? {};
      const missing = ["Dashboard", "Zones", "Administration"].filter((s) => !perms[s]?.canView);
      const where = info.dnsServerDomain ?? baseUrl;
      const cluster = info.clusterInitialized
        ? `, cluster ${info.clusterDomain ?? "initialised"}`
        : ", not clustered";
      const base = `Connected to ${where} as ${session.username ?? "?"} (Technitium ${info.version ?? "?"}${cluster})`;
      if (missing.length > 0) {
        // Zones/Dashboard are required for the tab to work; Administration
        // only powers the node list.
        const fatal = missing.some((s) => s !== "Administration");
        return { ok: !fatal, message: `${base}. Token lacks View on: ${missing.join(", ")}.` };
      }
      return { ok: true, message: `${base}.` };
    } catch (err) {
      return { ok: false, message: (err as Error).message || String(err) };
    }
  }
}

function toRecord(r: TRecord): DnsRecord {
  const type = r.type ?? "";
  const comments = r.comments?.trim() ? r.comments : null;
  return {
    name: r.name ?? "",
    type,
    ttl: typeof r.ttl === "number" ? r.ttl : 0,
    value: formatRData(type, r.rData),
    disabled: Boolean(r.disabled),
    comments,
    data: parseRData(type, r.rData),
    managed: hasManagedMarker(comments),
  };
}

function checkPtrRequest(data: DnsRecordData, fqdn: string): void {
  if (data.type !== "A") throw new BadRequestException("A reverse record can only be created for an A record");
  if (fqdn.startsWith("*")) throw new BadRequestException("A wildcard name can't have a reverse record");
}

function refusal(body: DnsPtrRefusal): ConflictException {
  return new ConflictException(body);
}

function emptyOutcome(zone: string, name: string, target: string): DnsPtrOutcome {
  return { zone, name, target, replaced: [], removed: null, createdZone: false, error: null };
}

/** Does this PTR record point at `target`? */
function pointsAt(r: DnsRecord, target: string): boolean {
  return r.data !== null && sameData(r.data, { type: "PTR", ptrName: target });
}

/** Resolve a form name ("@", relative, or already inside the zone) to a lowercase FQDN. */
export function toFqdn(name: string, zone: string): string {
  const n = name.trim().toLowerCase().replace(/\.$/, "");
  if (n === "" || n === "@" || n === zone) return zone;
  return n.endsWith(`.${zone}`) ? n : `${n}.${zone}`;
}

function resourceId(zone: string, fqdn: string, type: string): string {
  return `${zone}/${fqdn}/${type}`;
}
