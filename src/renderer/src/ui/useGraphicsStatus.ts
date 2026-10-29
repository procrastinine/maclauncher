import {useEffect, useRef, useState} from "react";
import type {GameEffectsPlan, GameGraphicsStatus, GraphicsContextStatus, GraphicsOwnerStatus, GraphicsStatusEvent} from "./types";

const current = (context: GraphicsContextStatus) => context.identityState === "matching" && !context.historical;

/**
 * Status of the editor's desired plan: the main-process status owner's record
 * (`getGraphicsStatus`, then each `onGraphicsStatus` transition) and the
 * runtime observation of that exact plan from the status panel. Observations
 * of an earlier plan are never shown. `onEvent` receives every transition of
 * this game, including a plan saved in another window.
 */
export function useGraphicsStatus({gamePath, subscribe, plan, pending, onEvent}: {
  gamePath: string; subscribe: boolean; plan: GameEffectsPlan; pending: boolean; onEvent?: (event: GraphicsStatusEvent) => void;
}) {
  const [owner, setOwner] = useState<GraphicsOwnerStatus | undefined>();
  const [observation, setObservation] = useState<{plan: GameEffectsPlan; status: GameGraphicsStatus} | null>(null);
  const listener = useRef(onEvent);listener.current = onEvent;
  useEffect(() => {
    setOwner(undefined);
    if (!subscribe) return;
    const api = typeof window === "undefined" ? undefined : window.MacLauncher?.launcher;
    let active = true, pushed = false;
    // Transitions arrive in order; the initial read never replaces one of them.
    const unsubscribe = api?.onGraphicsStatus?.(event => {
      if (!active || event.gamePath !== gamePath) return;
      pushed = true;setOwner(event.status);
      listener.current?.(event);
    });
    api?.getGraphicsStatus?.(gamePath).then(status => {if (active && !pushed) setOwner(status);}, () => {});
    return () => {active = false;unsubscribe?.();};
  }, [gamePath, subscribe]);
  const status = observation?.plan === plan ? observation.status : undefined;
  // Stage reports apply once the desired plan is saved and prepared.
  const settled = status && !pending && owner?.phase !== "preparing" && status.state !== "preparing"
    ? status.contexts.filter(context => current(context) && context.phase !== "preparing") : [];
  const stages = settled.flatMap(context => context.stages);
  const requested = plan.video.filter(node => node.enabled), output = plan.output;
  const outputOnly = requested.length === 0 && (["bfi", "beam"].includes(output?.motionClarity || "") ||
    Boolean(output?.comparison?.mode && output.comparison.mode !== "off") || Boolean(output?.toneMapping && output.toneMapping !== "auto"));
  // A stage native code kept at its previous working version did not apply the edit.
  const completed = (requested.length > 0 || outputOnly) && Boolean(settled.some(context =>
    (outputOnly ? context.completed > 0 : requested.every(node => context.stages.some(stage => stage.id === node.id && stage.completed > 0 && stage.activeMethod !== "retained")))));
  const retainedReason = status && !stages.some(stage => stage.completed > 0)
    ? [...status.contexts].sort((a, b) => b.observedAt - a.observedAt).find(context => context.identityState === "previous" && context.reason)?.reason : undefined;
  return {
    /** The owner's record for this game, once read. */
    status: owner, completed, retainedReason, stages,
    /** A runtime sample of the plan shown now; null clears it. */
    observe: (next: GameGraphicsStatus | null) => setObservation(next ? {plan, status: next} : null),
    stage: (id: string) => stages.find(stage => stage.id === id),
    /** A row waiting for preparation, an input or a model, from the runtime sample or the owner. */
    pendingRow: (id: string): {id: string; reason?: string; retained?: boolean} | undefined => {
      const sampled = status?.preparation?.pending?.find(row => row.id === id);
      if (sampled) return sampled;
      const row = owner?.rows[id];
      return row && ["pending", "retained", "acquiring"].includes(row.state) ? {id, reason: row.reason, retained: row.state === "retained"} : undefined;
    },
    pendingOutput: (id: string) => status?.preparation?.output?.pending?.find(row => row.id === id),
    adaptiveQuality: (id: string) => settled.slice().sort((a, b) => b.observedAt - a.observedAt).map(context => context.adaptiveQuality).find(value => value?.nodeId === id)
  };
}
export type GraphicsStatusView = ReturnType<typeof useGraphicsStatus>;
