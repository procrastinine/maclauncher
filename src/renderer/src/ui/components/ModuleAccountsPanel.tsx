import { RefreshIcon } from "../icons";
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { LauncherApi, ModuleUi } from "../types";
import { formatUserError } from "../ui-helpers";
import { HelpTip } from "./HelpTip";
import { ErrorText } from "./ErrorText";
import { confirmAction } from "../confirm-action";

type AccountState = { accounts: Array<{ id: string; label: string; canRemove?: boolean }>; canSignIn: boolean; message?: string };
export function ModuleAccountsPanel({ moduleId, descriptor, action }: {
  moduleId: string; descriptor: NonNullable<ModuleUi["accounts"]>; action?: LauncherApi["moduleSettingsAction"];
}) {
  const [state, setState] = useState<AccountState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const operation = useRef(false);
  const request = useRef<{ key: string; promise: Promise<AccountState> } | null>(null);
  const [revision, setRevision] = useState(0);
  const [manualRevision, setManualRevision] = useState(0);
  const observedManualRevision = useRef(0);
  const load = useCallback(async (refresh = false) => {
    if (!action) return null;
    const key = moduleId + ":" + descriptor.stateAction + ":" + refresh;
    if (request.current?.key === key) return request.current.promise;
    const promise = action(moduleId, descriptor.stateAction, { refresh }).then(value => {
      if (!value || !Array.isArray(value.accounts) || value.accounts.some((account: any) => !account ||
          typeof account.id !== "string" || typeof account.label !== "string")) throw new Error("Account information is unavailable.");
      return value as AccountState;
    });
    request.current = { key, promise };
    try { return await promise; }
    finally { if (request.current?.promise === promise) request.current = null; }
  }, [action, moduleId, descriptor.stateAction]);
  useEffect(() => {
    let active = true, refreshing = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async (live = false) => {
      if (!active || refreshing) return;
      clearTimeout(timer); refreshing = true; setLoading(true);
      try { const value = await load(live); if (active) { setState(value); setError(null); } }
      catch (cause) { if (active) setError(formatUserError(cause)); }
      finally {
        refreshing = false;
        if (active) {
          setLoading(false);
          // Account creation can finish before the provider's final activity.
          // Observe it while the operation is open, with one request at a time.
          if (pendingAction) timer = setTimeout(() => void refresh(), 1500);
        }
      }
    };
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    const explicit = manualRevision !== observedManualRevision.current;
    observedManualRevision.current = manualRevision;
    void refresh(explicit);
    return () => { active = false; clearTimeout(timer); window.removeEventListener("focus", visible); document.removeEventListener("visibilitychange", visible); };
  }, [load, revision, manualRevision, pendingAction]);
  async function operate(name: string, payload?: Record<string, any>) {
    if (!action || operation.current) return;
    operation.current = true; setPendingAction(name); setError(null);
    try { await action(moduleId, name, payload); }
    catch (cause) { setError(formatUserError(cause)); }
    finally { operation.current = false; setPendingAction(null); setRevision(value => value + 1); }
  }
  return <section className="settingsSection" aria-label={descriptor.label}>
    <div className="accountToolbar">
      <div className="settingsTitle">{descriptor.label}{state?.message && <HelpTip label={`About ${descriptor.label}`}><p>{state.message}</p></HelpTip>}</div>
      <div className="settingsControl">
        <button type="button" className="btn iconOnly" title="Refresh accounts" aria-label="Refresh accounts" aria-busy={loading} disabled={!action} onClick={() => setManualRevision(value => value + 1)}><RefreshIcon /></button>
        <button type="button" className="btn primary" disabled={!action || pendingAction !== null}
          aria-busy={pendingAction === descriptor.signInAction}
          onClick={() => void operate(descriptor.signInAction, descriptor.signInPayload)}>{pendingAction === descriptor.signInAction ? "Signing in…" : descriptor.signInLabel || "Sign in…"}</button>
      </div>
    </div>
    <ErrorText error={error} inline />
    <div className="accountTableScroll" role="region" aria-label={descriptor.label} tabIndex={0} aria-busy={loading}>
      <table className="accountTable">
        <thead><tr><th scope="col">Account</th><th scope="col">Actions</th></tr></thead>
        <tbody>{state?.accounts.map(account => <tr key={account.id}>
          <td>{account.label}</td>
          <td><button type="button" className="btn small" disabled={pendingAction !== null || account.canRemove !== true}
            onClick={async () => {
              if (await confirmAction({ message: `Remove ${account.label} from ${descriptor.label}?`,
                detail: "Signing in again is required to use it.", confirmLabel: "Remove", destructive: true }))
                void operate(descriptor.removeAction, { accountId: account.id });
            }}>Remove account…</button></td>
        </tr>)}
        {!state?.accounts.length && <tr><td colSpan={2} className="dim">{state ? "No signed-in accounts." : loading ? "Loading accounts…" : "Account information is unavailable."}</td></tr>}
        </tbody>
      </table>
    </div>
  </section>;
}
