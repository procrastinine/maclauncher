import React from "react";

export type StatusTone = "neutral" | "positive" | "warning" | "danger";

const TONE_CLASSES: Record<StatusTone, string> = {
  neutral: "", positive: "badgeAccent", warning: "badgeWarn", danger: "badgeDanger"
};

// Neutral marks information such as Modified or Custom; warning and danger are
// reserved for states that need attention.
export function StatusBadge({ tone = "neutral", title, children }: {
  tone?: StatusTone; title?: string; children: React.ReactNode;
}) {
  return <span className={["badge", TONE_CLASSES[tone]].filter(Boolean).join(" ")} title={title}>{children}</span>;
}
