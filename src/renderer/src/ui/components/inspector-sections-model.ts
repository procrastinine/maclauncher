import type { GameEffectsPlan } from "../types";
import { GRAPHICS_TYPES, graphicsType } from "../../../../modules/shared/effects/contracts.mjs";
import { migrateOwnership } from "../../../../modules/shared/effects/edit-operations.mjs";

export type GraphicsSummaryContext = {
  /** The game is running. */
  running?: boolean;
  /** The running game applies saved changes without a relaunch. */
  live?: boolean;
  /** Launch warnings and notices recorded for the saved plan. */
  warnings?: number;
  /** The saved plan cannot be read. */
  unreadable?: boolean;
};

// The collapsed Graphics line names the kinds of enabled effects in chain order.
// Sizing helpers owned by another row are not listed; a game resolution set
// on its own is, since it applies without any effect. While the game runs, it
// also says whether saved changes apply now or at the next launch. An
// unreadable saved plan is reported instead.
export function graphicsSummary(plan: GameEffectsPlan | null | undefined, { running = false, live = false, warnings = 0, unreadable = false }: GraphicsSummaryContext = {}): string {
  if (unreadable) return "Saved settings unreadable · Needs attention";
  const rows = !plan || plan.enabled === false ? [] : migrateOwnership(plan).video.filter(node => node.enabled && node.ownedBy === undefined);
  const labels = [...new Set(rows.map(node => GRAPHICS_TYPES.find(type => type.id === graphicsType(node))?.label || "Effect"))];
  const source = plan?.enabled === false ? undefined : plan?.renderResolution;
  if (source && !source.managedBy) labels.push(`Game resolution ${"height" in source ? `${source.height}p` : `${Number((100 / source.multiplier).toPrecision(3))}%`}`);
  const parts = [plan?.enabled === false ? "Off" : labels.length ? labels.join(", ") : "No effects"];
  if (running) parts.push(live ? "Running" : "Next launch");
  if (warnings > 0) parts.push("Needs attention");
  return parts.join(" · ");
}
