import { describe, expect, it } from "vitest";
import { INBOUND_KEYS, SETTING_CATEGORY_MANAGE_PERMISSION, PERMISSIONS, blockedAddress, contactHostProblem, contactUrlProblem, findKnownSetting, validateSettingValue } from "@lampstand/shared";
import { assertMailboxHost } from "../src/tickets/ticket-inbound";

describe("contactHostProblem", () => {
  it("allows a public name, a LAN name with dots and a private address", () => {
    expect(contactHostProblem("imap.gmail.com")).toBeNull();
    expect(contactHostProblem("mail.church.lan")).toBeNull();
    expect(contactHostProblem("192.168.1.20")).toBeNull();
    expect(contactHostProblem("10.0.0.5")).toBeNull();
    expect(contactHostProblem("")).toBeNull();
  });

  it("refuses this machine, link-local (cloud metadata) and any-address, in every spelling", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "0.0.0.0", "169.254.169.254", "::1", "[::1]", "::ffff:127.0.0.1", "fe80::1"]) {
      expect(contactHostProblem(h), h).not.toBeNull();
    }
  });

  it("refuses the stack's own containers and any one-word name", () => {
    for (const h of ["api", "web", "localhost", "meilisearch", "garage", "cockroach", "cockroach1", "mailserver", "API"]) {
      expect(contactHostProblem(h), h).not.toBeNull();
    }
  });
});

describe("blockedAddress", () => {
  it("refuses this machine, link-local, any and multicast, however an IPv6 address wraps them", () => {
    for (const a of [
      "127.0.0.1", "127.255.255.254", "0.0.0.0", "169.254.169.254", "224.0.0.1", "255.255.255.255",
      "::", "::1", "[::1]", "0:0:0:0:0:0:0:1",
      "fe80::1", "febf::1", "ff02::1",
      "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe",
      "::127.0.0.1", "::7f00:1",
      "64:ff9b::7f00:1", "64:ff9b::127.0.0.1", "64:ff9b:1::1",
      "2002:7f00:1::", "2002:a9fe:a9fe::1",
      "2001:0:4136:e378:8000:63bf:3fff:fdd2",
      "fd00:ec2::254",
    ]) {
      expect(blockedAddress(a), a).toBe(true);
    }
  });

  it("lets a private LAN address and a public one through", () => {
    for (const a of ["10.0.0.5", "172.16.0.9", "192.168.1.20", "100.64.0.1", "8.8.8.8", "2606:4700:4700::1111", "fd12:3456::1", "::ffff:10.0.0.5", "64:ff9b::808:808", "2002:808:808::1"]) {
      expect(blockedAddress(a), a).toBe(false);
    }
  });

  it("does not take a name or a malformed literal for an address", () => {
    for (const a of ["example.org", "localhost", "999.1.1.1", "1:2:3", "1::2::3", "gggg::1", ""]) expect(blockedAddress(a), a).toBe(false);
  });
});

describe("contactHostProblem, numeric spellings and one-word names", () => {
  it("judges what the URL parser will connect to, not the text typed", () => {
    for (const h of ["2130706433", "0x7f.1", "127.1", "0177.0.0.1", "017700000001", "0.0.0.0", "[::ffff:7f00:1]", "LOCALHOST.", "x.localhost", "metadata.google.internal"]) {
      expect(contactHostProblem(h), h).not.toBeNull();
    }
    expect(contactHostProblem("exa mple.org")).not.toBeNull();
    expect(contactHostProblem("a/b")).not.toBeNull();
  });

  it("allowShortNames keeps a one-word LAN name working but never one of the stack's containers", () => {
    expect(contactHostProblem("pp7-mac", { allowShortNames: true })).toBeNull();
    expect(contactHostProblem("pp7-mac")).not.toBeNull();
    for (const h of ["api", "web", "proxy", "caddy", "meilisearch", "garage", "monitor", "cockroach", "cockroach-2", "localhost", "healthcheck"]) {
      expect(contactHostProblem(h, { allowShortNames: true }), h).not.toBeNull();
    }
  });
});

describe("contactUrlProblem", () => {
  it("accepts a controller on the LAN or a public name, and an empty value", () => {
    expect(contactUrlProblem("")).toBeNull();
    expect(contactUrlProblem("https://192.168.1.1")).toBeNull();
    expect(contactUrlProblem("https://dns1.int.example.org:53443")).toBeNull();
    expect(contactUrlProblem("http://unifi:8443", { allowShortNames: true })).toBeNull();
  });

  it("refuses inward addresses, other schemes and credentials", () => {
    for (const u of ["http://127.0.0.1:3001", "http://localhost:3001", "http://api:3001", "http://[::1]/", "http://169.254.169.254/", "ftp://example.org", "file:///etc/passwd", "https://user:pw@example.org", "not a url"]) {
      expect(contactUrlProblem(u, { allowShortNames: true }), u).not.toBeNull();
    }
  });
});

describe("connector settings are refused when saved", () => {
  it("ProPresenter: a plain host only, and a port in range", () => {
    expect(validateSettingValue("propresenter.host", "10.0.0.8")).toBeNull();
    expect(validateSettingValue("propresenter.host", "pp7-mac")).toBeNull();
    expect(validateSettingValue("propresenter.host", "")).toBeNull();
    // These would have let the host field choose the path of the request (analysed from the code, 2026-11-15).
    for (const h of ["api:3001/api/v1/readyz#", "api:3001", "10.0.0.8/x", "10.0.0.8?x", "u@10.0.0.8", "127.0.0.1", "api", "localhost", "http://10.0.0.8"]) {
      expect(validateSettingValue("propresenter.host", h), h).not.toBeNull();
    }
    expect(validateSettingValue("propresenter.port", 1025)).toBeNull();
    expect(validateSettingValue("propresenter.port", 0)).not.toBeNull();
    expect(validateSettingValue("propresenter.port", 70000)).not.toBeNull();
  });

  it("UniFi controller and Technitium primary: a web address that is not inward", () => {
    for (const key of ["unifi.controller_url", "dns.primary_url"]) {
      expect(validateSettingValue(key, "https://192.168.1.1"), key).toBeNull();
      expect(validateSettingValue(key, ""), key).toBeNull();
      expect(validateSettingValue(key, "http://api:3001/api/v1/readyz"), key).not.toBeNull();
      expect(validateSettingValue(key, "http://127.0.0.1:8180"), key).not.toBeNull();
      expect(validateSettingValue(key, "http://169.254.169.254/latest"), key).not.toBeNull();
    }
  });
});

describe("the mailbox host", () => {
  it("is refused when saved, before anything connects", () => {
    expect(validateSettingValue(INBOUND_KEYS.host, "127.0.0.1")).not.toBeNull();
    expect(validateSettingValue(INBOUND_KEYS.host, "api")).not.toBeNull();
    expect(validateSettingValue(INBOUND_KEYS.host, "imap.example.org")).toBeNull();
    expect(validateSettingValue(INBOUND_KEYS.host, "")).toBeNull();
    expect(validateSettingValue(INBOUND_KEYS.host, "https://imap.example.org")).not.toBeNull();
  });

  it("is refused again at connect time, including a name that resolves to loopback", async () => {
    await expect(assertMailboxHost("169.254.169.254")).rejects.toThrow(/may contact/);
    await expect(assertMailboxHost("api")).rejects.toThrow(/not allowed/);
    // localhost.localdomain-style names resolve to loopback on most systems; a name that cannot be found is also refused.
    await expect(assertMailboxHost("no-such-host.invalid")).rejects.toThrow(/Could not find/);
  });
});

describe("who manages the Helpdesk and Wiki settings", () => {
  it("is the module's own admin, not only a site admin", () => {
    expect(SETTING_CATEGORY_MANAGE_PERMISSION.helpdesk).toBe(PERMISSIONS.TICKETS_ADMIN);
    expect(SETTING_CATEGORY_MANAGE_PERMISSION.tickets).toBe(PERMISSIONS.TICKETS_ADMIN);
    expect(SETTING_CATEGORY_MANAGE_PERMISSION.wiki).toBe(PERMISSIONS.WIKI_ADMIN);
    expect(findKnownSetting("tickets.sla.warn_percent")?.category).toBe("tickets");
    expect(findKnownSetting("wiki.review.default_days")?.category).toBe("wiki");
    expect(findKnownSetting(INBOUND_KEYS.password)?.category).toBe("helpdesk");
  });
});
