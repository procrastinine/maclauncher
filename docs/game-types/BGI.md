# BGI / Ethornell

BGI, also known as Ethornell, is a Windows visual novel engine. Its games store compiled Buriko programs (`._bp` files) and other resources in ARC archives. MacLauncher has no native BGI interpreter. It identifies BGI games, provides archive, program and text tools, and plays the original Windows executable through a Wine runtime: CrossOver, Sikarugir or WineCX.

| Runtime | Description |
| --- | --- |
| Program tools (default) | Detection and inspector tools; does not launch the game |
| CrossOver, Sikarugir, WineCX | Run the original Windows executable |

## Importing games

MacLauncher's `bgi` module recognizes games that use ARC20 or PackFile archives and whose `system.arc` contains an `ipl._bp` boot program. Import accepts a game folder, its `system.arc` or its Windows executable.

## Detection and versions

PE resources of the game's original executable are inspected separately from the archives. Its fixed file version becomes the engine version only when the product name or description identifies BGI or Ethornell. The inspector shows the archive format, the original executable version, the declared compatibility version and the native support status as separate fields.

## Inspector tools

BGI's archive and program tools are included with MacLauncher and follow the [OpenBGI](https://github.com/Cytlan/openbgi/tree/e2500e0badd04aab472e4620477747973e5e5544) format references.

- **Inspect programs** scans the archive indexes and decodes the compiled `._bp` programs, which use DSC1 Huffman and LZ compression.
- **Export programs** writes only those decoded programs, with a report of source hashes, to `userData/games/<id>/modules/bgi/exports/`. It does not extract assets or run programs. The exporter recognizes each archive's layout and checks each program's file name and byte range.
- **Export text** extracts script messages with [msg-tool](https://github.com/lifegpc/msg-tool), a native tool listed under **Runtimes → Tools → msg-tool**. Messages from scripts that complete are kept when other scripts fail; the result reports the failures and keeps a log for each script. The message export does not reconstruct the original scenario source.

Program tools are limited to 128 archives, 16 MiB of indexes in total, 1024 programs and 32 MiB of decoded scripts in total.

## Runtimes

### Program tools

Program tools, the default runtime, provides detection, version information and the inspector tools but cannot launch the game. When a compatible Windows executable is present, automatic selection plays the game with a Windows runtime instead; without one, the import can only be inspected.

### CrossOver, Sikarugir and WineCX

Play runs the game's Windows executable through a registered [CrossOver](../runtimes/CROSSOVER.md) application when one is available, and otherwise through [Sikarugir](../runtimes/SIKARUGIR.md). [WineCX](../runtimes/WINECX.md) is offered as well. Any of the three can be chosen in the game's runtime selector, and the detected engine version and the program tools stay available with each.
