import React from "react";
import { LauncherViewHeader } from "./LauncherViewHeader";

type CreditsViewProps = {
  acknowledgments: Array<{ label: string; url: string }>;
  canOpenExternal: boolean;
  onOpenLink: (url: string) => void;
};

const GAME_PORT_RESOURCES_URL = "https://github.com/SubmitGame/awesome-decomp-games";

export function CreditsView({ acknowledgments, canOpenExternal, onOpenLink }: CreditsViewProps) {
  return <main className="launcherView creditsView" aria-labelledby="credits-title">
    <LauncherViewHeader title="Credits" titleId="credits-title" />
    <div className="launcherViewBody">
      <section className="settingsSection" aria-labelledby="credits-resources-title">
        <div className="settingsTitle" id="credits-resources-title" role="heading" aria-level={2}>Game port resources</div>
        <div className="ackTable">
          <div className="ackRow">
            <div className="ackCell ackTitle">Awesome Decomp Games</div>
            <div className="ackCell dim">Community list of game source ports, decompilations and engine remakes. Platforms and game data requirements vary by project.</div>
            <div className="ackCell ackActionCell">
              <button className="btn small" disabled={!canOpenExternal} title={GAME_PORT_RESOURCES_URL}
                aria-label="Open Awesome Decomp Games" onClick={() => onOpenLink(GAME_PORT_RESOURCES_URL)}>Open</button>
            </div>
          </div>
        </div>
      </section>
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
