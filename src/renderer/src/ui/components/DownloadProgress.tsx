import React from "react";
import type { DownloadTask } from "../types";
import { formatBytes, formatDownloadPercent } from "../ui-helpers";

export function DownloadProgress({ task, onCancel }: { task: DownloadTask; onCancel: (id: string) => void }) {
  const percent = formatDownloadPercent(task);
  return <div className="runtimeDownloadItem">
    <div className="runtimeDownloadMeta">
      <div className="runtimeDownloadLabel">{task.label}</div>
      <div className="runtimeDownloadDetail" role="status">{task.detail || "Downloading…"} · {formatBytes(task.downloaded)}
        {task.total != null && task.total > 0 && ` / ${formatBytes(task.total)}`}{percent != null && ` · ${percent}%`}</div>
    </div>
    <div className="runtimeDownloadRow">
      <progress className="runtimeDownloadProgress" aria-label={`${task.label} progress`} max={100} value={percent ?? undefined} />
      <button type="button" className="btn small" onClick={() => onCancel(task.id)} aria-label={`Cancel ${task.label}`}>Cancel</button>
    </div>
  </div>;
}
