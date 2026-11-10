import React from "react";
import { LauncherViewHeader } from "./LauncherViewHeader";

type CreditsViewProps = {
  acknowledgments: Array<{ label: string; url: string }>;
  canOpenExternal: boolean;
  onOpenLink: (url: string) => void;
};

const GAME_PORT_RESOURCES_URL = "https://github.com/SubmitGame/awesome-decomp-games";

// A credited link opens in the default browser through the launcher's
// open-external path.
function CreditLink({ url, label, canOpen, onOpen, className }: { url: string; label: string; canOpen: boolean; onOpen: (url: string) => void; className?: string }) {
  return <a className={["ackLink", className].filter(Boolean).join(" ")} href={url} title={url} aria-disabled={canOpen ? undefined : true}
    onClick={event => { event.preventDefault(); if (canOpen) onOpen(url); }}>{label}</a>;
}

export function CreditsView({ acknowledgments, canOpenExternal, onOpenLink }: CreditsViewProps) {
  return <main className="launcherView creditsView" aria-labelledby="credits-title">
    <LauncherViewHeader title="Credits" titleId="credits-title" />
    <div className="launcherViewBody">
      {acknowledgments.length === 0 ? <div className="empty">No credits listed.</div> :
        <div className="ackTable">
          <div className="ackRow ackHeaderRow">
            <div className="ackCell">Project</div>
            <div className="ackCell ackUrl mono">URL</div>
          </div>
          {acknowledgments.map(item => <div className="ackRow" key={`${item.label}-${item.url}`}>
            <div className="ackCell ackTitle">{item.label}</div>
            <div className="ackCell ackUrl mono ellipsis"><CreditLink url={item.url} label={item.url} canOpen={canOpenExternal} onOpen={onOpenLink} /></div>
          </div>)}
        </div>}
      {/* Related links follow the credited projects. */}
      <section className="settingsSection creditsResources" aria-labelledby="credits-resources-title">
        <div className="settingsTitle" id="credits-resources-title" role="heading" aria-level={2}>Game port resources</div>
        <div className="ackTable">
          <div className="ackRow">
            <div className="ackCell ackTitle"><CreditLink url={GAME_PORT_RESOURCES_URL} label="Awesome Decomp Games" canOpen={canOpenExternal} onOpen={onOpenLink} /></div>
            <div className="ackCell dim">Community list of game source ports, decompilations and engine remakes. Platforms and game data requirements vary by project.</div>
          </div>
        </div>
      </section>
    </div>
  </main>;
}
