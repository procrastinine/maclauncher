import React, { useCallback, useEffect, useRef, useState } from "react";
import { formatUserError } from "../ui-helpers";
import { HelpTip } from "./HelpTip";

type Actions = Record<"status" | "list" | "set" | "pause" | "resume" | "close", string>;
type EditorContext = { gamePath: string; sessionId: string; actions: Actions };
type Variable = { index: number; name: string; value: string; editable: boolean; type: string };
type Session = { phase: string; reason?: string; scopes: Array<{ id: string; label: string; count: number }> };
type Page = Session & { scope: string; total: number; start: number; variables: Variable[] };

function scopeTabId(scope: string) {
  return "live-variables-tab-" + encodeURIComponent(scope);
}

export function LiveVariableScopeTabs({ scopes, scope, busy, onSelect }: {
  scopes: Session["scopes"]; scope: string; busy: boolean; onSelect: (scope: string) => void;
}) {
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const revealSelected = () => tabsRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
    revealSelected();
    window.addEventListener("resize", revealSelected);
    return () => window.removeEventListener("resize", revealSelected);
  }, [scope, scopes.length]);
  return <div ref={tabsRef} className="saveToolsTabs liveVariablesTabs" role="tablist" aria-label="Variable scope">
    {scopes.map((item, index) => <button role="tab" type="button"
      id={scopeTabId(item.id)} aria-controls="live-variables-panel"
      aria-selected={scope === item.id} tabIndex={scope === item.id ? 0 : -1} key={item.id}
      aria-disabled={busy || undefined}
      onKeyDown={event => {
        const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? scopes.length - 1 :
          event.key === "ArrowRight" ? (index + 1) % scopes.length : event.key === "ArrowLeft" ? (index + scopes.length - 1) % scopes.length : -1;
        if (nextIndex < 0) return;
        event.preventDefault();
        if (busy) return;
        onSelect(scopes[nextIndex].id);
        const nextTab = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex];
        nextTab?.focus();
        nextTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
      }}
      onClick={() => { if (!busy) onSelect(item.id); }}>{item.label}</button>)}
  </div>;
}

export function readLiveVariableEditorContext(): EditorContext | null {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("view") !== "live-variables") return null;
    const gamePath = params.get("gamePath"), sessionId = params.get("sessionId");
    const actions = JSON.parse(params.get("actions") || "null");
    if (!gamePath || !sessionId || [gamePath, sessionId].some(value => value.includes("\0")) ||
        ["status", "list", "set", "pause", "resume", "close"].some(key => typeof actions?.[key] !== "string")) return null;
    return { gamePath, sessionId, actions };
  } catch { return null; }
}

export function LiveVariablesWindow({ context }: { context: EditorContext }) {
  const api = window.MacLauncher?.launcher;
  const [session, setSession] = useState<Session | null>(null);
  const [page, setPage] = useState<Page | null>(null);
  const [scope, setScope] = useState("globals");
  const [start, setStart] = useState(0);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const call = useCallback((action: keyof Actions, payload: Record<string, unknown> = {}) => {
    if (!api) return Promise.reject(new Error("Game connection is unavailable."));
    return api.moduleAction(context.gamePath, context.actions[action], { ...payload, sessionId: context.sessionId });
  }, [api, context]);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    const status = await call("status");
    if (sequence.current !== request) return;
    setSession(status);
    if (status.phase === "paused") {
      const values = await call("list", { scope, start, count: 64 });
      if (sequence.current === request) setPage(values);
    }
  }, [call, scope, start]);
  useEffect(() => {
    let closed = false;
    refresh().catch(error => { if (!closed) setError(formatUserError(error)); });
    const timer = window.setInterval(() => {
      call("status").then(status => { if (!closed) setSession(status); })
        .catch(error => { if (!closed) setError(formatUserError(error)); });
    }, 1500);
    return () => { closed = true; sequence.current++; window.clearInterval(timer); };
  }, [call, refresh]);
  async function togglePause() {
    setBusy(true); setError(null);
    try { await call(session?.phase === "running" ? "pause" : "resume"); await refresh(); }
    catch (error) { setError(formatUserError(error)); }
    finally { setBusy(false); }
  }
  async function apply() {
    setBusy(true); setError(null);
    try { await call("set", { scope, index: editing, value: draft }); setEditing(null); await refresh(); }
    catch (error) { setError(formatUserError(error)); }
    finally { setBusy(false); }
  }
  const paused = session?.phase === "paused";
  const available = paused || session?.phase === "running";
  return <main className="liveVariablesWindow">
    <div className="liveVariablesToolbar">
      <span className="muted" role="status">{session ? available ? paused ? "Paused" : "Running" : "Game closed" : "Connecting…"}</span>
      <HelpTip label="About live variables">Pause to edit variables. Closing this window resumes the game.</HelpTip>
      <span className="spacer" />
      <button className="btn small" disabled={busy || !available} onClick={togglePause}>{paused ? "Resume" : "Pause"}</button>
      <button className="btn small" disabled={busy || !paused} onClick={() => refresh().catch(error => setError(formatUserError(error)))}>Reload</button>
    </div>
    {error && <div className="error" role="alert">{error}</div>}
    <LiveVariableScopeTabs scopes={session?.scopes || []} scope={scope} busy={busy}
      onSelect={nextScope => { setScope(nextScope); setStart(0); setEditing(null); }} />
    <div className="liveVariablesBody" role="tabpanel" id="live-variables-panel" tabIndex={0}
      aria-labelledby={session?.scopes.some(item => item.id === scope) ? scopeTabId(scope) : undefined}
      aria-label={session?.scopes.some(item => item.id === scope) ? undefined : "Variables"}
      aria-busy={busy || undefined}>
      <table className="liveVariablesTable">
        <thead><tr><th>Variable</th><th>Value</th></tr></thead>
        <tbody>{(page?.scope === scope && page.start === start ? page.variables : []).map(variable => <tr key={variable.index}>
          <td>{variable.name}</td>
          <td>{editing === variable.index ? <form className="liveVariableEdit" onSubmit={event => { event.preventDefault(); void apply(); }}>
            <input className="input" value={draft} onChange={event => setDraft(event.target.value)} autoFocus disabled={busy || !paused}
              aria-label={"Value for " + variable.name} onKeyDown={event => { if (event.key === "Escape") setEditing(null); }} />
            <button className="btn small" type="submit" disabled={busy || !paused}>Apply</button>
          </form> : <button className="liveVariableValue" disabled={busy || !paused || !variable.editable}
            aria-label={"Edit " + variable.name} onClick={() => {
              let value = variable.value;
              if (variable.type === "string") { try { const parsed = JSON.parse(value); if (typeof parsed === "string") value = parsed; } catch {} }
              setDraft(value); setEditing(variable.index);
            }}>{variable.value || "—"}</button>}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <div className="liveVariablesFooter">
      <button className="btn small" disabled={busy || start === 0} onClick={() => { setStart(Math.max(0, start - 64)); setEditing(null); }}>Previous</button>
      <span className="muted">{page ? page.total ? String(start + 1) + "–" + Math.min(start + 64, page.total) + " of " + page.total : "0 variables" : ""}</span>
      <button className="btn small" disabled={busy || !page || start + 64 >= page.total} onClick={() => { setStart(start + 64); setEditing(null); }}>Next</button>
    </div>
  </main>;
}
