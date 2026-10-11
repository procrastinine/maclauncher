import React from "react";
import { LauncherViewHeader } from "./LauncherViewHeader";

type CreditsViewProps = {
  acknowledgments: Array<{ label: string; url: string }>;
  canOpenExternal: boolean;
  onOpenLink: (url: string) => void;
};

export function CreditsView({ acknowledgments, canOpenExternal, onOpenLink }: CreditsViewProps) {
  return <main className="launcherView creditsView" aria-labelledby="credits-title">
    <LauncherViewHeader title="Credits" titleId="credits-title" />
    <div className="launcherViewBody">
      {acknowledgments.length === 0 ? <div className="empty">No credits listed.</div> :
        <div className="ackTable">
          <div className="ackRow ackHeaderRow">
            <div className="ackCell">Project</div>
            <div className="ackCell ackUrl mono">URL</div>
            <div className="ackCell ackActionCell" aria-hidden="true">
              <button className="btn small ackActionSpacer" disabled tabIndex={-1}>Open</button>
            </div>
          </div>
          {acknowledgments.map(item => <div className="ackRow" key={`${item.label}-${item.url}`}>
            <div className="ackCell ackTitle ellipsis">{item.label}</div>
            <div className="ackCell ackUrl mono dim ellipsis">{item.url}</div>
            <div className="ackCell ackActionCell">
              <button className="btn small" disabled={!canOpenExternal} onClick={() => onOpenLink(item.url)}>Open</button>
            </div>
          </div>)}
        </div>}
    </div>
  </main>;
}
