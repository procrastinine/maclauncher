# Save tools and snapshots

Every game type that knows where its games keep their saves has save tools, which copy, import, edit and back up those saves. The inspector's **Saves** button opens them; for game types that support save editing, the button is **Edit saves** and the window is the **Save editor**. Either way, the window has two tabs, **Save files** and **Snapshots**, and none of the tools needs the network.

## Save files

The **Save files** tab shows the save folder and lists the save files with their size and modification time. When the game type has several save locations, a folder selector chooses between them.

- **Import folder…** replaces the current saves with saves of the game type's declared formats from another folder, leaving unrelated files in the save folder where they are.
- **Export folder…** copies the saves to another folder.
- **Import files…** imports individual save files after checking their names and sizes.
- **Edit JSON** opens a save as JSON when the game type has a codec for it.
- **Edit values** opens the [structured save editor](../game-types/RPGMAKER_MV_MZ.md#structured-save-editing) of RPG Maker MV and MZ.

## Snapshots

A snapshot is a local recovery copy of the game's saves. The **Snapshots** tab lists them newest first.

- **Create snapshot** records the current saves.
- **Review restore** previews a restore: the files it would create or replace, and the extra current saves it would keep.
- **Restore these files** applies that preview, after first creating a recovery snapshot of the current state.

A restore replaces or creates only the files recorded in the snapshot, so extra current saves stay in place, and the preview lists them. Ren'Py snapshots copy the slot and `persistent` bytes without unpickling them or changing their signatures.

## Safe writes

Restores, imports, structured edits and JSON edits first take a snapshot of the current saves and write only when that snapshot succeeds. JSON and structured edits also keep a `.maclauncher.bak` copy beside the save.

While a game launched from MacLauncher is running and uses the same save folder or an overlapping one, save writes are blocked. This includes a separate library entry that shares the saves. A game launched outside MacLauncher must be closed before its saves are edited.

## Storage

Snapshots are stored in `userData/games/<gameId>/save-snapshots/<timestamp>-<uuid>/`, apart from extraction caches. Each one holds read-only copies of the original bytes and a manifest that records the game, game type and runtime, the source folder, the reason, the time, and each file's name, size, permissions and SHA-256 hash.

Snapshots are kept until the game is forgotten. Forgetting the game removes the snapshots in launcher data, while a `.maclauncher.bak` backup in the original save folder stays where it is.

## Files and limits

Save tools accept regular files only. They reject path traversal, symbolic links, names that collide after normalization, and the extra files that recovery and editing create next to saves, such as `.maclauncher.bak` backups, although the standard macOS `/var` and `/tmp` aliases are supported. Because the tools only touch each game type's save extensions and names, they cannot overwrite unrelated assets. MV and MZ decoding has a fixed decompression limit, and stock MZ's UTF-8 encoding of binary strings is preserved.

The default limits are 5,000 files, 128 MiB per file, 512 MiB in total and 16 levels of nesting.

A snapshot is saved as complete only after a second pass over its files confirms that the hashes have not changed. A restore verifies the recorded checksums, prepares its new files on the destination filesystem first, and checks each current file's hash immediately before replacing it. When several files are restored, each is replaced atomically, and the whole batch can be undone. If one replacement fails, the restore rolls back the earlier ones, keeps newer files that changed independently, and reports an incomplete recovery, with the snapshot taken before the write still available.

## Implementation

The save tools are Node services in `src/core/save-service.js` and `src/modules/shared/save-snapshots.js` that do not depend on the interface. The renderer supplies the forms and restore previews, Electron supplies folder selection and opens external editors, and modules define save file names, codecs and structured editing.

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

Module code that writes saves receives `context.assertSaveWriteAllowed()` and `context.snapshotSaves({reason})`. Pure codecs do not depend on application state. Legacy JSON IPC writes also require the expected source hash, and new clients use the document actions instead.
