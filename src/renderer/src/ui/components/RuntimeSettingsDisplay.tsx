import React from "react";
import type { RuntimeSettingField } from "../types";

export function RuntimeSettingsDisplay({ field }: { field: RuntimeSettingField }) {
  return <div className="settingsRow settingsDisplayRow">
    <div className="settingsLabel">{field.label}</div>
    <div className="settingsControl"><div>
      {field.description && <p className="muted">{field.description}</p>}
      <table className="settingsDisplayTable" aria-label={field.label}><tbody>
        {(field.rows || []).map((row, index) => <tr key={index}><th scope="row">{row.label}</th><td>{row.value}</td></tr>)}
      </tbody></table>
    </div></div>
  </div>;
}
