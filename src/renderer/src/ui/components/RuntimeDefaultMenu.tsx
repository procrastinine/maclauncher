import React from "react";
import { Select } from "./Select";
import type { RuntimeDefaultChoice } from "./runtime-tabs-model";

// The one control for a runtime's default version, in the Installed header:
// Automatic or one installed version. Choosing Automatic clears a saved default.
export function RuntimeDefaultMenu({ id, label = "Default", ariaLabel, menu, disabled = false, onChoose }: {
  id: string; label?: string; ariaLabel?: string; disabled?: boolean;
  menu: { choices: RuntimeDefaultChoice[]; selected: string };
  onChoose: (choice: RuntimeDefaultChoice) => void;
}) {
  return <span className="runtimeDefaultControl">
    <label htmlFor={id}>{label}</label>
    <Select id={id} className="input inputSmall runtimeDefaultSelect" aria-label={ariaLabel} value={menu.selected} disabled={disabled}
      onChange={event => {
        const choice = menu.choices.find(item => item.value === event.target.value);
        if (choice && !choice.disabled) onChoose(choice);
      }}>
      {menu.choices.map(choice => <option key={choice.value || "automatic"} value={choice.value} title={choice.version || undefined} disabled={choice.disabled}>{choice.label}</option>)}
    </Select>
  </span>;
}
