"use client";

import { useCallback, useEffect, useState } from "react";
import { SHOW_ALL_HOSTS, parseHostFilter, type HostFilter } from "@/lib/host-filter";

const STORAGE_KEY = "lampstand.infraHostFilter";

const SWITCHES: ReadonlyArray<{ key: keyof HostFilter; label: string }> = [
  { key: "down", label: "Down hosts" },
  { key: "disabled", label: "Disabled hosts" },
  { key: "up", label: "Up hosts" },
];

/** The overview's host filter, remembered in this browser. */
export function useHostFilter(): [HostFilter, (key: keyof HostFilter, show: boolean) => void] {
  const [filter, setFilter] = useState<HostFilter>(SHOW_ALL_HOSTS);

  useEffect(() => {
    try {
      setFilter(parseHostFilter(window.localStorage.getItem(STORAGE_KEY)));
    } catch {
      /* storage blocked: everything shows */
    }
  }, []);

  const set = useCallback((key: keyof HostFilter, show: boolean) => {
    setFilter((prev) => {
      const next = { ...prev, [key]: show };
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* not remembered, still applied */
      }
      return next;
    });
  }, []);

  return [filter, set];
}

/** The "Filter hosts" tile: a switch per kind of host, on = shown. */
export function HostFilterCard({
  filter,
  hidden,
  onChange,
}: {
  filter: HostFilter;
  /** How many hosts the switches are hiding now. */
  hidden: number;
  onChange: (key: keyof HostFilter, show: boolean) => void;
}) {
  return (
    <div
      role="group"
      aria-labelledby="host-filter-label"
      className="rounded-md border border-slate-300 px-3 py-2 dark:border-slate-800"
    >
      <div className="flex items-baseline justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
        <span id="host-filter-label" className="uppercase tracking-wide">Filter hosts</span>
        {hidden > 0 ? <span className="whitespace-nowrap">{hidden} hidden</span> : null}
      </div>
      <div className="mt-0.5">
        {SWITCHES.map(({ key, label }) => {
          const on = filter[key];
          return (
            <button
              key={key}
              type="button"
              role="switch"
              aria-checked={on}
              onClick={() => onChange(key, !on)}
              className="flex h-6 w-full items-center gap-2 whitespace-nowrap text-xs text-slate-700 dark:text-slate-200"
            >
              <span
                className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${
                  on ? "bg-brand-600" : "bg-slate-300 dark:bg-slate-700"
                }`}
                aria-hidden
              >
                <span
                  className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${
                    on ? "translate-x-3.5" : "translate-x-0.5"
                  }`}
                />
              </span>
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
