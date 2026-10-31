# Save tools and snapshots

Every game type that knows where its game keeps saves has save tools. The inspector's **Saves** button opens them; for game types that support save editing, the button is **Edit saves** and the window is the **Save editor**. The window has two tabs, **Save files** and **Snapshots**. None of these tools needs the network.

## Save files

The **Save files** tab shows the save folder, with a folder selector when the game type has several save locations, and lists the save files with their size and modification time.

- **Import folder…** replaces the current saves with the saves of the declared formats from another folder. Unrelated files in the save folder stay.
- **Export folder…** copies the saves to another folder.
- **Import files…** imports individual save files after checking their names and sizes.
- **Edit JSON** opens a save as JSON when the game type has a codec for it.
- **Edit values** opens the [structured save editor](../game-types/RPGMAKER_MV_MZ.md#structured-save-editing) of RPG Maker MV and MZ.

## Snapshots

A snapshot is a local recovery copy of the game's saves, and the **Snapshots** tab lists them newest first.

- **Create snapshot** records the current saves.
- **Review restore** previews a restore: the files it would create or replace, and the extra current saves it would keep.
- **Restore these files** applies that preview, after first creating a recovery snapshot of the current state.

A restore replaces or creates only the files recorded in the snapshot. Extra current saves stay in place and appear in the preview. Ren'Py snapshots copy the slot and `persistent` bytes without unpickling them or changing their signatures.

## Safe writes

Restores, imports, structured edits and JSON edits all write only after a successful snapshot of the current saves. JSON and structured edits also keep a `.maclauncher.bak` copy beside the save.

Save writes are blocked while a game launched from MacLauncher is running and uses the same save folder or an overlapping one, including a separate library entry that shares the saves. Games launched outside MacLauncher must be closed before their saves are edited.

## Storage

Snapshots are stored in `userData/games/<gameId>/save-snapshots/<timestamp>-<uuid>/`, apart from extraction caches. Each one holds read-only copies of the original bytes and a manifest with the game, game type and runtime, the source folder, the reason, the time, and each file's name, size, permissions and SHA-256 hash.

Snapshots are kept until the game is forgotten. Forgetting the game removes the snapshots in launcher data; a `.maclauncher.bak` backup in the original save folder stays there.

## Files and limits

Save tools accept regular files only. They reject path traversal, symbolic links, names that collide after normalization, and the extra files that recovery and editing create next to saves, such as `.maclauncher.bak` backups. The standard macOS `/var` and `/tmp` aliases are supported. Each game type's save extensions and names keep the tools from overwriting unrelated assets. MV and MZ decoding has a fixed decompression limit, and stock MZ's UTF-8 encoding of binary strings is preserved.

The default limits are 5,000 files, 128 MiB per file, 512 MiB in total and 16 levels of nesting.

A snapshot is published only after a second inventory confirms that the hashes have not changed. A restore verifies the recorded checksums, stages its writes on the destination filesystem, and checks each current file's hash immediately before replacing it. Restoring several files is a recoverable batch of atomic file replacements. If a replacement fails, the restore rolls back the earlier ones, keeps newer files that changed independently, and reports an incomplete recovery with the pre-write snapshot available.

## Implementation

The save tools are UI-independent Node services in `src/core/save-service.js` and `src/modules/shared/save-snapshots.js`. The renderer supplies the forms and restore previews, and Electron supplies folder selection and external-editor opening. Modules define save file names, codecs and structured editing.

### Backend actions

| Action | Payload and result |
| --- | --- |
| `createSaveSnapshot` | Optional `{reason}`; returns a manifest with `id`. |
| `listSaveSnapshots` | Returns manifests, newest first. |
| `previewSaveSnapshot` | `{snapshotId}`; returns changed files, retained extra files and `expectedStateHash`. |
| `restoreSaveSnapshot` | `{snapshotId,expectedStateHash}`; rejects a stale preview and returns `recoverySnapshotId`. |
| `readSaveDocument` | `{fileName}`; returns the original JSON and `sourceHash`. |
| `writeSaveDocument` | `{fileName,json,expectedHash}`; checks that the codec round-trips within its limits, creates a snapshot, then writes. |
| `importSaveFiles` | `{filePaths:[absolutePaths]}`; checks names and sizes before reading and replacing. |
| `importSaveFolder` | `{directory:absolutePath}`; imports the declared formats and keeps unrelated destination files. |

```sh
pnpm launch --game /Games/MyGame --action createSaveSnapshot --payload '{"reason":"Before experimenting"}'
pnpm launch --game /Games/MyGame --action listSaveSnapshots
```

Module writers receive `context.assertSaveWriteAllowed()` and `context.snapshotSaves({reason})`. Pure codecs do not depend on application state. Legacy JSON IPC writes also require the expected source hash; new clients use the document actions.
