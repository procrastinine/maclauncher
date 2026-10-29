import React from "react";
import {HelpTip} from "./HelpTip";
import {availabilityLabel,formatRuntimeVersionTag,formatUserError} from "../ui-helpers";
import {runtimeRemovalPresentation} from "./runtime-tabs-model";
import {modelPresentation} from "../../../../modules/shared/effects/presentation.mjs";

export function RuntimeModelTable({actions,installed,section,busy,onInstall,onRemove,onDefault}:{
  actions:Record<string,any>[];installed:Record<string,any>[];section:Record<string,any>;busy:boolean;
  onInstall:(id:string)=>void;onRemove:(row:Record<string,any>)=>void;onDefault:(row:Record<string,any>,selectionId:string)=>void;
}) {
  const represented=new Set(actions.map(action=>action.installedVersion).filter(Boolean));
  const all=[...actions.map(action=>({action,model:installed.find(model=>model.version===action.installedVersion)})),
    ...installed.filter(model=>!represented.has(model.version)).map(model=>({action:undefined,model}))];
  // Installed models lead; downloads not yet installed follow behind More
  // while any model is installed.
  const [expanded,setExpanded]=React.useState(false);
  const present=(row:typeof all[number])=>Boolean(row.model)||Boolean(row.action?.installed);
  const ordered=[...all.filter(present),...all.filter(row=>!present(row))];
  const rows=expanded||!all.some(present)?ordered:ordered.filter(present),hidden=ordered.length-rows.length;
  return <div className="filterLibraryScroll" role="region" aria-label="Neural model library" tabIndex={0}>
    <table className="filterLibraryTable runtimeModelTable"><thead><tr><th>Model</th><th>Input → output</th><th>Status</th><th>Default for</th><th>Actions</th></tr></thead>
      <tbody>{rows.map(({action,model})=>{
        const present=Boolean(model)||action?.installed,ready=model?.ready!==false;
        const defaults=model?(section.defaultSelections||[]).filter((row:Record<string,any>)=>row.compatibleVersions?.includes(model.version)):[];
        const presentation=modelPresentation(model?.operation||model?.method,model?.intrinsicScale);
        const name=action?.label||formatRuntimeVersionTag(model?.version,section),help=action?.description||model?.purpose||presentation.purpose;
        return <tr key={action?.id||model?.version}>
          <td>{name}{help&&<HelpTip label={`About ${name}`}>{help}</HelpTip>}</td>
          <td>{model?.inputOutputLabel||action?.inputOutputLabel||presentation.inputOutputLabel}</td>
          <td>{availabilityLabel(present?(ready?"installed":"unavailable"):"notInstalled")}
            {model?.error&&<HelpTip label={`About ${name} availability`}>{formatUserError(model.error)}</HelpTip>}</td>
          <td>{defaults.length?defaults.map((scope:Record<string,any>)=><label key={scope.id} className="inlineCheck runtimeModelDefault">
            <input type="radio" name={`model-default-${scope.id}`} aria-label={`Use ${name} for ${scope.label}`} checked={scope.version===model?.version} disabled={busy||!ready}
              onChange={()=>onDefault(model!,scope.id)}/>{scope.label}
          </label>):<span className="dim">—</span>}</td>
          <td><div className="detailActions">{!present&&action&&<button type="button" className="btn small" disabled={busy||action.available===false} onClick={()=>onInstall(action.id)}>Install</button>}
            {model&&model.removable!==false&&<button type="button" className="btn small" disabled={busy}
              title={runtimeRemovalPresentation(model,section).label} onClick={()=>onRemove(model)}>Remove</button>}
          </div></td>
        </tr>;
      })}{hidden>0&&<tr><td colSpan={5}><button type="button" className="implementationMore" aria-expanded="false" onClick={()=>setExpanded(true)}>More downloads ({hidden})…</button></td></tr>}
      {!rows.length&&<tr><td colSpan={5} className="dim">No compatible models in this operation.</td></tr>}</tbody>
    </table>
  </div>;
}
