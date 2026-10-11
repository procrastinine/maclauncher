# UI styles and code map

This guide maps launcher styles, components and module-defined controls.

## Global styling (single source)
All launcher styling is in `src/renderer/src/ui/styles.css`.

Key areas:
- `:root` tokens: typography, radii, surfaces, borders, and control sizing.
- Global components: `.btn`, `.btn.small`, `.btn.iconOnly`, `.btn.primary`, `.btn.danger`, `.btn.icon`.
- Links and inputs: `.link`, `.input`, `.inputSmall`, `.inlineCheck`.
- Layout primitives: `.detailRow`, `.launcherView`, `.launcherViewBody`, `.modal`, `.runtimeSectionCard`, `.settingsSection`.
- Master/detail layout: `.libraryLayout`, `.libraryPane`, `.detailsPane`, `.gameList`, `.gameDetails`.
- Library selection: `.gameListItems`, `.gameSelect`, `.gameItem.selected`, `.gameTags`, `.dragHandle`.
- Detail identity and row tools: `.gameDetailsHeader`, `.gameDetailsIdentity`, `.gameActions`.
- Global toolbar: `.workspaceToolbar`, `.libraryToolbar`, `.librarySearch`, `.librarySort`, `.gameSearchDropdown`, `.gameTypeCheck`.
- Selection: `.selectionToolbar`, `.selectionActions`, `.gameCheckbox`, `.missingLabel`.
- Settings tabs: `.settingsTabs`, `.settingsTab`, `.settingsView`.
- Dedicated window views: `.launcherViewHeader` and `.launcherViewBody` provide
  a compact title and scrolling content area, with native window controls.
- Runtime tabs: `.runtimeGroupTabs` and `.runtimeLineTabs` join without a gap;
  active tabs use the following panel's background and retain top/side borders.
  Both tab strips scroll horizontally, keep keyboard navigation, and have no vertical overflow.
  `ScrollableTabStrip` adds compact edge controls only while tabs overflow, retaining
  scroll position when shared state updates.
- Editor tabs: `.saveToolsTabs` shares horizontal-only overflow and nonshrinking labels
  between the native save editor and live-variable editor. Scope tabs identify their
  shared panel, keep the selected scope visible after resizing, and remain focusable
  during an edit while actions are guarded.
- Help: `.helpTipButton` is a 16px circular button. `.helpPopover` uses an opaque
  panel surface in the browser's top layer; `HelpTip.tsx` positions it beside its button,
  clamps it to the viewport, and closes it with Escape or an outside click.
- Favorites: `.favoriteButton`, `.favoriteButton.active`, `.libraryGroupLabel`.

Start visual changes with the relevant `:root` token, then the component class.

## Master/detail layout and component locations

- `src/renderer/src/ui/App.tsx`: library search/filter state, selection by game path, drag ordering,
  status effects, launcher IPC handlers, dedicated view routing and modals. Mounts one selected detail component beside the library.
  Settings, Runtimes and Credits render in separate native windows; the library remains visible and usable.
- `src/renderer/src/ui/components/GameRow.tsx`: compact library entry, badges, native selection button,
  reorder handle, favorite star, and all quick actions. The selection button is a sibling of the action controls, so buttons
  are not nested and action clicks do not change selection.
- `src/renderer/src/ui/components/GameDetails.tsx`: selected game identity, runtime/save paths and
  selectors, library and Tools patching, module info fields, action groups, results, and errors.
- `src/renderer/src/ui/components/GameActions.tsx`: row tools and shared `PlayButton`.
  Installation displays only real bounded progress; preparation uses Starting and
  a spawned process retains Stop even if a preparation update is still present.
- `src/renderer/src/ui/components/ModuleTools.tsx`: metadata-driven action groups;
  groups marked `collapsed` open under a disclosure, and result fields stay under Details.
  Missing fields are omitted while valid false/zero values remain available.
- `src/renderer/src/ui/components/RuntimeSettingsWindow.tsx`: one runtime settings
  form shared by native settings windows and the inline Settings tabs. Inline forms
  use the tab's label and omit repeated window titles and scope subtitles.
- `src/renderer/src/ui/components/LiveVariablesWindow.tsx`: native live-variable editor,
  scope tabs, paused editing and paging. The scrollable table is the selected tab's panel.
- `src/renderer/src/ui/components/LibraryToolbar.tsx`: global search, scope, backend filter toggle,
  sorting, reverse direction, and inspector toggle.
- `src/core/library-view.mjs`: UI-safe sort normalization, stable ordering and Default drag previews.
- `src/core/library-state.js`: persisted favorites/sort, manual ordering, and entry update semantics.
- `src/core/library-selection.mjs`: selection ranges in the visible order.
- `src/core/library-maintenance.js`: scoped missing-path detection and batch Trash results.
- `src/renderer/src/ui/components/library-actions.ts`: typed callbacks shared by library components.
- `src/renderer/src/ui/ui-helpers.ts`: shared formatting, conditions, runtime/default resolution.
- `src/renderer/src/ui/components/SettingsView.tsx`, `RuntimesView.tsx` and `CreditsView.tsx`: dedicated window contents using the existing module-driven forms, managers and credits.
- `src/renderer/src/ui/components/LauncherViewHeader.tsx`: compact view identity and actions.
- `src/main/utility-windows.js`: singleton native window lifecycle with shared launcher-state delivery; settings persistence stays in the existing service.
- `src/core/utility-window-model.mjs`: shared route validation and window metadata, callable without Electron.
- `src/renderer/src/ui/components/modals/`: save and cheat surfaces.
- `src/renderer/src/ui/components/runtime-tabs-model.ts`: metadata-driven groups,
  selection and compact version summaries. Runtimes keeps version choices and
  actions visible; source, counts and check time live in the Versions help popover.

`GameRow`, `GameDetails`, and their shared actions use React memoization with stable callbacks from
`App`. The row receives its own running/selection flags and relevant settings rather than the full
launcher state. Detail action groups, runtime version lists, and library dependencies are built only
for the selected game. Modal drafts and runtime-manager UI updates do not rebuild unchanged rows
or details. See React's [memo](https://react.dev/reference/react/memo) and
[useCallback](https://react.dev/reference/react/useCallback) references for the prop-identity rules.

The app occupies the window height. `.libraryLayout` uses the full width until selection opens
the inspector. `.libraryLayout.hasDetails` gives the library three fifths of the space and
the inspector two fifths, with independent scrolling; the 1080px media query stacks the panes.
Minimum pane heights plus layout overflow keep controls reachable in short windows. The detail
header stays outside its scroll body. `.detailControlRow` puts a label and its selectors on one
line; `.detailToolRow` wraps engine actions and places results beneath them only when present.
The empty library's `.dropHintEmpty` centers its bounded format hint in the available pane.
Rows and fields use subtle dividers with no nested rounded cards. Paths truncate at the shared
small text size with full paths in title tooltips. Regular game rows are about 62px high. Below
600px, quick actions move beneath the identity to remain reachable.

## Global button behavior
Button styling is centralized in `src/renderer/src/ui/styles.css`:
- `.btn` covers default buttons and shared states.
- `.btn.small` for compact buttons.
- `.btn.iconOnly` for icon buttons (close, refresh, remove).
- `.btn.primary` and `.btn.danger` for emphasis.
- `.link` for text-style actions.
- Native selection uses `.gameSelect` with `aria-pressed` and `aria-controls="game-details"`.
  It is master/detail selection, not a tab interface. Runtime-manager tabs retain their existing
  `.runtimeTab` styling and tab semantics.
- `:focus-visible` outlines buttons and the keyboard-scrollable detail body.

Icon sizes are centralized in `src/renderer/src/ui/styles.css`:
- `:root` tokens `--icon-size`, `--icon-size-sm`, and `--icon-size-detail` control icon scale.
- Button sizing lives under `--icon-button-size*` plus the `.btn.iconOnly svg` rule.
- Detail panel icon buttons use the `.detailActions` override with `--icon-size-detail`.
- `RefreshIcon` and `XIcon` are shared SVGs in `src/renderer/src/ui/icons.tsx` and default to `1em`.

## Module-specific buttons
Per-module button definitions live in each module manifest:
- `src/modules/<moduleId>/manifest.json` -> `ui.actions` and `ui.actionGroups`.
- Each action can set `label`, `kind`, `icon`, `iconOnly`, `hiddenWhen`, and `disabledWhen`.
- Action results are surfaced via `resultFields`.

Module action behavior is implemented in:
- `src/modules/<moduleId>/main.js` -> `actions` handlers.

The launcher renders these actions in `src/renderer/src/ui/components/GameDetails.tsx` under
the module action group block. IPC handling and confirmations remain in `App.tsx`.

## Common edit paths
- Change button visuals: `src/renderer/src/ui/styles.css` (`.btn*` + `:root` tokens).
- Change icon sizes: `src/renderer/src/ui/styles.css` (`--icon-size*`, `--icon-button-size*`).
- Change list selection or row content: `src/renderer/src/ui/components/GameRow.tsx`.
- Change detail controls or group rendering: `src/renderer/src/ui/components/GameDetails.tsx`.
- Change shared game tools: `src/renderer/src/ui/components/GameActions.tsx`.
- Change search/sort controls: `src/renderer/src/ui/components/LibraryToolbar.tsx`.
- Change sort/group semantics: `src/core/library-view.mjs` and `src/core/library-state.js`.
- Add/rename module buttons: `src/modules/<moduleId>/manifest.json` (`ui.actions`).
- Change action logic: `src/modules/<moduleId>/main.js` (`actions`).

See `docs/UI_GUIDE.md` for the full UI surface walkthrough.

## App identity

- Vector source: `src/renderer/src/ui/assets/maclauncher.svg`, used beside MacLauncher in the header.
  The large controller/play silhouette stays legible at Dock sizes; the README uses the same source.
- Dock raster: `src/resources/maclauncher.png` (1024px), loaded for launcher windows in development
  and copied through extraResources for packaged apps.
- macOS bundle icon: `build/icon.icns`, discovered by electron-builder from buildResources.
  The default Electron artwork is replaced without adding a production dependency.
- Regenerate the raster with `rsvg-convert -w 1024 -h 1024`, create the standard macOS iconset sizes
  with `sips`, then use `iconutil -c icns`. The generated PNG and ICNS are checked-in assets.
