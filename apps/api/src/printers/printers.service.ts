import {
  Injectable,
  Inject,
  NotFoundException,
  Logger,
  type OnModuleInit,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { printers } from "../db/schema";
import { SettingsService } from "../settings/settings.service";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import type {
  CreatePrinterInput,
  UpdatePrinterInput,
  Printer,
  PrinterStatus,
  PrinterSummary,
} from "@lampstand/shared";
import { probePrinterSnmp } from "./snmp";
import { probeFieryQueue } from "./fiery";
import { checkLocation } from "../assets/locations.service";
import { UnreadableSecretError, encryptSecret } from "../settings/crypto";
import {
  DEVICE_SECRET_PLACEHOLDER,
  needsSealing,
  openDeviceSecret,
  presentDeviceSecret,
  sealDeviceSecretCreate,
  sealDeviceSecretUpdate,
} from "../settings/device-secret";

/**
 * Defaults if no settings rows exist yet. Reseeding is idempotent so these are
 * just bootstrap-time fallbacks.
 */
const FALLBACK_SNMP_VERSION = "v2c";
const FALLBACK_SNMP_COMMUNITY = "public";
const FALLBACK_SNMP_TIMEOUT_MS = 3000;
const FALLBACK_POLL_INTERVAL_MIN = 5;
const FALLBACK_FIERY_TIMEOUT_MS = 5000;

@Injectable()
export class PrintersService implements OnModuleInit {
  private readonly logger = new Logger(PrintersService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly jobs: ClusterJobs,
  ) {}

  // ---- lifecycle: background poller ----

  async onModuleInit(): Promise<void> {
    const minutes = await this.getNumberSetting(
      "printers.poll_interval_min",
      FALLBACK_POLL_INTERVAL_MIN,
    );
    // Skip the first 30s after boot so we don't block the readiness probe.
    // A cluster job, so only one node polls at a time.
    this.jobs.register({
      name: "printers-poll",
      everyMs: Math.max(60_000, minutes * 60_000),
      initialDelayMs: 30_000,
      run: () => this.pollAll(),
    });
  }

  // ---- CRUD ----

  async list(): Promise<Printer[]> {
    const rows = await this.db.select().from(printers);
    return rows.map(toPrinter);
  }

  async getById(id: string): Promise<Printer> {
    const [row] = await this.db.select().from(printers).where(eq(printers.id, id)).limit(1);
    if (!row) throw new NotFoundException("Printer not found");
    return toPrinter(row);
  }

  async create(input: CreatePrinterInput): Promise<Printer> {
    const [row] = await this.db
      .insert(printers)
      .values({
        name: input.name.trim(),
        host: input.host.trim(),
        kind: input.kind,
        snmpPort: input.snmpPort,
        snmpVersion: input.snmpVersion,
        snmpCommunity: sealDeviceSecretCreate(input.snmpCommunity),
        fieryApiUrl: input.fieryApiUrl,
        fieryApiKey: sealDeviceSecretCreate(input.fieryApiKey),
        notes: input.notes ?? null,
        locationId: (await checkLocation(this.db, input.locationId)) ?? null,
      })
      .returning();
    if (!row) throw new Error("Insert failed");
    return toPrinter(row);
  }

  async update(id: string, input: UpdatePrinterInput): Promise<Printer> {
    await this.getById(id);
    const patch: Partial<typeof printers.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.host !== undefined) patch.host = input.host.trim();
    if (input.kind !== undefined) patch.kind = input.kind;
    if (input.snmpPort !== undefined) patch.snmpPort = input.snmpPort;
    if (input.snmpVersion !== undefined) patch.snmpVersion = input.snmpVersion;
    const community = sealDeviceSecretUpdate(input.snmpCommunity);
    if (community !== undefined) patch.snmpCommunity = community;
    if (input.fieryApiUrl !== undefined) patch.fieryApiUrl = input.fieryApiUrl;
    const fieryKey = sealDeviceSecretUpdate(input.fieryApiKey);
    if (fieryKey !== undefined) patch.fieryApiKey = fieryKey;
    if (input.notes !== undefined) patch.notes = input.notes;
    if (input.locationId !== undefined) patch.locationId = (await checkLocation(this.db, input.locationId)) ?? null;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    const [row] = await this.db.update(printers).set(patch).where(eq(printers.id, id)).returning();
    return toPrinter(row!);
  }

  async delete(id: string): Promise<{ ok: true }> {
    const [row] = await this.db.delete(printers).where(eq(printers.id, id)).returning();
    if (!row) throw new NotFoundException("Printer not found");
    return { ok: true };
  }

  async summary(): Promise<PrinterSummary> {
    const rows = await this.db
      .select({ status: printers.lastStatus, count: sql<number>`count(*)::int` })
      .from(printers)
      .groupBy(printers.lastStatus);
    const out: PrinterSummary = { green: 0, yellow: 0, red: 0, unknown: 0, total: 0 };
    for (const r of rows) {
      const c = Number(r.count) || 0;
      out.total += c;
      if (r.status === "green" || r.status === "yellow" || r.status === "red" || r.status === "unknown") {
        out[r.status] += c;
      }
    }
    return out;
  }

  // ---- polling ----

  async pollOne(id: string): Promise<Printer> {
    const [printer] = await this.db.select().from(printers).where(eq(printers.id, id)).limit(1);
    if (!printer) throw new NotFoundException("Printer not found");
    if (!printer.enabled) {
      // Don't probe disabled printers; just return current snapshot.
      return toPrinter(printer);
    }
    let savedCommunity: string | null;
    let fieryApiKey: string;
    try {
      savedCommunity = openDeviceSecret(printer.snmpCommunity, "SNMP community");
      fieryApiKey = openDeviceSecret(printer.fieryApiKey, "Fiery API key") ?? "";
    } catch (err) {
      if (!(err instanceof UnreadableSecretError)) throw err;
      const [row] = await this.db
        .update(printers)
        .set({ lastStatus: "unknown", lastCheckedAt: new Date(), lastError: err.message, updatedAt: new Date() })
        .where(eq(printers.id, id))
        .returning();
      return toPrinter(row!);
    }

    const snmpTimeout = await this.getNumberSetting(
      "printers.snmp_timeout_ms",
      FALLBACK_SNMP_TIMEOUT_MS,
    );
    const community =
      savedCommunity ??
      (await this.getStringSetting("printers.default_snmp_community", FALLBACK_SNMP_COMMUNITY));
    const versionRaw =
      printer.snmpVersion ??
      (await this.getStringSetting("printers.default_snmp_version", FALLBACK_SNMP_VERSION));
    const version: "v1" | "v2c" = versionRaw === "v1" ? "v1" : "v2c";

    const snmpResult = await probePrinterSnmp({
      host: printer.host,
      port: printer.snmpPort,
      community,
      version,
      timeoutMs: snmpTimeout,
    });

    // Fiery probe — only attempted if printer is reachable + kind=fiery + key set.
    let fieryQueueDepth: number | null = printer.fieryQueueDepth;
    let lastError = snmpResult.error ?? null;
    if (
      printer.kind === "fiery" &&
      snmpResult.status !== "red" &&
      printer.fieryApiUrl
    ) {
      const fieryTimeout = await this.getNumberSetting(
        "printers.fiery_timeout_ms",
        FALLBACK_FIERY_TIMEOUT_MS,
      );
      const fiery = await probeFieryQueue({
        apiUrl: printer.fieryApiUrl,
        apiKey: fieryApiKey,
        timeoutMs: fieryTimeout,
      });
      fieryQueueDepth = fiery.queueDepth;
      if (fiery.error) {
        // Surface as a non-fatal error suffix; SNMP-derived status keeps the lead.
        lastError = lastError ? `${lastError}; ${fiery.error}` : fiery.error;
      }
    } else if (printer.kind !== "fiery") {
      fieryQueueDepth = null;
    }

    const [row] = await this.db
      .update(printers)
      .set({
        lastStatus: snmpResult.status,
        lastCheckedAt: new Date(),
        lastError,
        supplies: snmpResult.supplies as never,
        inputs: snmpResult.inputs as never,
        alerts: snmpResult.alerts as never,
        fieryQueueDepth,
        updatedAt: new Date(),
      })
      .where(eq(printers.id, id))
      .returning();
    return toPrinter(row!);
  }

  async pollAll(): Promise<void> {
    await this.sealLegacySecrets().catch((err: unknown) => this.logger.warn(`could not encrypt saved printer credentials: ${(err as Error).message}`));
    const rows = await this.db.select({ id: printers.id }).from(printers).where(eq(printers.enabled, true));
    // Concurrency-limit so we don't fan out 50 sockets at once.
    const limit = 5;
    let idx = 0;
    const workers = Array.from({ length: Math.min(limit, rows.length) }, async () => {
      while (idx < rows.length) {
        const target = rows[idx++]!;
        try {
          await this.pollOne(target.id);
        } catch (err) {
          this.logger.warn(`pollOne(${target.id}) failed: ${(err as Error).message}`);
        }
      }
    });
    await Promise.all(workers);
  }

  /**
   * Credentials saved in plain text (before they were encrypted, or restored from an older backup) are encrypted in
   * place. Each UPDATE names the plain value it replaces, so two nodes doing this at once cannot undo each other.
   */
  async sealLegacySecrets(): Promise<number> {
    const rows = await this.db
      .select({ id: printers.id, snmpCommunity: printers.snmpCommunity, fieryApiKey: printers.fieryApiKey })
      .from(printers);
    let sealed = 0;
    for (const r of rows) {
      if (needsSealing(r.snmpCommunity)) {
        await this.db
          .update(printers)
          .set({ snmpCommunity: encryptSecret(r.snmpCommunity) })
          .where(and(eq(printers.id, r.id), eq(printers.snmpCommunity, r.snmpCommunity)));
        sealed++;
      }
      if (needsSealing(r.fieryApiKey)) {
        await this.db
          .update(printers)
          .set({ fieryApiKey: encryptSecret(r.fieryApiKey) })
          .where(and(eq(printers.id, r.id), eq(printers.fieryApiKey, r.fieryApiKey)));
        sealed++;
      }
    }
    return sealed;
  }

  /**
   * Ad-hoc SNMP probe for the printer Add/Edit dialog's "Test connection"
   * button. Uses the per-printer values supplied in the body, with the global
   * defaults from the settings table filling in anything left blank. The edit
   * dialog shows a saved community as "[saved]"; testing with that sends the
   * printer's id, and the saved value is used.
   */
  async testConnection(opts: {
    host: string;
    port?: number;
    version?: "v1" | "v2c";
    community?: string;
    printerId?: string;
    timeoutMs?: number;
  }): Promise<{
    ok: boolean;
    message: string;
    status?: string;
    supplies?: number;
    inputs?: number;
    alerts?: number;
  }> {
    if (!opts.host?.trim()) return { ok: false, message: "Host is required" };
    const port = opts.port ?? 161;
    const defaultsCommunity = await this.getStringSetting(
      "printers.default_snmp_community",
      FALLBACK_SNMP_COMMUNITY,
    );
    const defaultVersion = await this.getStringSetting(
      "printers.default_snmp_version",
      FALLBACK_SNMP_VERSION,
    );
    const defaultTimeout = await this.getNumberSetting(
      "printers.snmp_timeout_ms",
      FALLBACK_SNMP_TIMEOUT_MS,
    );
    let typed = opts.community?.trim() ?? "";
    if (typed === DEVICE_SECRET_PLACEHOLDER) {
      const [row] = opts.printerId
        ? await this.db.select({ snmpCommunity: printers.snmpCommunity }).from(printers).where(eq(printers.id, opts.printerId)).limit(1)
        : [];
      if (!row) return { ok: false, message: "Type the community to test it." };
      try {
        typed = openDeviceSecret(row.snmpCommunity, "SNMP community") ?? "";
      } catch (err) {
        if (err instanceof UnreadableSecretError) return { ok: false, message: err.message };
        throw err;
      }
    }
    const community = typed || defaultsCommunity;
    const version = (opts.version ?? (defaultVersion === "v1" ? "v1" : "v2c")) as "v1" | "v2c";
    const timeoutMs = opts.timeoutMs ?? defaultTimeout;

    const result = await probePrinterSnmp({
      host: opts.host.trim(),
      port,
      community,
      version,
      timeoutMs,
    });
    if (result.error) {
      return { ok: false, message: `SNMP probe failed: ${result.error}` };
    }
    return {
      ok: true,
      message: `Reached ${opts.host}:${port} over SNMP ${version} (status ${result.status})`,
      status: result.status,
      supplies: result.supplies.length,
      inputs: result.inputs.length,
      alerts: result.alerts.length,
    };
  }

  // ---- helpers ----

  private async getStringSetting(key: string, fallback: string): Promise<string> {
    const raw = await this.settings.get(key);
    return typeof raw === "string" && raw.length > 0 ? raw : fallback;
  }

  private async getNumberSetting(key: string, fallback: number): Promise<number> {
    const raw = await this.settings.get(key);
    return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
  }
}

function toPrinter(row: typeof printers.$inferSelect): Printer {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    kind: row.kind as Printer["kind"],
    snmpPort: row.snmpPort,
    snmpVersion: (row.snmpVersion as Printer["snmpVersion"]) ?? null,
    snmpCommunity: presentDeviceSecret(row.snmpCommunity),
    fieryApiUrl: row.fieryApiUrl ?? null,
    fieryApiKey: presentDeviceSecret(row.fieryApiKey),
    enabled: row.enabled,
    notes: row.notes ?? null,
    locationId: row.locationId ?? null,
    lastStatus: row.lastStatus as PrinterStatus,
    lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
    lastError: row.lastError ?? null,
    supplies: (row.supplies as Printer["supplies"]) ?? [],
    inputs: (row.inputs as Printer["inputs"]) ?? [],
    alerts: (row.alerts as Printer["alerts"]) ?? [],
    fieryQueueDepth: row.fieryQueueDepth ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
