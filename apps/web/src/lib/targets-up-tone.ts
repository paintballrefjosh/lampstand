import type { InfraSummary } from "@lampstand/shared";

/** Down hosts beyond this many turn the "Targets up" figure from a warning into a problem. */
export const TARGETS_DOWN_WARN_MAX = 3;

/**
 * The colour of the overview's "Targets up" figure: good when every monitored host is up; otherwise a warning while at
 * most three are down (so a degraded or not-yet-read host alone is a warning), and bad beyond that. With no monitored
 * host there is nothing to judge.
 */
export function targetsUpTone(targets: Pick<InfraSummary["targets"], "total" | "up" | "down">): "ok" | "good" | "warn" | "bad" {
  if (targets.total === 0) return "ok";
  if (targets.up >= targets.total) return "good";
  return targets.down <= TARGETS_DOWN_WARN_MAX ? "warn" : "bad";
}
