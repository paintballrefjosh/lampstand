import { beforeEach, describe, expect, it, vi } from "vitest";
import { DNS_MANAGED_MARKER, dnsRecordCreateSchema, dnsRecordDeleteSchema, dnsRecordUpdateSchema } from "@lampstand/shared";
import { DnsService } from "../src/dns/dns.service";
import { technitiumCall, TechnitiumError } from "../src/dns/technitium";
import type { SettingsService } from "../src/settings/settings.service";

vi.mock("../src/dns/technitium", async (original) => ({
  ...(await original<typeof import("../src/dns/technitium")>()),
  technitiumCall: vi.fn(),
}));

interface Rec {
  zone: string;
  name: string;
  type: "A" | "PTR";
  value: string;
  comments?: string;
  ttl: number;
  disabled?: boolean;
}

const FWD = "example.org";
const REV = "2.0.192.in-addr.arpa";
const ptrAt = (octet: number) => `${octet}.${REV}`;

/** A stand-in primary: two kinds of record, and the calls the service makes. */
let zones: Array<{ name: string; type: string; catalog?: string }>;
let created: Array<Record<string, unknown>>;
let refuseZone: boolean;
let records: Rec[];
let writes: string[];
let refusePtr: boolean;

const rData = (r: Rec) => (r.type === "A" ? { ipAddress: r.value } : { ptrName: r.value });

beforeEach(() => {
  zones = [
    { name: FWD, type: "Primary" },
    { name: REV, type: "Primary" },
  ];
  records = [];
  writes = [];
  created = [];
  refusePtr = false;
  refuseZone = false;
  vi.mocked(technitiumCall).mockImplementation(async (_cfg, path, params = {}) => {
    const p = params as Record<string, string | number | boolean | undefined>;
    const name = String(p.domain);
    const value = String(p.ipAddress ?? p.ptrName);
    if (path === "zones/list") return { zones } as never;
    if (path === "zones/records/get") {
      return { records: records.filter((r) => r.name === name).map((r) => ({ ...r, rData: rData(r) })) } as never;
    }
    if (path === "zones/create") {
      if (refuseZone) throw new TechnitiumError("Access was denied.", "api");
      created.push(p);
      zones.push({ name: String(p.zone), type: String(p.type) });
      return {} as never;
    }
    if (refusePtr && p.type === "PTR") throw new TechnitiumError("Access was denied.", "api");
    writes.push(`${path.split("/").pop()} ${p.type} ${name}`);
    const type = p.type as Rec["type"];
    const same = (r: Rec) => r.name === name && r.type === type && r.value === value;
    if (path === "zones/records/delete") {
      records = records.filter((r) => !same(r));
      if (type === "A") records = records.filter((r) => !(r.type === "PTR" && r.value === name && r.name.startsWith(`${value.split(".")[3]}.`)));
    }
    if (path === "zones/records/add") {
      if (p.overwrite) records = records.filter((r) => !(r.name === name && r.type === type));
      records.push({ zone: String(p.zone), name, type, value, comments: p.comments as string | undefined, ttl: Number(p.ttl ?? 3600) });
    }
    if (path === "zones/records/update") {
      const r = records.find(same)!;
      r.name = String(p.newDomain ?? name);
      r.value = String(p.newIpAddress ?? r.value);
      if (p.disable !== undefined) r.disabled = Boolean(p.disable);
    }
    return {} as never;
  });
});

const service = new DnsService({
  get: async (key: string) => ({ "dns.primary_url": "http://dns.test", "dns.api_token": "t" })[key],
} as unknown as SettingsService);

interface Consent {
  replacePtr?: string[];
  createPtrZone?: boolean;
}

const create = (name: string, ip: string, createPtr = true, consent: Consent = {}) =>
  service.createRecord(
    FWD,
    dnsRecordCreateSchema.parse({ name, ttl: 300, data: { type: "A", ipAddress: ip }, createPtr, ...consent }),
  );

const remove = (name: string, ip: string, removePtr?: boolean) =>
  service.deleteRecord(FWD, dnsRecordDeleteSchema.parse({ name, data: { type: "A", ipAddress: ip }, removePtr }));

/** The body of a refused request. */
const refused = (request: Promise<unknown>) =>
  request.then(
    () => {
      throw new Error("was not refused");
    },
    (err: { getResponse: () => unknown }) => err.getResponse(),
  );

const update = (from: [string, string], to: [string, string], createPtr = true, consent: Consent = {}) =>
  service.updateRecord(
    FWD,
    dnsRecordUpdateSchema.parse({
      current: { name: from[0], data: { type: "A", ipAddress: from[1] } },
      name: to[0],
      ttl: 300,
      data: { type: "A", ipAddress: to[1] },
      createPtr,
      ...consent,
    }),
  );

const ptrs = () => records.filter((r) => r.type === "PTR").map((r) => `${r.name} -> ${r.value}`).sort();
const ptr = (octet: number, value: string, comments?: string): Rec => ({ zone: REV, name: ptrAt(octet), type: "PTR", value, comments, ttl: 3600 });
const a = (name: string, ip: string): Rec => ({ zone: FWD, name: `${name}.${FWD}`, type: "A", value: ip, ttl: 300 });

describe("reverse records for hand-made A records", () => {
  it("is off unless asked for", async () => {
    expect(dnsRecordCreateSchema.parse({ name: "one", data: { type: "A", ipAddress: "192.0.2.10" } }).createPtr).toBe(false);
    const res = await create("one", "192.0.2.10", false);
    expect(res.ptr).toBeUndefined();
    expect(ptrs()).toEqual([]);
  });

  it("creates the PTR with the A record's TTL", async () => {
    const res = await create("one", "192.0.2.10");
    expect(res.ptr).toEqual({
      zone: REV,
      name: ptrAt(10),
      target: "one.example.org",
      replaced: [],
      removed: null,
      createdZone: false,
      error: null,
    });
    expect(ptrs()).toEqual([`${ptrAt(10)} -> one.example.org`]);
    expect(records.find((r) => r.type === "PTR")?.ttl).toBe(300);
  });

  it("asks before overwriting a PTR, showing the current value", async () => {
    records = [ptr(10, "old.example.org")];
    expect(await refused(create("one", "192.0.2.10"))).toMatchObject({
      code: "dns_ptr_exists",
      name: ptrAt(10),
      current: ["old.example.org"],
      target: "one.example.org",
    });
    expect(writes).toEqual([]);
    const res = await create("one", "192.0.2.10", true, { replacePtr: ["old.example.org"] });
    expect(res.ptr?.replaced).toEqual(["old.example.org"]);
    expect(ptrs()).toEqual([`${ptrAt(10)} -> one.example.org`]);
  });

  it("asks again when the value is no longer the one agreed to", async () => {
    records = [ptr(10, "newer.example.org")];
    expect(await refused(create("one", "192.0.2.10", true, { replacePtr: ["old.example.org"] }))).toMatchObject({
      current: ["newer.example.org"],
    });
    expect(writes).toEqual([]);
  });

  it("asks before creating a missing reverse zone", async () => {
    expect(await refused(create("one", "198.51.100.7"))).toMatchObject({
      code: "dns_ptr_zone_missing",
      reverseZone: "100.51.198.in-addr.arpa",
    });
    expect(writes).toEqual([]);
    expect(created).toEqual([]);
  });

  it("creates the zone when agreed, in the forward zone's catalog", async () => {
    zones[0]!.catalog = "cluster.example";
    const res = await create("one", "198.51.100.7", true, { createPtrZone: true });
    expect(created).toEqual([{ zone: "100.51.198.in-addr.arpa", type: "Primary", catalog: "cluster.example" }]);
    expect(res.ptr).toMatchObject({ createdZone: true, error: null });
    expect(ptrs()).toEqual(["7.100.51.198.in-addr.arpa -> one.example.org"]);
  });

  it("creates no zone unless a reverse record was asked for", async () => {
    await create("one", "198.51.100.7", false, { createPtrZone: true });
    expect(created).toEqual([]);
  });

  it("keeps the A record and reports a zone that could not be created", async () => {
    refuseZone = true;
    const res = await create("one", "198.51.100.7", true, { createPtrZone: true });
    expect(res.after?.value).toBe("198.51.100.7");
    expect(res.ptr).toMatchObject({ createdZone: false, error: expect.stringContaining("could not be created") });
    expect(ptrs()).toEqual([]);
  });

  it("writes nothing when the reverse zone is a secondary", async () => {
    zones[1]!.type = "Secondary";
    await expect(create("one", "192.0.2.10")).rejects.toThrow(/secondary zone/);
    expect(writes).toEqual([]);
  });

  it("writes nothing when the sync owns a PTR pointing elsewhere", async () => {
    records = [ptr(10, "synced.example.org", DNS_MANAGED_MARKER)];
    await expect(create("one", "192.0.2.10")).rejects.toThrow(/managed by the IPAM sync/);
    expect(writes).toEqual([]);
  });

  it("leaves a sync-owned PTR that already points at the name", async () => {
    records = [ptr(10, "one.example.org", DNS_MANAGED_MARKER)];
    const res = await create("one", "192.0.2.10");
    expect(res.ptr?.error).toBeNull();
    expect(writes).toEqual([`add A one.${FWD}`]);
  });

  it("keeps the A record and reports a refused PTR", async () => {
    refusePtr = true;
    const res = await create("one", "192.0.2.10");
    expect(res.after?.value).toBe("192.0.2.10");
    expect(res.ptr?.error).toBe("Access was denied.");
  });

  it("refuses wildcard names and other record types", async () => {
    await expect(create("*.lab", "192.0.2.10")).rejects.toThrow(/wildcard/);
    await expect(
      service.createRecord(FWD, dnsRecordCreateSchema.parse({ name: "x", data: { type: "CNAME", cname: "y.example.org" }, createPtr: true })),
    ).rejects.toThrow(/only be created for an A record/);
    expect(writes).toEqual([]);
  });

  it("moves the PTR when the address changes", async () => {
    records = [a("one", "192.0.2.10"), ptr(10, "one.example.org")];
    const res = await update(["one", "192.0.2.10"], ["one", "192.0.2.11"]);
    expect(res.ptr?.removed).toBe(ptrAt(10));
    expect(ptrs()).toEqual([`${ptrAt(11)} -> one.example.org`]);
  });

  it("asks before an edit overwrites another name's PTR", async () => {
    records = [a("one", "192.0.2.10"), ptr(11, "other.example.org")];
    expect(await refused(update(["one", "192.0.2.10"], ["one", "192.0.2.11"]))).toMatchObject({
      current: ["other.example.org"],
    });
    expect(writes).toEqual([]);
  });

  it("follows a rename at the same address without asking", async () => {
    records = [a("one", "192.0.2.10"), ptr(10, "one.example.org")];
    const res = await update(["one", "192.0.2.10"], ["two", "192.0.2.10"]);
    expect(res.ptr).toMatchObject({ replaced: ["one.example.org"], removed: null, error: null });
    expect(ptrs()).toEqual([`${ptrAt(10)} -> two.example.org`]);
  });

  it.each([
    ["another name's", ptr(10, "other.example.org")],
    ["the sync's", ptr(10, "one.example.org", DNS_MANAGED_MARKER)],
  ])("leaves %s PTR at the old address", async (_label, old) => {
    records = [a("one", "192.0.2.10"), old];
    const res = await update(["one", "192.0.2.10"], ["one", "192.0.2.11"]);
    expect(res.ptr?.removed).toBeNull();
    expect(ptrs()).toHaveLength(2);
  });

  it("does not touch the old PTR when the new one is refused", async () => {
    records = [a("one", "192.0.2.10"), ptr(10, "one.example.org")];
    refusePtr = true;
    const res = await update(["one", "192.0.2.10"], ["one", "192.0.2.11"]);
    expect(res.ptr?.error).toBe("Access was denied.");
    expect(ptrs()).toEqual([`${ptrAt(10)} -> one.example.org`]);
  });

  it("leaves PTRs alone on an edit with the switch off", async () => {
    records = [a("one", "192.0.2.10"), ptr(10, "one.example.org")];
    await update(["one", "192.0.2.10"], ["one", "192.0.2.11"], false);
    expect(ptrs()).toEqual([`${ptrAt(10)} -> one.example.org`]);
  });

  describe("deleting", () => {
    beforeEach(() => {
      records = [a("one", "192.0.2.10"), ptr(10, "one.example.org", "by hand")];
    });

    it("removes the record's PTR by default", async () => {
      const res = await remove("one", "192.0.2.10");
      expect(res.ptr).toMatchObject({ removed: ptrAt(10), error: null });
      expect(records).toEqual([]);
    });

    it("puts the PTR back as it was when it is to be kept", async () => {
      records[1]!.ttl = 900;
      records[1]!.disabled = true;
      const res = await remove("one", "192.0.2.10", false);
      expect(res.ptr).toMatchObject({ removed: null, error: null });
      expect(records).toEqual([expect.objectContaining({ type: "PTR", ttl: 900, comments: "by hand", disabled: true })]);
    });

    it("always keeps a PTR the sync owns", async () => {
      records[1]!.comments = DNS_MANAGED_MARKER;
      const res = await remove("one", "192.0.2.10");
      expect(res.ptr?.removed).toBeNull();
      expect(ptrs()).toEqual([`${ptrAt(10)} -> one.example.org`]);
    });

    it("leaves another name's PTR out of it", async () => {
      records[1]!.value = "other.example.org";
      const res = await remove("one", "192.0.2.10");
      expect(res.ptr).toBeUndefined();
      expect(ptrs()).toEqual([`${ptrAt(10)} -> other.example.org`]);
    });

    it("says so when a PTR to be kept cannot be written back", async () => {
      refusePtr = true;
      const res = await remove("one", "192.0.2.10", false);
      expect(res.ptr?.error).toContain("could not be put back");
    });

    it("reports the reverse record of an address for the dialog", async () => {
      expect(await service.ptrState("192.0.2.10")).toEqual({
        name: ptrAt(10),
        zone: REV,
        editable: true,
        records: [{ target: "one.example.org", managed: false }],
      });
      expect(await service.ptrState("198.51.100.7")).toMatchObject({ zone: null, records: [] });
    });
  });
});
