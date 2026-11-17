import React, { memo } from "react";
import type { ModuleManifest } from "../types";
import type { PendingImportRow } from "../pending-imports.mjs";
import { formatModuleBadge } from "../ui-helpers";
import { GameIcon } from "./GameIcon";
import { PathDisplay } from "./PathDisplay";

const phaseLabel = (phase: string) => phase === "queued" ? "Queued" : phase === "extracting" ? "Unpacking…" :
  phase === "verifying" ? "Checking…" : "Adding…";

// The row of a game being added: its name, an empty icon tile and its
// progress, in the place of the actions it gets once added.
export const PendingGameRow = memo(function PendingGameRow({ row, moduleInfo, showIcons, withHandle, onCancel }: {
  row: PendingImportRow; moduleInfo: ModuleManifest | null; showIcons: boolean; withHandle: boolean; onCancel: (inputPath: string) => void;
}) {
  return <li className="gameItem pendingImport" aria-busy="true" data-input-path={row.inputPath}>
    <div className={["gameRow", withHandle ? "withHandle" : ""].filter(Boolean).join(" ")}>
      {withHandle && <span aria-hidden="true" />}
      <span aria-hidden="true" />
      <span className="gameSelect">
        {showIcons && <GameIcon game={{ iconUrl: null, iconSource: null, iconPending: true }} />}
        <span className="gameMain">
          <span className="gameTopLine">
            <span className="gameName" title={row.name}>{row.name}</span>
            {row.moduleId && <span className="badge">{formatModuleBadge(moduleInfo?.shortLabel, moduleInfo?.label, row.moduleId)}</span>}
          </span>
          <span className="gameBottomLine">
            <span className="lastPlayed" role="status">{phaseLabel(row.phase)}</span>
            <span className="dot" aria-hidden="true">·</span>
            <span className="mono gameRowPath"><PathDisplay path={row.inputPath} /></span>
          </span>
        </span>
      </span>
      <span className="pendingImportActions">
        <progress aria-label={`Adding ${row.name}`} max={row.total || 1} value={row.total ? row.completed : undefined} />
        <button type="button" className="btn small" onClick={() => onCancel(row.inputPath)}>Cancel</button>
      </span>
    </div>
  </li>;
});
