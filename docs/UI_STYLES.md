# UI styles and code map

This guide documents where launcher UI styles and button definitions live so you can change them quickly.

## Global styling (single source)
All launcher styling is in `src/renderer/src/ui/styles.css`.

Key areas:
- `:root` tokens: typography, radii, surfaces, borders, and control sizing.
- Global components: `.btn`, `.btn.small`, `.btn.iconOnly`, `.btn.primary`, `.btn.danger`, `.btn.icon`.
- Links and inputs: `.link`, `.input`, `.inputSmall`, `.inlineCheck`.
- Layout primitives: `.detailRow`, `.modal`, `.runtimeSectionCard`, `.settingsSection`.
- Game search row: `.gameSearch`, `.gameSearchFieldWrap`, `.gameSearchToggleIcon`, `.gameSearchDropdown`, `.gameSearchDropdownHeader`, `.gameSearchDropdownTitle`, `.gameTypeCheck`.

If you need a visual change, start with the token in `:root` and then the component class.

## Global button behavior
Button styling is centralized in `src/renderer/src/ui/styles.css`:
- `.btn` covers default buttons and shared states.
- `.btn.small` for compact buttons.
- `.btn.iconOnly` for icon buttons (close, refresh, remove).
- `.btn.primary` and `.btn.danger` for emphasis.
- `.link` for text-style actions.

Icon sizes are centralized in `src/renderer/src/ui/styles.css`:
- `:root` tokens `--icon-size`, `--icon-size-sm`, and `--icon-size-detail` control icon scale.
- Button sizing lives under `--icon-button-size*` plus the `.btn.iconOnly svg` rule.
- Detail panel icon buttons use the `.detailActions` override with `--icon-size-detail`.
- `RefreshIcon` and `XIcon` are shared SVGs in `src/renderer/src/ui/App.tsx` and default to `1em`.

## Module-specific buttons
Per-module button definitions live in each module manifest:
- `src/modules/<moduleId>/manifest.json` -> `ui.actions` and `ui.actionGroups`.
- Each action can set `label`, `kind`, `icon`, `iconOnly`, `hiddenWhen`, and `disabledWhen`.
- Action results are surfaced via `resultFields`.

Module action behavior is implemented in:
- `src/modules/<moduleId>/main.js` -> `actions` handlers.

The launcher renders these actions in `src/renderer/src/ui/App.tsx` under the module action group block.

## Common edit paths
- Change button visuals: `src/renderer/src/ui/styles.css` (`.btn*` + `:root` tokens).
- Change icon sizes: `src/renderer/src/ui/styles.css` (`--icon-size*`, `--icon-button-size*`).
- Add/rename module buttons: `src/modules/<moduleId>/manifest.json` (`ui.actions`).
- Change action logic: `src/modules/<moduleId>/main.js` (`actions`).

See `docs/UI_GUIDE.md` for the full UI surface walkthrough.
