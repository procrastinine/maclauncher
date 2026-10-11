# RPG Maker MV/MZ structured save editing

The MV and MZ modules expose a UI-independent editor for stock save contents and
compatible plugin extensions. It uses the existing MV LZString/base64 and MZ zlib
codecs. MZ files retain the engine's UTF-8-encoded compressed binary string
representation. No database scripts, plugins, or game classes execute during
inspection, label lookup, or editing.

The raw JSON/external-editor workflow remains available for fields outside the
structured editor.

## Editable fields

| Field | Accepted edits | Boundaries |
| --- | --- | --- |
| Switches | Boolean values by ID | Null/unset entries display as false. Object or non-boolean representations are read-only. |
| Variables | Finite numbers, strings, booleans, or null by ID | Objects, arrays, JsonEx references, and nonfinite values are read-only. No universal gameplay numeric range is imposed. |
| Gold | Nonnegative safe integer | No stock maximum is imposed because plugins may change it. |
| Inventory | Nonnegative safe integer counts for items, weapons, and armors | Existing IDs or IDs declared in the local database can be edited. Plugin object entries are read-only. Zero counts remain explicit entries. |
| Actors | HP, MP, TP, and level as safe integers | HP/MP/TP must be nonnegative; level must be at least one. Actors must already exist. |

Actor edits change serialized values only. They do not run experience formulas,
update experience when changing level, apply states, or recalculate maximum
HP/MP/TP. Game logic may clamp or replace values on load or during play. Use this
with the same care as editing the raw save.

Names come from `data/System.json`, `Actors.json`, `Items.json`, `Weapons.json`,
and `Armors.json` under the game's index directory. Actor names saved by the game
take precedence. Missing or unreadable database files produce warnings and leave
existing fields usable by ID. Unset switch/variable slots and unowned inventory
entries become editable when declared in the local database. Unknown actor,
inventory, switch, or variable IDs cannot be invented by the structured editor.

## Preservation and validation

The editor keeps the serialized JsonEx tree. It resolves legacy MV `@c` identity
and `@r` reference markers, and `@a` array wrappers, only to find the scalar being
edited. It never constructs game class instances, removes `@` class metadata,
replaces reference markers, compacts arrays, or normalizes plugin fields.

Writes patch the selected JSON tokens and append only required array slots or
inventory entries. Untouched JSON remains exactly as written, including negative
zero, unusual numeric literals, escaped strings, whitespace, null placeholders,
and unknown metadata. Array extensions insert null placeholders to retain IDs.
Edits through a reference modify its existing referent. Duplicate changes to a
referent, ambiguous identity markers, duplicate JSON keys, invalid references,
and unsupported container shapes are rejected or reported as unavailable.

The encoded file is limited to 16 MiB, decoded JSON to 64 MiB, each database file
to 8 MiB, the tree to one million nodes and 128 levels, indexed arrays to 100,000
entries, and a request to 1,000 changes. Variable strings are limited to one
million UTF-16 code units. MV expansion also bounds its dictionary. Strict
decoding rejects corrupt/truncated streams, invalid UTF-8, and trailing MZ data;
plugin-specific compression/container formats remain unsupported.

Before writing, the module validates the change list, compares the source SHA-256
hash, verifies the edited tree against the intended changes, and encodes/decodes
the replacement. The host's active-game guard runs before editing and again
after the optional snapshot. The module checks the source hash again before and
after that snapshot. A successful shared backup is required before atomic
replacement, and `${filePath}.maclauncher.bak` contains the original bytes.
Snapshot or backup failure leaves the save unreplaced. No-op requests do not
rewrite the save or create a snapshot/backup.

The host must provide `assertSaveWriteAllowed` to reject saves for a running
game. A plain caller without the hook can write, so CLI/other hosts should stop
the game before editing. Hash checks detect observed concurrent writes; they
cannot lock out another application that ignores the launcher or writes in the
short interval between the final check and replacement. Save filenames must be
single path components, and file symlinks are rejected.

## Launcher workflow

Open **Save tools**, then choose **Edit values** beside a save. The editor offers
switches, variables, gold/inventory, and actors, with search and pages of 50 rows.
Variables have an explicit number/text/boolean/null selector. Changes remain a
draft until **Save changes** (Cmd-S). **Reload save** discards that draft and reads
the current file again; use it when a write was rejected because the source
changed. Opaque values stay read-only. **Edit JSON** remains available for modules
with a JSON codec and uses the same stale-source protection.

The inspector's **Saves → Change…** folder applies to Electron, NW.js and
patched NW.js. These hosts share the stock MV/MZ storage redirection; saves keep
using the detected game folder when no override is selected. The injection is
stored in the launcher's private wrapper and does not rewrite game scripts.

The **Snapshots** tab is available for any module with a save location, including
modules without JSON editing. **Create snapshot** saves a local recovery copy.
**Review restore** shows which files would be created or replaced and which
additional files are kept. **Restore these files** applies that preview and
creates a recovery snapshot first. File import/export stays in the Save files
tab. No network request is needed for these tools.

## Backend contract

`src/modules/shared/mvmz/save-editor.js` exports:

- `parseSaveData(json)`: bounded JSON/structure validation without JsonEx hydration.
- `inspectSaveData(parsed, database)`: pure structured inspection.
- `applySaveChanges(parsed, changes, database)`: pure cloned-tree editing.
- `applyJsonSaveChanges(json, changes, database)`: token-preserving editing,
  returning `{ json, changed }`.
- `loadDatabaseLabels(indexDir)`: bounded local JSON labels and warnings.
- `inspectStructuredSave(engineId, entry, payload, context)` and
  `editStructuredSave(engineId, entry, payload, context)`: filesystem workflows.

Both modules advertise `supports.structuredSaveEditing: true` and
`save.structured: { inspectAction: "inspectStructuredSave", editAction:
"editStructuredSave" }`. These actions can be called through the shared backend:

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

Inspection returns `{ engineId, fileName, sourceHash, sections, warnings }`.
Sections contain switch/variable rows `{ id, name, value, valueType, editable,
reason? }`, gold `{ value, editable, reason? }` or null, inventory categories
containing `{ id, name, value, editable, reason? }`, and actor rows
`{ id, name, fields: [{ key, label, value, editable, reason? }] }`. Opaque values
are reported as read-only with `value: null`; that null is a display placeholder,
not a suggested replacement. Edits return a fresh inspection plus `changed`,
`backupPath`, and `snapshotId` when the host creates a snapshot. Stale requests
must reload inspection before retrying.

Save discovery uses `entry.saveDirOverride`, then `entry.defaultSaveDir`, then
`context.saveDir`. Filesystem editing accepts optional host hooks
`assertSaveWriteAllowed()` and `snapshotSaves({ reason: "structured-edit" })`.
The latter can return a snapshot ID or `{ id }`/`{ snapshotId }`.
