# Save snapshots and write transactions

Save recovery is implemented by UI-independent Node services in `src/core/save-service.js` and `src/modules/shared/save-snapshots.js`. The renderer supplies forms and restore previews; Electron supplies directory selection and external-editor opening. Modules own save filenames, codecs and semantic editing.

## Workflow

Save tools are available for games with save-location support through the inspector's **Saves** button, labelled **Edit saves** when the game type supports save editing. **Files** offers import/export and JSON editing when a codec exists. MV/MZ additionally offer **Edit values**. **Snapshots** lists recovery points, creates snapshots, and previews restores. Ren'Py snapshots copy slot/persistent bytes without unpickling or changing signatures.

Restore replaces or creates only recorded files. Extra current saves remain and appear in the preview. Restore, imports, structured edits and raw JSON edits require a successful pre-write snapshot. JSON/structured writers also retain `.maclauncher.bak` beside the save.

Snapshots live at `userData/games/<gameId>/save-snapshots/<timestamp>-<uuid>/`, separate from extraction caches. Read-only original bytes accompany a manifest containing game/module/runtime identity, source directory, reason, timestamp, filenames, byte counts, permissions and SHA-256 hashes. Snapshots are retained until the game is forgotten. Forgetting removes launcher-owned snapshots; an adjacent backup outside launcher data remains with the original save folder.

## Backend actions

| Action | Payload / result |
| --- | --- |
| `createSaveSnapshot` | Optional `{reason}`; returns a manifest with `id`. |
| `listSaveSnapshots` | Returns manifests, newest first. |
| `previewSaveSnapshot` | `{snapshotId}`; returns changed files, retained extras and `expectedStateHash`. |
| `restoreSaveSnapshot` | `{snapshotId,expectedStateHash}`; rejects stale previews, returns `recoverySnapshotId`. |
| `readSaveDocument` | `{fileName}`; returns original JSON and `sourceHash`. |
| `writeSaveDocument` | `{fileName,json,expectedHash}`; validates bounded codec roundtrip, snapshots, then writes. |
| `importSaveFiles` | `{filePaths:[absolutePaths]}`; validates names/sizes before reading and replacing. |
| `importSaveFolder` | `{directory:absolutePath}`; imports declared formats, retaining unrelated destination files. |

```sh
pnpm launch --game /Games/MyGame --action createSaveSnapshot --payload '{"reason":"Before experimenting"}'
pnpm launch --game /Games/MyGame --action listSaveSnapshots
```

Module writers receive `context.assertSaveWriteAllowed()` and `context.snapshotSaves({reason})`. Pure codecs remain independent of application state. Legacy JSON IPC writes also require the expected source hash; prefer the document actions when integrating a client.

## File handling and recovery

Regular files only: traversal, symlinks, duplicate normalized names and recovery/editor sidecars are rejected. Standard macOS `/var` and `/tmp` aliases are supported. Module extensions/names prevent overwriting unrelated assets. MV/MZ decoding has an explicit decompression bound; stock MZ's UTF-8 encoded binary-string representation is preserved.

Defaults are 5,000 files, 128 MiB per file, 512 MiB aggregate and 16 levels of nesting. Snapshots publish only after another inventory confirms stable hashes. Restore verifies recorded checksums, stages writes on the destination filesystem, checks each current hash immediately before replacement, and rolls back earlier replacements on failure. Rollback preserves independently changed newer files and reports incomplete recovery with the pre-write snapshot available.

Tracked games block writes to the same or overlapping real save directories, including separate library entries sharing saves. Independently launched games must be closed before editing their saves. Multi-file restoration uses a recoverable batch of atomic file replacements, with a pre-write snapshot available for recovery.

