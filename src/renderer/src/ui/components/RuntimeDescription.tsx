import React from "react";
import type { ModuleManifest, RuntimeId } from "../types";
import { resolveRuntimeEntry } from "../ui-helpers";
import { HelpTip } from "./HelpTip";

export function RuntimeDescription({ moduleInfo, runtimeId }: { moduleInfo?: ModuleManifest | null; runtimeId: RuntimeId }) {
  const runtime = resolveRuntimeEntry(moduleInfo, runtimeId);
  if (!runtime || ![runtime.description, runtime.requirements, runtime.preparation, runtime.dataNotice].some(Boolean)) return null;
  return <HelpTip label="About this runtime">
    {runtime.description && <p>{runtime.description}</p>}
    {runtime.requirements && <p>{runtime.requirements}</p>}
    {runtime.preparation && <p>{runtime.preparation}</p>}
    {runtime.dataNotice && <p>{runtime.dataNotice}</p>}
  </HelpTip>;
}
