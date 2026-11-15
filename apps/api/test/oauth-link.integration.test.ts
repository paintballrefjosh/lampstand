import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { IdentitiesService } from "../src/auth/identities.service";
import { UsersService } from "../src/users/users.service";
import * as schema from "../src/db/schema";

/**
 * Linking external sign-ins to existing accounts, against a real database (setup: db-stores.integration.test.ts).
 * It only creates and deletes rows of its own `link-*@test.local` users and one test group.
 *   1. Removing an identity never leaves a person with no way in, also when two removals race.
 *   2. A first sign-in (a fresh random id) is judged against the account an admin already made for that address:
 *      deleted and disabled ones are refused, and "already in a group" stands. Decisions only: nothing is written.
 */
const url = process.env.TEST_DATABASE_URL;
const EMAILS = ["link-pw@test.local", "link-two@test.local", "link-one@test.local", "link-race@test.local", "link-other@test.local", "link-owner@test.local",
  "link-pre@test.local", "link-gone@test.local", "link-off@test.local", "link-nogroup@test.local", "link-new@test.local"];
const RANDOM_ID = "11111111-2222-4333-8444-555555555555";

describe.skipIf(!url)("linking external sign-ins against a real database", () => {
  let pool: Pool;
  let identities: IdentitiesService;
  let provisioning: UsersService;
  let settingsValues: Record<string, unknown> = {};
  let groupId = "";
  const q = (text: string, params: unknown[] = []) => pool.query(text, params);
  const mk = async (email: string) =>
    (await q(`INSERT INTO users (email) VALUES ($1) RETURNING id`, [email])).rows[0].id as string;
  const link = (userId: string, provider: string, id: string) =>
    q(`INSERT INTO accounts ("userId", type, provider, "providerAccountId") VALUES ($1, 'oidc', $2, $3)`, [userId, provider, id]);
  const password = (userId: string) => q(`INSERT INTO credentials (user_id, password_hash) VALUES ($1, 'x')`, [userId]);
  const wipe = () => q(`DELETE FROM users WHERE email = ANY($1)`, [EMAILS]);

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 5 });
    const db = drizzle(pool, { schema });
    await wipe();
    await q(`DELETE FROM groups WHERE name = 'link-test-group'`);
    groupId = (await q(`INSERT INTO groups (name) VALUES ('link-test-group') RETURNING id`)).rows[0].id;
    identities = new IdentitiesService(db as never);
    const settings = { get: async (k: string) => settingsValues[k] };
    const auth = { invalidateUser: () => undefined };
    provisioning = new UsersService(db as never, auth as never, settings as never, {} as never, {} as never, {} as never, {} as never);
  });
  afterAll(async () => {
    await wipe().catch(() => undefined);
    await q(`DELETE FROM groups WHERE name = 'link-test-group'`).catch(() => undefined);
    await pool?.end();
  });

  describe("removing an identity", () => {
    it("is allowed while a local password remains", async () => {
      const u = await mk("link-pw@test.local");
      await password(u);
      await link(u, "google", "g-pw-1");
      await identities.unlink(u, "google", "g-pw-1");
      expect((await identities.list(u)).identities).toEqual([]);
    });

    it("is allowed while another identity remains, and refused for the last one", async () => {
      const u = await mk("link-two@test.local");
      await link(u, "google", "g-two-1");
      await link(u, "microsoft-entra-id", "m-two-1");
      await identities.unlink(u, "google", "g-two-1");
      await expect(identities.unlink(u, "microsoft-entra-id", "m-two-1")).rejects.toBeInstanceOf(ConflictException);
      expect((await identities.list(u)).identities).toHaveLength(1);
    });

    it("refuses the only way in for an account with no password", async () => {
      const u = await mk("link-one@test.local");
      await link(u, "google", "g-one-1");
      await expect(identities.unlink(u, "google", "g-one-1")).rejects.toBeInstanceOf(ConflictException);
      expect((await identities.list(u)).hasPassword).toBe(false);
    });

    it("leaves exactly one identity when the last two are removed at once", async () => {
      const u = await mk("link-race@test.local");
      await link(u, "google", "g-race-1");
      await link(u, "google", "g-race-2");
      const results = await Promise.allSettled([
        identities.unlink(u, "google", "g-race-1"),
        identities.unlink(u, "google", "g-race-2"),
      ]);
      expect((await identities.list(u)).identities).toHaveLength(1);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    });

    it("answers 404 for an identity that is not this person's, even when it exists on another account", async () => {
      const mine = await mk("link-other@test.local");
      const owner = await mk("link-owner@test.local");
      await password(mine);
      await link(owner, "microsoft-entra-id", "m-owner-1");
      await expect(identities.unlink(mine, "microsoft-entra-id", "m-owner-1")).rejects.toBeInstanceOf(NotFoundException);
      expect((await identities.list(owner)).identities).toHaveLength(1);
    });
  });

  describe("a first sign-in is judged against the account already made for that address", () => {
    // Domain-locked, no external approval: a stranger from outside the domain is refused ("rejected").
    const lockedToDomain = () => {
      settingsValues = { "google.workspace_domain": "church.org", "google.allow_external_with_approval": false };
    };
    const firstSignIn = (email: string) =>
      provisioning.provisionOAuthUser({ userId: RANDOM_ID, email, provider: "google", hostedDomain: "" });

    it("lets an admin-made account with a group in, whatever its domain: the admin's decision stands", async () => {
      lockedToDomain();
      const u = await mk("link-pre@test.local");
      await q(`INSERT INTO group_memberships (group_id, user_id) VALUES ($1, $2)`, [groupId, u]);
      expect((await firstSignIn("Link-Pre@Test.Local")).status).toBe("approved");
    });

    it("still refuses an address with no account and no right to be there", async () => {
      lockedToDomain();
      expect((await firstSignIn("link-new@test.local")).status).toBe("rejected");
    });

    it("refuses a soft-deleted account instead of attaching a sign-in to it", async () => {
      lockedToDomain();
      const u = await mk("link-gone@test.local");
      await q(`UPDATE users SET deleted_at = now(), is_active = false WHERE id = $1`, [u]);
      expect((await firstSignIn("link-gone@test.local")).status).toBe("deleted");
    });

    it("refuses a disabled account", async () => {
      lockedToDomain();
      const u = await mk("link-off@test.local");
      await q(`INSERT INTO group_memberships (group_id, user_id) VALUES ($1, $2)`, [groupId, u]);
      await q(`UPDATE users SET is_active = false WHERE id = $1`, [u]);
      expect((await firstSignIn("link-off@test.local")).status).toBe("rejected");
    });

    it("writes nothing for the account it only looked up (the link has not happened yet)", async () => {
      settingsValues = { "google.workspace_domain": "test.local", "google.allow_external_with_approval": false };
      const u = await mk("link-nogroup@test.local");
      const r = await provisioning.provisionOAuthUser({ userId: RANDOM_ID, email: "link-nogroup@test.local", provider: "google" });
      expect(r.status).toBe("approved");
      const memberships = (await q(`SELECT 1 FROM group_memberships WHERE user_id = $1`, [u])).rows;
      expect(memberships).toHaveLength(0);
    });
  });
});
