import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { accounts, credentials } from "../db/schema";

export interface LinkedIdentity {
  /** The Auth.js provider id: `google`, `microsoft-entra-id`. */
  provider: string;
  /** The provider's own stable id for this person. Not a secret, and only ever shown to its owner. */
  providerAccountId: string;
}

/**
 * The external sign-ins (`accounts` rows) attached to one person, and removing them.
 *
 * Adding one is Auth.js's own job (first sign-in, or "link" while signed in); this service never writes an
 * `accounts` row. What it owns is the rule for taking one away: **a person is never left with no way in**.
 * A way in is the local password (`credentials`) or another linked identity.
 */
@Injectable()
export class IdentitiesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(userId: string): Promise<{ identities: LinkedIdentity[]; hasPassword: boolean }> {
    const rows = await this.db
      .select({ provider: accounts.provider, providerAccountId: accounts.providerAccountId })
      .from(accounts)
      .where(eq(accounts.userId, userId))
      .orderBy(accounts.provider);
    const [pw] = await this.db
      .select({ userId: credentials.userId })
      .from(credentials)
      .where(eq(credentials.userId, userId))
      .limit(1);
    return { identities: rows, hasPassword: pw !== undefined };
  }

  /**
   * One statement decides and deletes, so two requests racing to remove the last two identities cannot both
   * pass a separate count check. Nothing here touches tokens or sessions: a cookie made through this identity
   * stays valid until it expires or the person signs out everywhere.
   */
  async unlink(userId: string, provider: string, providerAccountId: string): Promise<void> {
    const result = await this.db.execute(sql`
      DELETE FROM accounts
      WHERE "userId" = ${userId} AND provider = ${provider} AND "providerAccountId" = ${providerAccountId}
        AND (
          EXISTS (SELECT 1 FROM credentials WHERE user_id = ${userId})
          OR (SELECT count(*) FROM accounts other WHERE other."userId" = ${userId}) > 1
        )
      RETURNING 1
    `);
    if (rowCount(result) > 0) return;
    const [still] = await this.db
      .select({ provider: accounts.provider })
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.provider, provider), eq(accounts.providerAccountId, providerAccountId)))
      .limit(1);
    if (!still) throw new NotFoundException("That sign-in method is not linked to your account");
    throw new ConflictException(
      "This is your only way to sign in. Set a password or link another sign-in method first.",
    );
  }
}

/** Rows a raw `execute` touched, whichever shape the driver answers with. */
function rowCount(result: unknown): number {
  const r = result as { rowCount?: number | null; rows?: unknown[] };
  if (typeof r.rowCount === "number") return r.rowCount;
  return Array.isArray(r.rows) ? r.rows.length : 0;
}
