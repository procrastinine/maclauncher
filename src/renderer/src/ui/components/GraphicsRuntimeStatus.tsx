import React, {useEffect, useRef, useState} from "react";
import type {GameGraphicsStatus, RecentGame} from "../types";

const extent = (value: {width: number; height: number}) => value.width > 0 && value.height > 0 ? `${value.width} × ${value.height}` : "—";
const admissionLabel = (value: string) => value.replace(/-/g, " ").replace(/^./, letter => letter.toUpperCase());
const phases = {unknown: "Not reported", preparing: "Preparing…", prepared: "Prepared", encoded: "Encoded", completed: "Completed", presented: "Presented", bypassed: "Bypassed", failed: "Failed", stopped: "Stopped", hidden: "Window hidden"};
const sourceLabels = {"metal-drawable": "Metal drawable", "opengl-framebuffer": "OpenGL interop", "layer-surface": "Layer surface", "software-bitmap": "Bitmap upload", "window-stream": "Window capture", "explicit-texture": "Runtime texture", "decoded-video": "Decoded video", unknown: "Unreported"};
export function GraphicsRuntimeStatus({game, running, visible, live, onStatus, requestKey = "", inspectDetails = false}: {
  game: Pick<RecentGame, "gamePath" | "effects" | "graphics" | "reshade">; running: boolean; visible: boolean; live?: boolean;
  onStatus?: (status: GameGraphicsStatus | null) => void; requestKey?: string; inspectDetails?: boolean;
}) {
  const [open, setOpen] = useState(false), [observation, setObservation] = useState<{key: string; value: GameGraphicsStatus} | null>(null);
  const [failure, setFailure] = useState<{key: string; message: string} | null>(null);
  const watching = open || inspectDetails;
  const callback = useRef(onStatus);callback.current = onStatus;
  const enabled = game.effects ? game.effects.enabled !== false && (game.effects.video.some(row => row.enabled) || Boolean(game.effects.renderResolution) || Boolean(game.effects.output?.motionClarity && game.effects.output.motionClarity !== "off") || Boolean(game.effects.output?.comparison?.mode && game.effects.output.comparison.mode !== "off") || Boolean(game.effects.output?.toneMapping && game.effects.output.toneMapping !== "auto")) : game.reshade?.enabled ||
    game.graphics?.spatialShader?.enabled === true ||
    [game.graphics?.spatialMethod, game.graphics?.temporalMethod, game.graphics?.frameGeneration, game.graphics?.neuralMethod].some(method => method && method !== "off");
  const selectionKey = JSON.stringify([game.effects, game.graphics, game.reshade]);
  const observationKey = JSON.stringify([game.gamePath, selectionKey, requestKey]);
  const status = observation?.key === observationKey ? observation.value : null, error = failure?.key === observationKey ? failure.message : "";
  useEffect(() => {
    if (!visible || !running || !enabled || !watching && live === false) {
      setObservation(null);setFailure(null);callback.current?.(null);return;
    }
    setObservation(null);setFailure(null);callback.current?.(null);
    let disposed = false, finished = false, timer: ReturnType<typeof setTimeout> | undefined;
    // This bounds observation only; editing and native application never wait.
    const expiresAt = Date.now() + 120000;
    const read = async () => {
      if (disposed || finished && !watching) return;
      try {
        if (typeof document === "undefined" || document.visibilityState !== "hidden") {
          const api = window.MacLauncher?.launcher;
          if (!api?.getGameGraphicsStatus) throw new Error("Runtime processing status is unavailable.");
          const next = await api.getGameGraphicsStatus(game.gamePath);
          if (!disposed && (!finished || watching) && (watching || Date.now() < expiresAt)) {
            setObservation({key: observationKey, value: next});setFailure(null);
            callback.current?.(next);
            const contexts = next.contexts.filter(context => context.identityState === "matching" && !context.historical);
            const requested = game.effects?.video.filter(node => node.enabled) || [];
            finished = next.state !== "preparing" && (requested.length > 0 && contexts.some(context => context.phase !== "preparing" && requested.every(node => context.stages.some(stage => stage.id === node.id &&
              (stage.completed > 0 || ["failed", "bypassed", "stopped"].includes(stage.phase))))) ||
              !requested.length && contexts.some(context => context.completed > 0) ||
              ["stopped", "off", "unavailable", "unbound", "failed"].includes(next.state)) || Date.now() >= expiresAt;
          }
        }
      } catch (error) {if (!disposed) setFailure({key: observationKey, message: error instanceof Error ? error.message : "Runtime processing status is unavailable."});}
      finally {if (!disposed && (watching || !finished && Date.now() < expiresAt)) timer = setTimeout(read, 2000);}
    };
    void read();return () => {disposed = true;if (timer !== undefined) clearTimeout(timer);};
  }, [watching, visible, running, enabled, live, game.gamePath, selectionKey, requestKey]);
  if (!running || !enabled) return null;
  const current = status?.contexts.filter(context => context.identityState === "matching" && !context.historical) || [];
  const requested = game.effects?.video.filter(node => node.enabled).map(node => node.id) || [];
  const bypassed = current.some(context => context.stages.some(stage => (!requested.length || requested.includes(stage.id)) && ["failed", "bypassed", "stopped"].includes(stage.phase)));
  const confirmed = status?.state !== "preparing" && current.some(context => context.phase !== "preparing" && (requested.length ? requested.every(id => context.stages.some(stage => stage.id === id && stage.completed > 0)) : context.completed > 0));
  const pending = Boolean(status?.preparation?.pending?.length || status?.preparation?.output?.pending?.length);
  const summary = status?.state === "preparing" ? "Preparing…" : status?.state === "failed" ? "Processing failed" : error || status?.state === "unavailable" || status?.state === "unbound" ? "Status unavailable"
    : bypassed ? "Some effects are not running" : pending ? "Some selected settings are pending" : confirmed ? "Completed processing reported"
    : status?.state === "historical" ? "No recent processing confirmation" : status?.state === "unverified" ? "Current settings not confirmed"
    : !status && live === false && !open ? "Processing reported in Status details" : "Current settings not yet confirmed";
  const details = <details className="effectNodeSettings" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Status details</summary>
    <div className="detailMeta">
      <p>Shared processing observations. Native renderer filters may run separately.</p>
      {!status && !error && <p>Reading processing status…</p>}
      {error && <p>{error}</p>}
      {status && <>
        {status.state === "preparing" ? <p>Preparing graphics…</p> : status.state === "failed" ? <p>{status.reason || "The current graphics settings failed during processing."}</p>
          : status.state === "unavailable" || status.state === "unbound" ? <p>Runtime processing status is unavailable for this launch.</p>
          : status.state === "prepared" ? <p>Settings prepared. No completed frame matching these settings has been reported since inspection.</p>
          : status.state === "historical" ? <p>Earlier completed processing is recorded. No recent report is available.</p>
          : status.state === "unverified" ? <p>Completed work is reported, but its settings version could not be confirmed.</p>
          : status.state === "off" ? <p>Graphics are off.</p> : status.state === "stopped" ? <p>Game stopped.</p>
          : <p>Completed processing has been reported. Counts cover observed work while status is open, not game or display frame rate.</p>}
        {status.preparation?.pending?.map(row => <p key={`pending:${row.id}`}>{row.method}: Pending. {row.reason}{row.retained ? " The previous setting is retained." : ""}</p>)}
        {status.preparation?.output?.pending?.map(row => <p key={`output:${row.id}`}>Output: Pending. {row.reason}</p>)}
        {status.preparation?.skipped?.map(row => <p key={`skipped:${row.id}`}>Last preparation · {row.id}: {row.reason}</p>)}
        {status.contexts.map(context => <div key={`${context.pid}:${context.processStart?.seconds}:${context.processStart?.microseconds}:${context.id}`}>
          {context.frameSource && <p>Source: {sourceLabels[context.frameSource.source]}{context.frameSource.inputs.length ? ` · ${context.frameSource.inputs.join(", ")}` : ""}</p>}
          <p>{phases[context.phase]} · Input {extent(context.input)} → Output {extent(context.output)}
            {context.identityState === "previous" ? " · Previous settings" : context.identityState === "unverified" ? " · Settings version not confirmed" : ""}</p>
          {context.historical && <p>Historical observation</p>}
          <p>Encoded {context.encoded} · Completed {context.completed} · Presented {context.presentedReal} real / {context.presentedGenerated} generated</p>
          {context.observedAt > 0 && <p>{Math.max(0, Math.floor((Date.now() - context.observedAt) / 1000))} s since the last report. Counts may stay unchanged while paused.</p>}
          {context.presentedTime <= 0 && <p>Presentation has not been reported for this context.</p>}
          {context.reason && <p>{context.reason}</p>}
          {context.admission && <details>
            <summary>Frame admission</summary>
            <p>Admission observations are separate from completed and presented frames.</p>
            <p>Last event: {admissionLabel(context.admission.reason)} · Source {extent(context.admission)} · Format {context.admission.format} · Queue identity {context.admission.queue} · Ownership {context.admission.generation}</p>
            {Object.entries(context.admission.counts).filter(([, count]) => count > 0).map(([reason, count]) => <p key={reason}>{admissionLabel(reason)}: {count}</p>)}
          </details>}
          {context.stages.map(row => <p key={row.id}>{row.requestedMethod || row.id}
            {row.activeMethod === "retained" ? " (previous version)" : row.activeMethod && row.activeMethod !== row.requestedMethod ? ` → ${row.activeMethod}` : ""}: {phases[row.phase]}
            {` · ${extent(row.input)} → ${extent(row.output)}`}{row.reason ? ` · ${row.reason}` : ""}</p>)}
        </div>)}
      </>}
    </div>
  </details>;
  return <>
    <p className="detailMeta" role="status">Selected · {summary}</p>
    {status?.state === "failed" && <p className="detailMeta">Turn the affected effect off and on to retry. Restart the game if processing remains unavailable.</p>}
    {details}
  </>;
}
