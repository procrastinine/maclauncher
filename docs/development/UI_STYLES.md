# UI styles and code map

This page lists where the launcher's styles, components and module-defined controls live in the source. The [UI guide](UI_GUIDE.md) describes the windows and controls themselves.

## Stylesheets and tokens

Shared launcher styling and design tokens are in `src/renderer/src/ui/styles.css`. The External window's table, store forms and download panels use the same tokens in `src/renderer/src/ui/components/SteamView.css`. Component classes take their visual values from the shared `:root` tokens.

The `:root` tokens set typography, corner radii, surfaces, borders and control sizes. Their default values form the dark palette. A `prefers-color-scheme: light` block overrides the color tokens (`--bg`, `--panel`, `--text`, the accents, surfaces, borders, status text and shadows) for the light palette. The Appearance setting drives that media query through Electron's native theme, so every launcher window, including External and Credits, follows the same choice. External's own foreground colors in `SteamView.css` use `light-dark()` pairs. New launcher, save editor and live-variable windows open with a background that matches the current appearance before their content loads.

## Class reference

### Controls

- Buttons: `.btn`, `.btn.small`, `.btn.iconOnly`, `.btn.primary`, `.btn.danger` and `.btn.icon`; see [buttons and icons](#buttons-and-icons).
- Links and inputs: `.link`, `.input`, `.inputSmall` and `.inlineCheck`. Checkboxes and radio buttons use `--accent` instead of the system accent color. Boolean settings use the shared `Toggle` (`.inlineCheck.settingsToggle`) from `FieldRow.tsx`.
- Menus and popovers: `Popover.tsx` provides `PopoverButton` and `MenuButton` on top of native `popover="auto"` panels (`.menuPopover`), which close on an outside click or Escape. The library's Game types menu, the Runtimes download manager and the Graphics **⋯** menu use them.
- Help: `.helpTipButton` is a 16px round button. `.helpPopover` is an opaque panel in the browser's top layer; `HelpTip.tsx` positions it beside its button, keeps it inside the viewport and closes it on Escape or an outside click.

### Layout

- Layout primitives: `.detailRow`, `.fieldRow`, `.launcherView`, `.launcherViewBody`, `.modal`, `.runtimeSectionCard` and `.settingsSection`. Field rows share the `--field-label` column. `.detailLabel` stays on one line and ends in an ellipsis when truncated; a help button in the label stays visible. Shader parameter names still wrap.
- Library and inspector: `.libraryLayout`, `.libraryPane`, `.detailsPane`, `.gameList` and `.gameDetails`; see [library layout](#library-layout).
- Dedicated windows: `.launcherViewHeader` and `.launcherViewBody` give each window a compact title and a scrolling content area beside the native window controls.

### Library

- Rows and selection: `.gameListItems`, `.gameSelect`, `.gameItem.selected`, `.gameTags` and `.dragHandle`.
- Inspector header and row tools: `.gameDetailsHeader`, `.gameDetailsIdentity` and `.gameActions`.
- Global toolbar: `.workspaceToolbar`, `.libraryToolbar`, `.librarySearch`, `.librarySort`, `.gameSearchDropdown` and `.gameTypeCheck`.
- Selection mode: `.selectionToolbar`, `.selectionActions`, `.gameCheckbox` and `.missingLabel`.
- Favorites: `.favoriteButton`, `.favoriteButton.active` and `.libraryGroupLabel`.

### Settings and Runtimes

- Sidebar navigation: `.launcherSidebarLayout`, `.launcherSidebar`, `.launcherSidebarSearch`, `.launcherSidebarChoices` and `.launcherSidebarItem`. Runtimes headings use `.launcherSidebarSection` and `.launcherSidebarHeading`, and a section whose heading would repeat its single entry takes `.unlabeled` and shows a divider line instead. The search field stays above the choices, which scroll on their own, and the content panel keeps its selection and scroll position while the choices are filtered.
- Settings runtime tabs: `.settingsTabs`, `.settingsTab` and `.settingsView`.
- Runtime settings forms: `.settingsAdvanced`, with `.settingsAdvancedCount`, for the collapsed Advanced group, and `.settingsRuntimeHeading` for a game type with one runtime.
- Runtimes subtabs: `.runtimeLineTabs`, inside `.launcherSidebarContent`. Active subtabs share the background of the panel below and keep their top and side borders. Subtabs scroll horizontally, never vertically, and keep keyboard navigation. `ScrollableTabStrip` adds compact edge controls only while the tabs overflow, and keeps the scroll position when shared state updates.

### Editors and libraries

- Editor tabs: `.saveToolsTabs` gives the native save editor and the live-variable editor the same horizontal-only overflow and labels that do not shrink. Scope tabs identify their shared panel, keep the selected scope visible after resizing, and stay focusable during an edit while their actions are blocked.
- Shader library: `.filterLibraryToolbar`, `.filterLibraryTable` and `.filterLibraryInput` make up a semantic table with Name, Input → output, Origin / status and Actions columns. **Source** expands a `.filterLibrarySource` row. Its path control keeps compact text, clips the text horizontally and has a native file chooser, and the full path stays available in the input and its title.

## Library layout

The app fills the window height. `.libraryLayout` uses the full width until a selection opens the inspector. `.libraryLayout.hasDetails` gives the library three fifths of the width and the inspector two fifths, each scrolling on its own, and the 1080px media query stacks the panes. Minimum pane heights and layout overflow keep controls reachable in short windows.

Regular game rows are about 62px high. Below 600px, a row's quick actions move beneath its name to stay reachable. Paths are truncated at the shared small text size, with the full path in the title tooltip. Rows and fields use subtle dividers, without nested rounded cards. The empty library's `.dropHintEmpty` centers its format hint, which has a maximum size, in the pane.

The inspector header stays outside its scrolling body. `.detailControlRow` puts a label and its selectors on one line, and `.detailToolRow` wraps engine actions and places results beneath them only when there are results.

## Buttons and icons

Button and icon styling is centralized in `src/renderer/src/ui/styles.css`.

| Class | Use |
| --- | --- |
| `.btn` | Default buttons and shared states |
| `.btn.small` | Compact buttons |
| `.btn.iconOnly` | Icon buttons, such as close, refresh and remove |
| `.btn.primary`, `.btn.danger` | Emphasis |
| `.link` | Text-style actions |

`:focus-visible` outlines buttons and the detail body, which can be scrolled with the keyboard.

The library's selection button, `.gameSelect`, sets `aria-pressed` and `aria-controls="game-details"`. It is a master/detail selection without tab semantics, unlike the runtime-manager tabs, which use `.runtimeTab` styling with tab semantics.

Icon sizes:

- The `:root` tokens `--icon-size`, `--icon-size-sm` and `--icon-size-detail` set the icon scale.
- Button sizes come from the `--icon-button-size*` tokens and the `.btn.iconOnly svg` rule.
- Icon buttons in the inspector use the `.detailActions` override with `--icon-size-detail`.
- `RefreshIcon` and `XIcon` are shared SVGs in `src/renderer/src/ui/icons.tsx` and default to `1em`.
- Reload and Refresh actions use `RefreshIcon` with `iconOnly`, and keep the full action name in both `title` and `aria-label`.

## Components and source files

Renderer components in `src/renderer/src/ui/components/`:

- `App.tsx` (one level up, in `src/renderer/src/ui/`) holds the library's search and filter state, selection by game path, drag ordering, status effects, launcher IPC handlers, confirmations, routing to dedicated views, and modals. It mounts one detail component for the selected game beside the library. Settings, Runtimes and Credits render in separate native windows, and the library stays visible and usable.
- `GameRow.tsx` renders a compact library entry: badges, the native selection button, the reorder handle, the favorite star and all quick actions. The selection button is a sibling of the action controls, so buttons are never nested and clicking an action does not change the selection.
- `GameDetails.tsx` renders the selected game's identity, runtime and save paths and selectors, library and Tools patching, module info fields, action groups, results and errors, in the order Files, Launch, Patches, Tools, Graphics and Notes. `EffectsControls.tsx` renders the collapsible Graphics section, and `GameNotes.tsx` renders Notes.
- `GameActions.tsx` holds the row tools and the shared `PlayButton`. An unsupported Saves or Cheats action keeps a hidden `.actionSlot` placeholder of the same width. Installation shows only real progress values, and preparation shows Starting beside Cancel. A spawned process keeps Stop available before its first window, even while a preparation update is still showing.
- `ModuleTools.tsx` renders the action groups from module metadata. Groups marked `collapsed` open under a disclosure, and result fields stay under Details. Missing fields are left out, while valid false and zero values are shown.
- `EffectsControls.tsx` is the Simple and Advanced effects editor in the inspector. Its `.collapsibleSection.graphicsSection` header holds the section toggle, the `.collapsibleSummary` shown while closed, the chain checkbox, the application status and one `MenuButton` with the presets and Clear effects. A long status reason is truncated in the header, with its full text as the title. A Simple row's Needs attention badge sits on its own line below the picker. The menus, status and output settings read shared editor state from `useEffectsEditor.ts` and `useGraphicsStatus.ts`; the latter follows the main process's graphics status. Advanced is an ordered semantic list with independent enable, move, remove and settings controls, and its searchable Add effect chooser shows runtime and input requirements from the game's shared catalog. Opening the inspector only reads metadata, and edits store the Advanced plan. `ShaderParameters.tsx` handles both the Simple game selection and per-node parameter metadata without changing the selected effects mode.
- `ReShadeFilterLibrary.tsx` is the shader table in Runtimes → Effects → Shaders, with local edit drafts, queued save actions and native file pickers. Ordinary launcher-state updates supply the current names, paths and availability.
- `RuntimeSettingsWindow.tsx` is the runtime settings form shared by the native settings windows and the inline Settings panels. Inline forms use the tab's label and omit the window title and scope subtitle.
- `LiveVariablesWindow.tsx` is the native live-variable editor, with scope tabs, paused editing and paging. The scrollable table is the selected tab's panel.
- `LibraryToolbar.tsx` holds the global search, scope, game-type filter toggle, sorting, reverse direction and inspector toggle.
- `SettingsView.tsx`, `RuntimesView.tsx` and `CreditsView.tsx` are the contents of the dedicated windows, built from the module-driven forms, managers and credits.
- `SearchableSidebar.tsx` provides the shared Settings and Runtimes search, current-section navigation and Cmd-F focus. Its `sidebar-navigation-model.ts` matches metadata labels and runtime names and maps keyboard movement in the sidebar, independently of runtime catalogs.
- `runtime-tabs-model.ts` builds the groups, selection and compact version summaries from metadata. Runtimes keeps version choices and actions visible, and puts the source, counts and check time in the Versions help popover.
- `LauncherViewHeader.tsx` holds a view's compact identity and actions.
- `modals/` holds the save and cheat surfaces.
- `library-actions.ts` defines the typed callbacks shared by library components.

Other renderer, core and main-process files:

- `src/renderer/src/ui/ui-helpers.ts`: shared formatting, conditions, and runtime and default resolution.
- `src/core/library-view.mjs`: UI-safe sort normalization, stable ordering and Default drag previews.
- `src/core/library-state.js`: stored favorites and sort, manual ordering and entry update rules.
- `src/core/library-selection.mjs`: selection ranges in visible order.
- `src/core/library-maintenance.js`: missing-path detection within the current scope, and batch Trash results.
- `src/core/utility-window-model.mjs`: shared route validation and window metadata, usable without Electron.
- `src/main/utility-windows.js`: the lifetime of each single-instance native window and delivery of shared launcher state to it. Settings themselves are stored by the settings service.

`GameRow`, `GameDetails` and their shared actions use React memoization with stable callbacks from `App`. A row receives its own running and selection flags and the settings it needs, not the whole launcher state. Detail action groups, runtime version lists and library dependencies are built only for the selected game. Modal drafts and runtime-manager UI updates do not rebuild unchanged rows or details. React's [memo](https://react.dev/reference/react/memo) and [useCallback](https://react.dev/reference/react/useCallback) documentation defines the prop-identity rules.

## Module actions, inputs and errors

Module buttons are declared in each manifest, `src/modules/<moduleId>/manifest.json`, under `ui.actions` and `ui.actionGroups`. Each action can set `label`, `kind`, `icon`, `iconOnly`, `hiddenWhen` and `disabledWhen`, and returns results through `resultFields`. The handlers are the `actions` exported by the module's `main.js`. The [UI field and action schema](MODULES.md#ui-field-and-action-schema) describes every property.

`GameDetails.tsx` renders these actions in its module action group block, and `App.tsx` handles their IPC and confirmations. Confirmations call `src/renderer/src/ui/confirm-action.ts`, which shows a native alert from `src/main/confirm-action.js` with Cancel as the default button and a second button naming the action.

Text and number fields use `CommitTextInput`, `CommitNumberInput` and `CommitTextArea` from `CommitInput.tsx`: Enter or losing focus saves, and Escape restores the saved value. Graphics number fields reuse `CommitNumberInput` through `GraphicsNumber`, and graphics sliders save after a short pause. `ErrorText.tsx` shows errors after `formatUserError`, without adding another prefix.

## Common edit paths

| Change | File |
| --- | --- |
| Button visuals | `src/renderer/src/ui/styles.css` (`.btn*` and the `:root` tokens) |
| Icon sizes | `src/renderer/src/ui/styles.css` (`--icon-size*`, `--icon-button-size*`) |
| Library selection or row content | `src/renderer/src/ui/components/GameRow.tsx` |
| Inspector controls or group rendering | `src/renderer/src/ui/components/GameDetails.tsx` |
| Shared game tools | `src/renderer/src/ui/components/GameActions.tsx` |
| Search and sort controls | `src/renderer/src/ui/components/LibraryToolbar.tsx` |
| Sort and grouping rules | `src/core/library-view.mjs` and `src/core/library-state.js` |
| Adding or renaming module buttons | `src/modules/<moduleId>/manifest.json` (`ui.actions`) |
| Action logic | `src/modules/<moduleId>/main.js` (`actions`) |

## App identity

The app mark is an open doorway with a launch arrow. [Icon assets](ICON_ASSETS.md) describes the artwork and its sources.

- Vector source: `src/renderer/src/ui/assets/maclauncher.svg`, shown beside the MacLauncher name in the header. The README uses the same file.
- Dock image: `src/resources/maclauncher.png` (1024px). Launcher windows load it in development, and packaged apps receive it through extraResources.
- macOS bundle icon: `build/icon.icns`, which electron-builder finds in buildResources. It replaces the default Electron artwork without adding a production dependency.

To regenerate the images, render the PNG with `rsvg-convert -w 1024 -h 1024`, create the standard macOS iconset sizes with `sips`, and build the ICNS with `iconutil -c icns`. The generated PNG and ICNS are checked in.
