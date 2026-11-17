import React from "react";
import type { ModuleManifest, RuntimeId } from "../types";
import { resolveRuntimeEntry } from "../ui-helpers";
import { HelpTip } from "./HelpTip";

// Beside a label the description is a help popover; in a settings panel it is
// plain text at the top, so no help icon stands apart from what it explains.
/** The runtime's description paragraphs, or null when it has none. */
export function runtimeDescriptionParagraphs(moduleInfo: ModuleManifest | null | undefined, runtimeId: RuntimeId) {
  const runtime = resolveRuntimeEntry(moduleInfo, runtimeId);
  if (!runtime || ![runtime.description, runtime.requirements, runtime.preparation, runtime.dataNotice].some(Boolean)) return null;
  return <>
    {runtime.description && <p>{runtime.description}</p>}
    {runtime.requirements && <p>{runtime.requirements}</p>}
    {runtime.preparation && <p>{runtime.preparation}</p>}
    {runtime.dataNotice && <p>{runtime.dataNotice}</p>}
  </>;
}
export function RuntimeDescription({ moduleInfo, runtimeId, text = false }: { moduleInfo?: ModuleManifest | null; runtimeId: RuntimeId; text?: boolean }) {
  const paragraphs = runtimeDescriptionParagraphs(moduleInfo, runtimeId);
  if (!paragraphs) return null;
  return text ? <div className="runtimeDescriptionText">{paragraphs}</div> : <HelpTip label="About this runtime">{paragraphs}</HelpTip>;
}
