import {useEffect, useRef, useState} from "react";
import type {GameEffectsPlan, GraphicsEditResult} from "./types";
import {migrateOwnership, rebase} from "../../../modules/shared/effects/edit-operations.mjs";
import {migrate, validate} from "../../../modules/shared/effects/plan.mjs";

type Options = {
  saved: GameEffectsPlan;
  save: (plan: GameEffectsPlan, options: {clientRevision: number; basePlan: GameEffectsPlan}) => Promise<boolean | GraphicsEditResult | void>;
  onAcknowledged?: (result: GraphicsEditResult) => void;
};
type Waiter = {resolve: () => void; reject: (error: unknown) => void};

export const EMPTY_PLAN: GameEffectsPlan = Object.freeze({schema: 2, mode: "advanced", enabled: true, video: []}) as GameEffectsPlan;
/**
 * The editable form of a plan from main or a preset: schema 2 with explicit
 * helper ownership. Main converts legacy settings; a game without a plan
 * edits an empty one.
 */
export function editablePlan(value: GameEffectsPlan | null | undefined): GameEffectsPlan {
  if (value == null) return EMPTY_PLAN;
  return migrateOwnership(migrate(value) as GameEffectsPlan);
}
// Structural equality for acknowledged and observed plans, so an unchanged
// plan keeps the identity that projections and status observations key on.
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((value, index) => same(value, (b as unknown[])[index]));
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter(key => left[key] !== undefined);
  return keys.length === Object.keys(right).filter(key => right[key] !== undefined).length && keys.every(key => same(left[key], right[key]));
}

/**
 * Coalesce event-loop edits without making later input wait for preparation.
 * Each edit is an edit operation applied to the latest draft; a plan observed
 * from another window merges with unacknowledged edits through `rebase`.
 */
export function useGraphicsEdits(options: Options) {
  const [plan, setPlan] = useState(options.saved), [pending, setPending] = useState(false), [error, setError] = useState("");
  const state = useRef({draft: options.saved, saved: options.saved, observed: options.saved, revision: 0,
    scheduled: false, waiters: [] as Waiter[], requests: new Set<number>(), mounted: true, options});
  const current = state.current;current.options = options;
  useEffect(() => {current.mounted = true;return () => {current.mounted = false;};}, []);
  useEffect(() => {
    if (current.observed === options.saved) return;
    current.observed = options.saved;observe(options.saved);
  }, [options.saved]);

  async function flush() {
    current.scheduled = false;
    const revision = current.revision, next = current.draft, basePlan = current.saved;
    const waiters = current.waiters.splice(0);current.requests.add(revision);
    try {
      const result = await current.options.save(next, {clientRevision: revision, basePlan});
      if (result === false) throw new Error("Effects could not be saved.");
      if (current.mounted && revision === current.revision) {
        const acknowledged = result && typeof result === "object" ? editablePlan(result.plan) : next;
        const canonical = same(acknowledged, next) ? next : acknowledged;
        current.saved = canonical;current.draft = canonical;setPlan(canonical);
        if (result && typeof result === "object") current.options.onAcknowledged?.(result);
      }
      for (const waiter of waiters) waiter.resolve();
    } catch (failure) {
      if (current.mounted && revision === current.revision) {
        current.draft = current.saved;setPlan(current.saved);
        setError(failure instanceof Error ? failure.message : "Effects could not be saved.");
      }
      for (const waiter of waiters) waiter.reject(failure);
    } finally {
      current.requests.delete(revision);
      if (current.mounted) setPending(current.scheduled || current.requests.size > 0);
    }
  }

  /** Applies one edit operation to the latest draft. An unchanged plan saves nothing. */
  function apply(update: (plan: GameEffectsPlan) => GameEffectsPlan): Promise<void> {
    let next: GameEffectsPlan;
    try {next = update(current.draft);if (next !== current.draft) validate(next);}
    catch (failure) {setError(failure instanceof Error ? failure.message : "Effects are invalid.");return Promise.reject(failure);}
    if (next === current.draft) return Promise.resolve();
    current.draft = next;current.revision++;setPlan(next);setError("");setPending(true);
    const result = new Promise<void>((resolve, reject) => current.waiters.push({resolve, reject}));
    if (!current.scheduled) {current.scheduled = true;queueMicrotask(() => {void flush();});}
    return result;
  }
  function observe(value: GameEffectsPlan) {
    let next: GameEffectsPlan;
    try {next = editablePlan(value);} catch {return;}
    const merged = current.scheduled || current.requests.size ? rebase(next, current.saved, current.draft) : next;
    const draft = same(merged, current.draft) ? current.draft : merged;
    current.saved = same(next, current.saved) ? current.saved : next;current.draft = draft;
    if (current.mounted) setPlan(draft);
  }
  return {plan, apply, pending, error, observe, revision: () => current.revision, currentPlan: () => current.draft};
}
