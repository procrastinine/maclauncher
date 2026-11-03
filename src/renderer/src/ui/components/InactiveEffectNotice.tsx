import React from "react";
import type {EffectCatalogRow, VideoEffectNode} from "../types";
import type {EffectsEditor} from "../useEffectsEditor";
import {implementationName} from "../../../../modules/shared/effects/presentation.mjs";
import {replacementFor} from "../effects-catalog";

// A saved row whose frame source can never supply its method's inputs says
// why it is inactive and offers the working method of its kind.
export function InactiveEffectNotice({editor, node, choice, className = ""}: {
  editor: EffectsEditor; node: VideoEffectNode; choice?: EffectCatalogRow; className?: string;
}) {
  if (!node.enabled || !choice?.sourceUnsupported) return null;
  const replacement = replacementFor(choice, editor.catalog), type = editor.typeOf(node);
  return <div className={["detailMeta effectInactive", className].filter(Boolean).join(" ")} role="status">
    <span>{choice.reason}</span>
    {replacement && <button type="button" className="btn small" onClick={() => void editor.changeMethod(node.id, replacement)}>
      Use {implementationName(replacement, type)}</button>}
  </div>;
}
