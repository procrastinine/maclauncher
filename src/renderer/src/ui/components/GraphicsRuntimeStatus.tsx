import React, {useEffect, useState} from "react";
import type {GameGraphicsStatus, RecentGame} from "../types";

const extent = (value: {width: number; height: number}) => value.width > 0 && value.height > 0 ? `${value.width} × ${value.height}` : "—";
const admissionLabel = (value: string) => value.replace(/-/g, " ").replace(/^./, letter => letter.toUpperCase());
const phases = {unknown: "Not reported", prepared: "Prepared", encoded: "Encoded", completed: "Completed", presented: "Presented", bypassed: "Bypassed", failed: "Fallback", stopped: "Stopped"};
export function GraphicsRuntimeStatus({game, running, visible, live}: {
  game: Pick<RecentGame, "gamePath" | "effects" | "graphics" | "reshade">; running: boolean; visible: boolean; live?: boolean;
}) {
  const [open, setOpen] = useState(false), [status, setStatus] = useState<GameGraphicsStatus | null>(null);
  const [error, setError] = useState("");
  const [activation, setActivation] = useState<{key: string; pending: boolean; message: string; expiresAt: number} | null>(null);
  const enabled = game.effects ? game.effects.video.some(row => row.enabled) || Boolean(game.effects.renderResolution) : game.reshade?.enabled ||
    game.graphics?.spatialShader?.enabled === true ||
    [game.graphics?.spatialMethod, game.graphics?.temporalMethod, game.graphics?.frameGeneration, game.graphics?.neuralMethod].some(method => method && method !== "off");
  const selectionKey = JSON.stringify([game.effects, game.graphics, game.reshade]);
  const neuralKey = !game.effects && live && game.graphics?.neuralMethod === "mlx-dlss" ? game.gamePath + ":" + selectionKey : null;
  useEffect(() => {
    if (!visible || !running || !enabled || !open && !neuralKey) {
      setStatus(null);if (!running || !enabled || !neuralKey) setActivation(null);return;
    }
    const prior = activation?.key === neuralKey ? activation : null, expiresAt = prior?.expiresAt || Date.now() + 120000;
    let disposed = false, finished = Boolean(prior && !prior.pending), timer: ReturnType<typeof setTimeout> | undefined,
      deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (message: string) => {
      finished = true;if (deadline !== undefined) clearTimeout(deadline);
      if (timer !== undefined && !open) clearTimeout(timer);
      if (!disposed && neuralKey) setActivation({key: neuralKey, pending: false, message, expiresAt});
    };
    if (neuralKey && !finished) {
      setStatus(null);setActivation({key: neuralKey, pending: true, message: "Settings saved. Waiting for the first completed neural frame…", expiresAt});
      deadline = setTimeout(() => finish("Neural reconstruction has not reported a completed frame yet."), Math.max(0, expiresAt - Date.now()));
    } else if (!neuralKey) setActivation(null);
    const read = async () => {
      if (disposed || finished && !open) return;
      try {
        if (typeof document === "undefined" || document.visibilityState !== "hidden") {
          const api = window.MacLauncher?.launcher;
          if (!api?.getGameGraphicsStatus) throw new Error("Runtime processing status is unavailable.");
          const next = await api.getGameGraphicsStatus(game.gamePath);
          if (!disposed && (!finished || open)) {
            setStatus(next);setError("");
            if (neuralKey && !finished) {
              const pending = next.preparation?.pending?.find(row => row.kind === "neural" && row.method === "mlx-dlss");
              const stages = next.contexts.filter(context => context.identityState === "matching" && !context.historical)
                .flatMap(context => context.stages).filter(row => row.requestedMethod === "mlx-dlss");
              // Completion counters reset with the settings identity. A newer
              // frame may already be encoded when an earlier one completed.
              const completed = stages.some(row => row.completed > 0 && !["failed", "bypassed", "stopped"].includes(row.phase) &&
                (["mlx-dlss", "mlx-dlss-cache"].includes(row.activeMethod) || row.activeMethod === "pending" && row.phase === "encoded"));
              const failed = stages.find(row => ["failed", "bypassed", "stopped"].includes(row.phase));
              if (pending) finish(`Neural reconstruction is unavailable for these settings. ${pending.reason}`);
              else if (completed) finish("Neural reconstruction has completed a frame.");
              else if (failed) finish(`Neural reconstruction could not complete. ${failed.reason || "The available processing is retained."}`);
              else if (next.state === "stopped" || next.state === "off") finish("No completed neural frame has been reported for these settings.");
            }
          }
        }
      } catch (error) {if (!disposed) setError(error instanceof Error ? error.message : "Runtime processing status is unavailable.");}
      finally {if (!disposed && (open || neuralKey && !finished)) timer = setTimeout(read, 2000);}
    };
    void read();return () => {disposed = true;if (timer !== undefined) clearTimeout(timer);if (deadline !== undefined) clearTimeout(deadline);};
  }, [open, visible, running, enabled, neuralKey, game.gamePath, selectionKey]);
  if (!running || !enabled) return null;
  const neuralActivation = visible && neuralKey && activation?.key === neuralKey ? activation : null;
  const details = <details className="effectNodeSettings" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Runtime status</summary>
    <div className="detailMeta">
      <p>Shared processing observations. Native renderer filters may run separately.</p>
      {!status && !error && <p>Reading processing status…</p>}
      {error && <p>{error}</p>}
      {status && <>
        {status.state === "unavailable" || status.state === "unbound" ? <p>Runtime processing status is unavailable for this launch.</p>
          : status.state === "prepared" ? <p>Settings prepared. No completed frame matching these settings has been reported since inspection.</p>
          : status.state === "historical" ? <p>Earlier completed processing is recorded. No recent report is available.</p>
          : status.state === "unverified" ? <p>Completed work is reported, but its settings version could not be confirmed.</p>
          : status.state === "off" ? <p>Graphics are off.</p> : status.state === "stopped" ? <p>Game stopped.</p>
          : <p>Completed processing has been reported. Counts cover observed work while status is open, not game or display frame rate.</p>}
        {status.preparation?.pending?.map(row => <p key={`pending:${row.id}`}>{row.method}: Pending. {row.reason}{row.retained ? " The previous setting is retained." : ""}</p>)}
        {status.preparation?.skipped?.map(row => <p key={`skipped:${row.id}`}>Last preparation · {row.id}: {row.reason}</p>)}
        {status.contexts.map(context => <div key={`${context.pid}:${context.processStart?.seconds}:${context.processStart?.microseconds}:${context.id}`}>
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
            {row.activeMethod && row.activeMethod !== row.requestedMethod ? ` → ${row.activeMethod}` : ""}: {phases[row.phase]}
            {` · ${extent(row.input)} → ${extent(row.output)}`}{row.reason ? ` · ${row.reason}` : ""}</p>)}
        </div>)}
      </>}
    </div>
  </details>;
  return neuralActivation ? <><p className="detailMeta" role="status" aria-busy={neuralActivation.pending}>{neuralActivation.message}</p>{details}</> : details;
}
