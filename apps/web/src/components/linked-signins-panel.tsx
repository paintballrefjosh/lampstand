"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";

interface IdentityRow {
  provider: string;
  providerAccountId: string;
}

const PROVIDER_NAMES: Record<string, string> = {
  google: "Google",
  "microsoft-entra-id": "Microsoft",
};

/** The last few characters of the provider's own id: enough to tell two apart, nothing a person has to know. */
function shortId(id: string): string {
  return id.length <= 6 ? id : `…${id.slice(-6)}`;
}

/**
 * The external sign-ins linked to the signed-in account (Google, Microsoft) and a way to add another.
 * `linkActions` are server-action forms from the page, one per enabled provider: Auth.js links the identity to
 * the account that is signed in, so the person need not share an email address with it. Removing the only way in
 * is refused by the API (409), and the button says so up front.
 */
export function LinkedSignInsPanel({ linkActions }: { linkActions: ReactNode }) {
  const [rows, setRows] = useState<IdentityRow[] | null>(null);
  const [hasPassword, setHasPassword] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/me/identities", { credentials: "same-origin", cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      const body = (await r.json()) as { identities: IdentityRow[]; hasPassword: boolean };
      setRows(body.identities);
      setHasPassword(body.hasPassword);
    } catch {
      setRows([]);
      setMsg({ kind: "err", text: "Could not load your linked sign-in methods." });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function unlink(row: IdentityRow) {
    const key = `${row.provider}:${row.providerAccountId}`;
    setBusy(key);
    setMsg(null);
    try {
      const url = `/api/me/identities/${encodeURIComponent(row.provider)}?id=${encodeURIComponent(row.providerAccountId)}`;
      const r = await fetch(url, { method: "DELETE", credentials: "same-origin" });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { message?: string };
        setMsg({ kind: "err", text: body.message ?? `Request failed (${r.status})` });
        return;
      }
      setMsg({ kind: "ok", text: `${PROVIDER_NAMES[row.provider] ?? row.provider} was unlinked.` });
      await load();
    } finally {
      setBusy(null);
    }
  }

  const onlyWayIn = rows !== null && !hasPassword && rows.length <= 1;

  return (
    <div className="text-sm">
      {rows === null ? <p className="text-xs text-slate-500 dark:text-slate-400">Loading…</p> : null}
      {rows !== null && rows.length === 0 ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          No external sign-in is linked. You sign in with your password.
        </p>
      ) : null}
      {rows !== null && rows.length > 0 ? (
        <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {rows.map((r) => {
            const key = `${r.provider}:${r.providerAccountId}`;
            const name = PROVIDER_NAMES[r.provider] ?? r.provider;
            return (
              <li key={key} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{name}</p>
                  <p className="truncate text-xs text-slate-500 dark:text-slate-400">account {shortId(r.providerAccountId)}</p>
                </div>
                <button
                  type="button"
                  disabled={busy !== null || onlyWayIn}
                  aria-label={`Unlink ${name} account ${shortId(r.providerAccountId)}`}
                  title={onlyWayIn ? "This is your only way to sign in" : undefined}
                  onClick={() => void unlink(r)}
                  className="shrink-0 rounded-md border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
                >
                  Unlink
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {onlyWayIn ? (
        <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
          This is your only way to sign in, so it cannot be unlinked. Link another method first
          {hasPassword ? "" : ", or ask an administrator to set you a password"}.
        </p>
      ) : null}

      {msg ? (
        <p role="status" className={`mt-2 text-xs ${msg.kind === "ok" ? "text-emerald-700 dark:text-emerald-400" : "text-rose-600"}`}>
          {msg.text}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">{linkActions}</div>
    </div>
  );
}
