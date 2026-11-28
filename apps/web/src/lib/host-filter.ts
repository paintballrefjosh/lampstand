import type { InfraTarget } from "@lampstand/shared";

/** Which hosts the infrastructure overview shows: its "Filter hosts" switches. */
export interface HostFilter {
  down: boolean;
  disabled: boolean;
  up: boolean;
}

export const SHOW_ALL_HOSTS: HostFilter = { down: true, disabled: true, up: true };

/**
 * Whether the filter shows a host. A switched-off host counts as disabled whatever its last status was. Degraded and
 * not-yet-read hosts have no switch and always show, so no filter hides a host that may need attention.
 */
export function showsHost(filter: HostFilter, host: Pick<InfraTarget, "status" | "enabled">): boolean {
  if (!host.enabled) return filter.disabled;
  if (host.status === "up") return filter.up;
  if (host.status === "down") return filter.down;
  return true;
}

/** A remembered filter read back; anything missing or unreadable shows the hosts. */
export function parseHostFilter(saved: string | null): HostFilter {
  try {
    const v = JSON.parse(saved ?? "") as Partial<Record<keyof HostFilter, unknown>> | null;
    return { down: v?.down !== false, disabled: v?.disabled !== false, up: v?.up !== false };
  } catch {
    return SHOW_ALL_HOSTS;
  }
}
