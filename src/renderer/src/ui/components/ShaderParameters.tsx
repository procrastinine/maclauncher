import React, { useEffect, useId, useRef, useState } from "react";
import type { GameReShadeSettings, ShaderParameter, ShaderParameterSchema } from "../types";
import { GraphicsNumber } from "./GraphicsNumber";
import { HelpTip } from "./HelpTip";
import { ErrorText } from "./ErrorText";

export function ShaderParameters({ gamePath, settings, live, onChange, loadParameters, idPrefix = "shader", disclosure = true, after }: {
  gamePath: string; settings?: GameReShadeSettings; live: boolean;
  onChange: (path: string, patch: Partial<GameReShadeSettings>) => Promise<void>;
  loadParameters: () => Promise<ShaderParameterSchema>;
  idPrefix?: string;
  disclosure?: boolean;
  /** Controls that depend on the compiled program, shown after its parameters. */
  after?: (loaded: ShaderParameterSchema) => React.ReactNode;
}) {
  const [parameters, setParameters] = useState<ShaderParameter[] | null>(null);
  const [loaded, setLoaded] = useState<ShaderParameterSchema | null>(null);
  const [expanded, setExpanded] = useState(!disclosure);
  const controlsId = useId();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  type Values = Record<string, number[]>;
  type Edit = { parameter: ShaderParameter; component: number; value: number } | null;
  type Write = {edit: Edit; onChange: typeof onChange; gamePath: string};
  const [, refresh] = useState(0);
  const mounted = useRef(true), loadRequest = useRef(0);
  const writes = useRef({ observed: settings?.parameters, saved: settings?.parameters || {} as Values, pending: [] as Write[], active: false, onChange });
  const state = writes.current;
  state.onChange = onChange;
  useEffect(() => {
    mounted.current = true;
    return () => {mounted.current = false;loadRequest.current++;state.pending.length = 0;};
  }, []);
  if (state.observed !== settings?.parameters) {
    state.observed = settings?.parameters;
    state.saved = settings?.parameters || {};
  }
  function apply(values: Values, edit: Edit): Values {
    if (!edit) return {};
    const components = [...(values[edit.parameter.name] || edit.parameter.default)];
    components[edit.component] = edit.value;
    return {...values, [edit.parameter.name]: components};
  }
  const displayed = state.pending.reduce((values, write) => apply(values, write.edit), state.saved);
  async function drain() {
    if (state.active) return;
    state.active = true;
    while (mounted.current && state.pending.length) {
      const {edit, onChange: save, gamePath: path} = state.pending[0], before = state.saved, next = apply(before, edit);
      try {
        await save(path, {parameters: edit ? next : null});
        if (mounted.current) {
          if (edit) {
            const previous = (before[edit.parameter.name] || edit.parameter.default)[edit.component];
            const current = (state.saved[edit.parameter.name] || edit.parameter.default)[edit.component];
            if (current === previous) state.saved = apply(state.saved, edit);
          } else {
            const retained = {...state.saved};
            for (const name of Object.keys(before)) if (JSON.stringify(retained[name]) === JSON.stringify(before[name])) delete retained[name];
            state.saved = retained;
          }
        }
      } catch (error) {if (mounted.current) setError(error instanceof Error ? error.message : "Shader parameters could not be saved.");}
      if (!mounted.current) break;
      state.pending.shift();refresh(value => value + 1);
    }
    state.active = false;
  }
  function enqueue(edit: Edit) {
    if (!mounted.current) return;
    state.pending.push({edit, onChange: state.onChange, gamePath});setError("");refresh(value => value + 1);void drain();
  }
  async function load() {
    if (!mounted.current) return;
    const token = ++loadRequest.current, current = () => mounted.current && token === loadRequest.current;
    setBusy(true);setError("");
    try {
      const result = await loadParameters();if (current()) {setParameters(result.parameters);setLoaded(result);}
    }
    catch (e) { if (current()) setError(e instanceof Error ? e.message : "Shader parameters could not be loaded."); }
    finally { if (current()) setBusy(false); }
  }
  function change(parameter: ShaderParameter, component: number, value: number) {
    if (!Number.isFinite(value)) return;
    if (parameter.min !== undefined && value < parameter.min || parameter.max !== undefined && value > parameter.max) return;
    enqueue({parameter, component, value});
  }
  useEffect(() => {if (!disclosure) {setExpanded(true);void load();}}, [disclosure]);
  function toggle() {
    setExpanded(!expanded);
    if (!expanded && parameters === null && !busy) void load();
  }
  return <div className="shaderParameters">
    <div className="detailActions shaderParameterActions">
      {disclosure && <button className="btn small" aria-expanded={expanded} aria-controls={controlsId} onClick={toggle}>{expanded ? "Hide parameters" : "Shader parameters…"}</button>}
      {expanded && Boolean(parameters?.length) && <button className="btn small" onClick={() => enqueue(null)}>Reset parameters</button>}
      <HelpTip label="About shader parameters">{live ? "Changes apply while the effect is running." : "Changes apply on the next launch."}</HelpTip>
    </div>
    <div id={controlsId} hidden={!expanded}>
    {busy && <p className="detailMeta" role="status">Loading parameters…</p>}
    <ErrorText error={error} inline />
    {parameters?.length === 0 && <p className="detailMeta">No adjustable parameters.</p>}
    {parameters?.map(parameter => <div className="detailRow detailControlRow" key={parameter.name}>
      <label className="detailLabel" htmlFor={`${idPrefix}-${parameter.name}-0`}>{parameter.label}{parameter.description && <HelpTip label={`About ${parameter.label}`}>{parameter.description}</HelpTip>}</label>
      <div className="detailActions">{parameter.default.map((fallback, i) => {
        const value = displayed[parameter.name]?.[i] ?? fallback;
        return parameter.type === "bool" ? <input key={i} id={`${idPrefix}-${parameter.name}-${i}`} type="checkbox" checked={value !== 0}
          aria-label={`${parameter.label}${parameter.default.length > 1 ? ` ${i + 1}` : ""}`} onChange={e => change(parameter, i, e.target.checked ? 1 : 0)} />
          : parameter.options?.length ? <select key={i} id={`${idPrefix}-${parameter.name}-${i}`} className="input" value={value}
            aria-label={`${parameter.label}${parameter.default.length > 1 ? ` ${i + 1}` : ""}`} onChange={e => change(parameter, i, Number(e.target.value))}>
            {parameter.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          : <GraphicsNumber key={i} id={`${idPrefix}-${parameter.name}-${i}`} className="input" value={value}
            aria-label={`${parameter.label}${parameter.default.length > 1 ? ` ${i + 1}` : ""}`} min={parameter.min} max={parameter.max}
            step={parameter.step || (parameter.type === "int" ? 1 : "any")} onValue={value => change(parameter, i, value)} />;
      })}</div>
    </div>)}
    {loaded && after?.(loaded)}
    </div>
  </div>;
}
