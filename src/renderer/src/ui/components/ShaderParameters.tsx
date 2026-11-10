import React, { useEffect, useId, useRef, useState } from "react";
import type { GameReShadeSettings, ShaderParameter, ShaderParameterSchema } from "../types";
import { GraphicsNumber } from "./GraphicsNumber";
import { HelpTip } from "./HelpTip";
import { ErrorText } from "./ErrorText";
import { FolderIcon } from "../icons";
import { formatShaderOptions, importShaderOptions } from "../../../../modules/shared/effects/shader-options.mjs";

/** Reads a chosen preset file and the clipboard for Import, Copy and Paste options. */
export type ShaderOptionsTransfer = {
  importFile: () => Promise<{ name: string; text: string } | null>;
  readText: () => Promise<string>;
  writeText: (text: string) => Promise<unknown>;
};

export function ShaderParameters({ gamePath, settings, live, onChange, loadParameters, idPrefix = "shader", disclosure = true, after, transfer }: {
  gamePath: string; settings?: GameReShadeSettings; live: boolean;
  onChange: (path: string, patch: Partial<GameReShadeSettings>) => Promise<void>;
  loadParameters: () => Promise<ShaderParameterSchema>;
  idPrefix?: string;
  disclosure?: boolean;
  /** Controls that depend on the compiled program, shown after its parameters. */
  after?: (loaded: ShaderParameterSchema) => React.ReactNode;
  /** Import, Copy and Paste options at the end of the parameters. */
  transfer?: ShaderOptionsTransfer;
}) {
  const [parameters, setParameters] = useState<ShaderParameter[] | null>(null);
  const [loaded, setLoaded] = useState<ShaderParameterSchema | null>(null);
  const [expanded, setExpanded] = useState(!disclosure);
  const controlsId = useId();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [transferring, setTransferring] = useState(false), [transferNotice, setTransferNotice] = useState("");
  type Values = Record<string, number[]>;
  // One control's component, several parameters from imported options, or a reset (null).
  type Edit = { parameter: ShaderParameter; component: number; value: number } | { values: Values } | null;
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
    if ("values" in edit) return {...values, ...edit.values};
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
          if (edit && "values" in edit) {
            for (const [name, components] of Object.entries(edit.values))
              if (JSON.stringify(state.saved[name]) === JSON.stringify(before[name])) state.saved = {...state.saved, [name]: components};
          } else if (edit) {
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
  // Import and Paste apply matched values as one parameter edit; text that
  // matches nothing changes nothing and its reason is shown.
  async function transferOptions(action: "import" | "copy" | "paste") {
    if (!transfer || !parameters?.length || transferring) return;
    setTransferring(true);setTransferNotice("");setError("");
    try {
      if (action === "copy") {
        await transfer.writeText(formatShaderOptions({parameters, values: displayed, effectFile: loaded?.effectFile}));
        if (mounted.current) setTransferNotice(`Copied ${parameters.length} option${parameters.length === 1 ? "" : "s"}.`);
        return;
      }
      const file = action === "import" ? await transfer.importFile() : null;
      if (action === "import" && !file) return;
      const text = file ? file.text : await transfer.readText();
      if (!mounted.current) return;
      if (!text.trim()) throw new Error("The clipboard has no text.");
      const result = importShaderOptions(text, {parameters, values: displayed, effectFile: loaded?.effectFile, source: file?.name});
      enqueue({values: result.values});setTransferNotice(result.message);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "Shader options could not be read.");
    } finally { if (mounted.current) setTransferring(false); }
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
    {transfer && Boolean(parameters?.length) && <div className="detailActions shaderOptionsTransfer">
      <button type="button" className="btn iconOnly" title="Import options…" aria-label="Import options…" disabled={transferring}
        onClick={() => void transferOptions("import")}><FolderIcon /></button>
      <button type="button" className="btn small" disabled={transferring} onClick={() => void transferOptions("copy")}>Copy options</button>
      <button type="button" className="btn small" disabled={transferring} onClick={() => void transferOptions("paste")}>Paste options</button>
      <HelpTip label="About shader options">Import reads matching values from a RetroArch .slangp or ReShade .ini preset. Copy writes this shader's values as preset text, and Paste reads the same text or preset text copied elsewhere.</HelpTip>
    </div>}
    {transferNotice && <p className="detailMeta" role="status">{transferNotice}</p>}
    {loaded && after?.(loaded)}
    </div>
  </div>;
}
