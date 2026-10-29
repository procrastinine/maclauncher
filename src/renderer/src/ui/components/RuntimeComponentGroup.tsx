import React, { useEffect, useRef, useState } from "react";
import type { DownloadTask } from "../types";
import type { RuntimeTabSection } from "./runtime-tabs-model";
import { DownloadProgress } from "./DownloadProgress";
import { StatusBadge } from "./StatusBadge";

// Component groups share the normal version controls and exact action targets.
export function RuntimeComponentGroup({ enabled, label, description, choices, selectedId, navigationKey, downloads, onSelect, onCancel, children }: {
  enabled: boolean; label: string; description?: string; choices: RuntimeTabSection[]; selectedId?: string;
  navigationKey?: number; downloads: DownloadTask[]; onSelect: (choice: RuntimeTabSection) => void;
  onCancel: (id: string) => void; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(() => choices[0]?.id !== selectedId);
  const navigation = useRef(navigationKey);
  useEffect(() => {
    if (navigation.current !== navigationKey) { navigation.current = navigationKey; setOpen(choices[0]?.id !== selectedId); }
  }, [navigationKey, selectedId, choices]);
  if (!enabled) return <>{children}</>;
  return <div className="runtimePanel">
    <section className="runtimeSectionCard" aria-label={`${label} components`}>
      <div className="runtimeSectionHeader"><div>
        <div className="runtimeSectionTitle">{label}</div>
        <p className="dim">{description || "Play checks required components. Missing downloads ask for approval, then preparation continues automatically."}</p>
      </div></div>
      <dl className="runtimeComponents">
        {choices.map(choice => {
          const installed = choice.section.installed || [];
          const ready = installed.some((row: Record<string, any>) => row.ready !== false);
          const tasks = downloads.filter(task => task.managerId === choice.managerId && task.sectionId === choice.sectionId);
          return <div className="runtimeComponent" key={choice.id}>
            <dt>{choice.label}</dt>
            <dd><StatusBadge tone={ready ? "positive" : "neutral"}>{tasks.length ? "Preparing…" : ready ? "Installed" : "Automatic on Play"}</StatusBadge>
              <button type="button" className="btn small" aria-label={`Manage ${choice.label}`} onClick={() => { setOpen(true); onSelect(choice); }}>Manage…</button>
            </dd>
            {tasks.map(task => <dd key={task.id} style={{ gridColumn: "1 / -1", display: "block" }}><DownloadProgress task={task} onCancel={onCancel} /></dd>)}
          </div>;
        })}
      </dl>
    </section>
    <details open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>Advanced · versions and components</summary>
      <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor="runtime-component-selection">Component</label>
        <select id="runtime-component-selection" className="input" value={selectedId} onChange={event => {
          const choice = choices.find(row => row.id === event.target.value); if (choice) onSelect(choice);
        }}>{choices.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}</select>
      </div>
      {children}
    </details>
  </div>;
}
