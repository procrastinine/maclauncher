# Flash tools

The Flash inspector provides **Export ActionScript** and **Export scripts and assets**. Both actions use [JPEXS Free Flash Decompiler](https://github.com/jindrapetrik/jpexs-decompiler), preserve the original SWF and save their output in the game's launcher data directory. **Show export** opens the latest output in Finder.

Export ActionScript decompiles ActionScript 1, 2 and 3. Export scripts and assets also extracts images, shapes, audio, fonts, text and embedded binary resources. Exports contain the script and resource records decoded by the selected FFDec version. These exports are inspection files; they do not replace the selected player or modify the game.

JPEXS FFDec is managed under **Runtimes → Tools**. Refresh discovers compatible stable releases from GitHub, beginning with version 12.0.0. A selected default version remains selected when the list refreshes. Older installed versions remain available after an upstream release disappears. If discovery is unavailable, an explicit export can still download the known compatible release.

The first export prompts for a missing tool download and then continues automatically. Java is shared with the managed Temurin installations used by Java games. A missing compatible Java 17 or later runtime is downloaded after consent. Installed tools and Java hosts are reused, including offline. FFDec update checks are disabled during export.

Downloads retain upstream license files and recorded checksums. The tool and its Java dependencies stay separate from game data, and removing a game removes its exports.

The [upstream command-line reference](https://github.com/jindrapetrik/jpexs-decompiler/wiki/Commandline-arguments) lists SWF resource types.
