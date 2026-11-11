# RPG Maker MV and MZ

RPG Maker MV and RPG Maker MZ games are HTML games. MacLauncher shows them as two game types, **RPG Maker MV** and **RPG Maker MZ**, but the two share their runtimes, tools and save editor. Their save files differ: MV saves are `.rpgsave` files, and MZ saves are `.rmmzsave` files.

## Detection

Import accepts the game folder, its Windows executable, its HTML entry page or a Mac app bundle that keeps the game in `Contents/Resources/app.nw`. Detection starts from the entry page, which is the local HTML file named by `main` in `package.json`, or otherwise `index.html` or `www/index.html`. Next to it, a `js/rmmz_core.js` file identifies an MZ game, and `js/rpg_core.js` identifies an MV game. A game imported through its `www` folder, or through the entry page inside it, keeps `www` as its location. When the release's `package.json` names that entry page, however, the release folder around it also supplies the Windows executable for the [Windows runtimes](WINDOWS.md#windows-executables-in-other-game-types).

When it is available, the library title comes from `gameTitle` in the game's `data/System.json`. If the bundled executable has a generic name such as `Game.exe`, author titles and useful folder names are kept. Changes to this metadata are picked up by the normal source-cache refresh. Version and confidence rows do not apply to these game types, so the inspector's **Details** omit them.

## Runtimes

| Runtime | Delivery |
| --- | --- |
| Electron (default) | Included with MacLauncher |
| NW.js | Downloaded from **Runtimes → NW.js** |
| NW.js (Patched) | The same NW.js installation with compatibility patches |
| Game's macOS app | A compatible Mac app supplied with the game |
| CrossOver, Sikarugir, WineCX | Windows runtimes for the game's Windows executable |

The automatic runtime depends on what is installed. When a usable NW.js SDK is installed, MV and MZ games use **NW.js (Patched)**, and otherwise they use Electron. This automatic choice keeps the selected NW.js version and patch options, and it does not change a runtime chosen for the game or an explicit default for the game type. Other web game types keep their own defaults.

[Web runtimes](../runtimes/WEB_RUNTIMES.md) describes the Electron and NW.js hosts, NW.js versions, Greenworks for Steam games and the shared settings. [Sikarugir](../runtimes/SIKARUGIR.md) and [CrossOver](../runtimes/CROSSOVER.md) describe the Windows runtimes.

### NW.js (Patched) settings

In addition to the [shared patched settings](../runtimes/WEB_RUNTIMES.md#nwjs-patched), MV and MZ can load Kawariki modules and decrypted asset loaders:

| Setting | Effect |
| --- | --- |
| **Enable decrypted assets** | Loads the decrypted asset loaders. |
| **Enable remap + fixes** | Loads the Kawariki remap and fix modules. |
| **Enable vars inspector (ES13)** | Loads the Kawariki variables inspector. |

All three are off by default. The [settings reference](../runtimes/SETTINGS_REFERENCE.md#rpg-maker-mv) lists every setting for each runtime.

## Saves

By default, a game saves to the `save` folder next to its entry page. Another folder can be chosen with **Saves → Change…** in the inspector, and that choice applies to Electron, NW.js and NW.js (Patched), because these runtimes share the stock MV and MZ storage redirection. Without an override, saves stay in the detected game folder. MacLauncher injects the redirection from its own wrapper page instead of rewriting game scripts.

**Save tools** contains the [structured save editor](#structured-save-editing), file import and export in the **Save files** tab, and the **Snapshots** tab, which every game type with a save location has. In that tab, **Create snapshot** saves a local recovery copy, and **Review restore** lists the files a restore would create or replace and the additional files it keeps. **Restore these files** then applies that preview, after first creating a recovery snapshot. [Save snapshots](../tools/SAVE_SNAPSHOTS.md) describes the snapshot format.

## Plugins and extraction

The inspector's **Plugins** group installs or removes two optional plugins:

- **Install text hooker** adds the Clipboard_llule plugin, a text extractor that copies game text to the clipboard.
- **Install 500 save slots** adds the CustomizeMaxSaveFile plugin.

Plugin changes made in the inspector apply to the original game files. Play likewise uses the detected project directly, including a project extracted from an installer, and makes no second copy of the game. For RPG Maker MV, the inspector's library patching controls apply the optional PixiJS 5 patch set, with patch status, a patch and unpatch toggle, and version choices for each library.

**Extract** prepares readable project assets and the project tree through the module's RPG Maker decryption and extraction path, but it does not decompile JavaScript. The game's JavaScript, plugins and JSON can already be read directly, although shipped JavaScript may be minified or obfuscated and does not contain the author's editor history. Plugin compatibility and the recovery of encrypted resources are separate from extraction.

MV and MZ also support the in-game [cheats and Tools overlay](../tools/CHEATS.md).

## Structured save editing

MV and MZ saves can be edited field by field. **Save tools → Edit values** opens the selected save in a structured editor, which shows switches, variables, gold and inventory, and actors, with search and pages of 50 rows. Each variable has an explicit type selector for number, text, boolean or null.

Changes stay a draft until **Save changes** (Cmd-S). **Reload save** discards the draft and reads the current file again, which is needed when a write is rejected because the file changed on disk. Opaque values stay read-only, but **Edit JSON** remains available for raw JSON editing of fields that the structured editor does not cover, with the same protection against stale files.

To read stock save contents and compatible plugin extensions, the editor uses the existing MV LZString/base64 and MZ zlib codecs, and MZ files keep the engine's UTF-8-encoded compressed binary string representation. No database script, plugin or game class runs during inspection, label lookup or editing.

### Editable fields

| Field | Accepted edits | Limits |
| --- | --- | --- |
| Switches | Boolean values by ID | Null or unset entries display as false. Object or non-boolean values are read-only. |
| Variables | Finite numbers, strings, booleans or null, by ID | Objects, arrays, JsonEx references and non-finite values are read-only. No general numeric range is imposed. |
| Gold | A non-negative safe integer | No stock maximum is imposed, because plugins can change it. |
| Inventory | Non-negative safe integer counts for items, weapons and armors | Existing IDs and IDs declared in the local database can be edited. Plugin object entries are read-only. A count of zero stays an explicit entry. |
| Actors | HP, MP, TP and level as safe integers | HP, MP and TP must be non-negative, and level must be at least 1. The actor must already exist. |

Actor edits change only the serialized values: they do not run experience formulas, update experience when the level changes, apply states or recalculate maximum HP, MP or TP. Game logic can still clamp or replace serialized values when the save loads or during play.

Names for these fields come from `data/System.json`, `Actors.json`, `Items.json`, `Weapons.json` and `Armors.json` in the game's entry folder, although actor names stored in the save take precedence. Missing or unreadable database files produce warnings, and the affected fields stay editable by ID. The local database also decides which empty entries can be filled: unset switch and variable slots and unowned inventory entries become editable when the database declares them. The structured editor cannot create unknown actor, inventory, switch or variable IDs.

### Preservation and validation

Saves contain a serialized JsonEx tree, and the editor keeps that tree intact. It follows legacy MV `@c` identity markers, `@r` reference markers and `@a` array wrappers only to find the value being edited, and it never constructs game class instances, removes `@` class metadata, replaces reference markers, compacts arrays or normalizes plugin fields.

When writing, the editor patches the selected JSON tokens and appends only the array slots or inventory entries that it needs. All other JSON stays exactly as written, including negative zero, unusual numeric literals, escaped strings, whitespace, null placeholders and unknown metadata. When an array is extended, it gets null placeholders so that IDs keep their positions, and an edit through a reference changes the existing referent. Duplicate changes to one referent, ambiguous identity markers, duplicate JSON keys, invalid references and container shapes are checked against the declared save schema.

The editor has these size limits:

- encoded save file: 16 MiB
- decoded JSON: 64 MiB
- each database file: 8 MiB
- tree: one million nodes and 128 levels
- indexed arrays: 100,000 entries
- one request: 1,000 changes
- variable strings: one million UTF-16 code units

In addition, MV decompression limits its dictionary. Decoding is strict: it rejects corrupt or truncated streams, invalid UTF-8 and trailing MZ data, and the codec follows the declared MV or MZ compression and container format.

Before writing, the module validates the change list, compares the source file's SHA-256 hash, checks the edited tree against the intended changes, and encodes and decodes the replacement. MacLauncher also checks for a running game, once before editing and again after the optional snapshot, and the module checks the source hash before and after that snapshot. The file is replaced atomically only after a successful shared backup, with `${filePath}.maclauncher.bak` holding the original bytes, so if the snapshot or backup fails, the save is not replaced. A request that changes nothing rewrites nothing and creates no snapshot or backup.

Edits to a running game are rejected through MacLauncher's `assertSaveWriteAllowed` hook, and callers without that hook are responsible for coordinating save writes themselves. The hash checks detect concurrent writes that they observe. However, they cannot lock out another application that ignores the launcher or writes in the short interval between the final check and the replacement. Save file names must be single path components, and file symlinks are rejected.

## Backend API

The MV and MZ modules declare `supports.structuredSaveEditing: true` and `save.structured: { inspectAction: "inspectStructuredSave", editAction: "editStructuredSave" }`. The shared backend runs these actions:

```js
const inspected = await launcher.runAction(entry, "inspectStructuredSave", {
  fileName: "file1.rpgsave"
});
const result = await launcher.runAction(entry, "editStructuredSave", {
  fileName: inspected.fileName,
  expectedHash: inspected.sourceHash,
  changes: [
    { kind: "switch", id: 1, value: true },
    { kind: "variable", id: 2, value: 42 },
    { kind: "gold", value: 1000 },
    { kind: "inventory", category: "items", id: 1, value: 5 },
    { kind: "actor", id: 1, field: "hp", value: 100 }
  ]
});
```

Inspection returns `{ engineId, fileName, sourceHash, sections, warnings }`. The sections contain:

- switch and variable rows: `{ id, name, value, valueType, editable, reason? }`
- gold: `{ value, editable, reason? }`, or null
- inventory categories with rows `{ id, name, value, editable, reason? }`
- actor rows: `{ id, name, fields: [{ key, label, value, editable, reason? }] }`

Opaque values are reported as read-only with `value: null`, where the null is a display placeholder and not a suggested replacement. An edit returns a fresh inspection plus `changed`, `backupPath` and, when the host creates a snapshot, `snapshotId`. A stale request returns a conflict instead, and a new inspection supplies the current hash.

The save folder is taken from `entry.saveDirOverride`, then `entry.defaultSaveDir`, and then `context.saveDir`. Filesystem editing also accepts two optional host hooks, `assertSaveWriteAllowed()` and `snapshotSaves({ reason: "structured-edit" })`; the second can return a snapshot ID, `{ id }` or `{ snapshotId }`.

`src/modules/shared/mvmz/save-editor.js` exports:

- `parseSaveData(json)`: size-limited JSON and structure validation without JsonEx hydration
- `inspectSaveData(parsed, database)`: pure structured inspection
- `applySaveChanges(parsed, changes, database)`: pure editing of a cloned tree
- `applyJsonSaveChanges(json, changes, database)`: token-preserving editing that returns `{ json, changed }`
- `loadDatabaseLabels(indexDir)`: size-limited local JSON labels and warnings
- `inspectStructuredSave(engineId, entry, payload, context)` and `editStructuredSave(engineId, entry, payload, context)`: the filesystem workflows

MV and MZ manifests opt in to save-folder injection with `runtime.hosted.saveDirectory: true`.
