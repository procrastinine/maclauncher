import React, { useEffect, useState } from "react";
import { XIcon } from "../icons";
import type { LauncherApi, LauncherSettings } from "../types";
import { fromKeyboardEvent, validate, ACTION_HELP } from "../../../../modules/shared/graphics-shortcuts.mjs";
import { HelpTip } from "./HelpTip";

type ShortcutStatus = {action: string; label: string; accelerator: string | null; reason?: string};
export type GraphicsShortcutApi = Partial<Pick<LauncherApi, "getGraphicsShortcuts" | "chooseScreenshotFolder">>;

// macOS menu glyphs for a canonical accelerator, such as ⌃⌥⌘B.
const GLYPHS: Record<string, string> = {Control: "⌃", Option: "⌥", Shift: "⇧", Command: "⌘", Return: "↩", Escape: "⎋", Space: "Space", Up: "↑", Down: "↓", Left: "←", Right: "→",
  Backspace: "⌫", Delete: "⌦", Tab: "⇥"};
const display = (accelerator: string) => accelerator.split("+").map(part => GLYPHS[part] ?? part).join("");

/** Shortcut recorders for every graphics shortcut action that has a handler, and the screenshot folder. */
export function GraphicsShortcutSettings({api, settings, onSetLauncherSettings}: {
  api?: GraphicsShortcutApi; settings: LauncherSettings; onSetLauncherSettings: (patch: Record<string, any>) => void;
}) {
  const assigned = settings.graphicsShortcuts || {};
  const [actions, setActions] = useState<ShortcutStatus[]>([]);
  const [recording, setRecording] = useState<string | null>(null);
  const [problem, setProblem] = useState<{action: string; reason: string} | null>(null);
  const assignedKey = JSON.stringify(assigned);
  useEffect(() => {
    let active = true;
    api?.getGraphicsShortcuts?.().then(value => {if (active) setActions(value);}, () => {});
    return () => {active = false;};
  }, [api, assignedKey]);
  useEffect(() => {
    if (!recording) return;
    const listener = (event: KeyboardEvent) => {
      event.preventDefault();event.stopPropagation();
      if (event.key === "Escape" && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) { setRecording(null);return; }
      const accelerator = fromKeyboardEvent(event);
      if (!accelerator) return;
      const checked = validate(recording, accelerator, assigned);
      if (!checked.ok) { setProblem({action: recording, reason: checked.reason});return; }
      setProblem(null);setRecording(null);
      onSetLauncherSettings({graphicsShortcuts: {...assigned, [recording]: checked.accelerator}});
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [recording, assignedKey, onSetLauncherSettings]);
  if (!actions.length) return null;
  const clear = (action: string) => {
    const {[action]: _removed, ...rest} = assigned;
    onSetLauncherSettings({graphicsShortcuts: rest});
  };
  const folder = settings.graphicsScreenshotFolder;
  return <>
    {actions.map(item => <div className="settingsRow" key={item.action}>
      <div className="settingsLabel">{item.label}{item.action === "bypass" && <HelpTip label="About the bypass shortcut">Turns the frontmost game's graphics off or back on, like the Graphics checkbox.</HelpTip>}
        {(ACTION_HELP as Record<string, string>)[item.action] && <HelpTip label={"About " + item.label}>{(ACTION_HELP as Record<string, string>)[item.action]}</HelpTip>}
        {item.action === "screenshot" && <HelpTip label="About the screenshot shortcut">Saves the frontmost game's final processed image as a PNG file. The performance overlay is not included.</HelpTip>}</div>
      <div className="settingsControl">
        <button type="button" className="btn small" aria-pressed={recording === item.action}
          onClick={() => {setProblem(null);setRecording(recording === item.action ? null : item.action);}}>
          {recording === item.action ? "Press Shortcut…" : item.accelerator ? display(item.accelerator) : "Record Shortcut"}
        </button>
        {item.accelerator && recording !== item.action && <button type="button" className="btn small iconOnly" title="Clear" aria-label={`Clear ${item.label} shortcut`} onClick={() => clear(item.action)}><XIcon /></button>}
        {problem?.action === item.action && <span className="detailMeta" role="alert">{problem.reason}</span>}
        {!problem && item.reason && <span className="detailMeta" role="status">{item.reason}</span>}
      </div>
    </div>)}
    {actions.some(item => item.action === "screenshot") && <div className="settingsRow">
      <div className="settingsLabel">Screenshot folder</div>
      <div className="settingsControl">
        <span className="detailValue" title={folder || "~/Pictures/MacLauncher"}>{folder || "Pictures → MacLauncher"}</span>
        {api?.chooseScreenshotFolder && <button type="button" className="btn small" onClick={() => void api.chooseScreenshotFolder!().then(chosen => {
          if (chosen) onSetLauncherSettings({graphicsScreenshotFolder: chosen});}, () => {})}>Choose…</button>}
        {folder && <button type="button" className="btn small" onClick={() => onSetLauncherSettings({graphicsScreenshotFolder: null})}>Default</button>}
      </div>
    </div>}
  </>;
}
