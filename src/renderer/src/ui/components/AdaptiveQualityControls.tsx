import React from "react";
import type {AdaptiveQualitySettings, GraphicsContextStatus} from "../types";
import {GraphicsNumber} from "./GraphicsNumber";
import {HelpTip} from "./HelpTip";

type Observation = NonNullable<GraphicsContextStatus["adaptiveQuality"]>;
const scopeLabels: Record<Observation["scope"], string> = {unknown: "", "source-and-processing": "Source + processing", "image-processing": "Image processing", "final-processing": "Final processing", "offline-frame": "Offline frame", "external-processing":"External processing"};
export function AdaptiveQualityControls({nodeId, available, policy, observation, onChange}: {
  nodeId: string; available: boolean; policy?: AdaptiveQualitySettings; observation?: Observation;
  onChange: (value: AdaptiveQualitySettings) => void;
}) {
  const selected = policy?.nodeId === nodeId, enabled = selected && policy?.enabled === true;
  if (!available && !selected) return null;
  const value: AdaptiveQualitySettings = {enabled: false, budgetMs: 8, minScale: .5, maxScale: 1, ...policy, nodeId};
  const validMeasurement = observation && observation.scope !== "unknown" && Number.isFinite(observation.meanMilliseconds) && observation.meanMilliseconds > 0;
  const timingHelp = observation?.reason || (!available ? "This graphics runtime does not provide adaptive quality for this processing extent." : validMeasurement
    ? observation.scope === "external-processing" ? "GPU render time on the affected external provider queues. Native processing and source rendering have separate timing."
      : observation.scope === "offline-frame" ? "Completed GPU work for the owned export processing job. Video decoding and encoding run separately." : "Completed GPU work for the named processing section. Other provider queues have separate timing."
    : "The policy waits for a representative completed GPU measurement. Other effects continue using the configured output size.");
  const id = (name: string) => `effect-${nodeId}-quality-${name}`;
  return <>
    <label className="inlineCheck"><input id={id("enabled")} type="checkbox" checked={enabled} disabled={!available && !enabled}
      onChange={event => onChange({...value, enabled: event.target.checked})} />Adaptive quality
      <HelpTip label="About adaptive quality">Adjusts this row's processing extent within the scale bounds, using completed GPU work. Bounds multiply Output size. Measurements name the processing section they cover; separate provider queues need their own timing. Output dimensions and media timestamps stay fixed.</HelpTip></label>
    {enabled && <>
      <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor={id("budget")}>GPU budget (ms)</label>
        <GraphicsNumber id={id("budget")} className="input" min="0.25" max="1000" step="0.25" value={value.budgetMs}
          onValue={budgetMs => onChange({...value, budgetMs})} /></div>
      <div className="detailRow detailControlRow"><span className="detailLabel">Scale bounds</span><div className="detailActions">
        <GraphicsNumber id={id("minimum")} aria-label="Minimum processing scale percent" className="input effectExtentInput" min="6.25" max={String(value.maxScale * 100)} step="6.25" value={value.minScale * 100}
          onValue={minimum => onChange({...value, minScale: minimum / 100})} />
        <span aria-hidden="true">–</span>
        <GraphicsNumber id={id("maximum")} aria-label="Maximum processing scale percent" className="input effectExtentInput" min={String(value.minScale * 100)} max="100" step="6.25" value={value.maxScale * 100}
          onValue={maximum => onChange({...value, maxScale: maximum / 100})} /><span>%</span>
      </div></div>
      {(observation || !available) && <div className="detailRow"><span className="detailLabel">Processing</span><span className="detailValue">
        {observation?.state === "active" && validMeasurement
          ? `${Math.round(observation.scale * 1000) / 10}% · ${scopeLabels[observation.scope]} ${observation.meanMilliseconds.toFixed(2)} ms`
          : "Timing pending"}
        <HelpTip label="About quality timing">{timingHelp}</HelpTip>
      </span></div>}
    </>}
  </>;
}
