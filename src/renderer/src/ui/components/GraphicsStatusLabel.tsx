import React from "react";
import type {GraphicsOwnerStatus, GraphicsStatusPhase} from "../types";
import {HelpTip} from "./HelpTip";

const phaseLabels = (running: boolean): Partial<Record<GraphicsStatusPhase, string>> => ({saved: running ? "Next launch" : "Saved",
  published: running ? "Applying…" : "Saved", applied: "Applied", partial: "Partly applied", deferred: "Next launch",
  rejected: running ? "Not applied" : "Unavailable", unconfirmed: "Not confirmed", invalid: "Needs attention"});

/** The header state of the desired graphics plan, from the status owner and runtime observations. */
export function GraphicsStatusLabel({enabled, saving, status, completed, retainedReason, running}: {
  enabled: boolean; saving: boolean; status?: GraphicsOwnerStatus; completed: boolean; retainedReason?: string; running: boolean;
}) {
  const phase = status?.phase;
  if (phase === "invalid") return <span className="graphicsState" role="status">{phaseLabels(running).invalid}</span>;
  if (!enabled) return <span className="graphicsState" role="status">Off</span>;
  if (saving || phase === "preparing") return <span className="graphicsState" role="status">{saving ? "Saving…" : "Preparing…"}</span>;
  if (phase === "acquiring") {
    const reason = status?.reason || "Downloading model…";
    return <span className="graphicsState graphicsStateText" role="status" title={reason}>{reason}</span>;
  }
  if (completed) return <span className="graphicsState" role="status">Active</span>;
  if (retainedReason) return <span className="graphicsState" role="status">Using previous<HelpTip label="About retained graphics">{retainedReason}</HelpTip></span>;
  // A stopped game's saved plan needs no label unless something is reported about it.
  if (!phase || phase === "saved" && !running && !status?.reason) return null;
  return <span className="graphicsState" role="status">{phaseLabels(running)[phase]}
    {status?.reason && <HelpTip label="About graphics status">{status.reason}</HelpTip>}</span>;
}
