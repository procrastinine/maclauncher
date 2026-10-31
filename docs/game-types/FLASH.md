# Flash

Flash games are SWF files. MacLauncher plays them with the Adobe Flash Player projector or with the [Ruffle](https://github.com/ruffle-rs/ruffle) emulator, and exports their ActionScript and assets with [JPEXS Free Flash Decompiler](https://github.com/jindrapetrik/jpexs-decompiler) (FFDec).

## Detection

Import accepts a `.swf` file, or a folder that contains one. The file must start with an uncompressed (`FWS`), zlib-compressed (`CWS`) or LZMA-compressed (`ZWS`) SWF signature.

## Runtimes

| Runtime | Delivery |
| --- | --- |
| Adobe Flash Player (default) | Universal projector packaged by MacLauncher Builds |
| Ruffle | Ruffle releases from GitHub |

**Runtimes → Flash** groups the separate version controls of both players and of JPEXS FFDec. The inspector shows the selected player's version.

### Adobe Flash Player

MacLauncher Builds hosts Adobe’s universal Flash Player 35.0.0.60 projector from Adobe Animate. The app bundle and its files are kept unchanged. It runs natively on Apple Silicon and Intel Macs; Adobe’s public projector downloads are Intel only.

The player originates from [Adobe Animate](https://www.adobe.com/products/animate.html) and keeps the copyright notices and vendor terms of Adobe and its licensors.

### Ruffle

Ruffle versions come from the GitHub releases of `ruffle-rs/ruffle`, which are nightly and prerelease builds, and only their macOS assets are used. **Reload**, and the lookup before a first installation, read the release history within fixed limits. Releases install under `userData/runtimes/ruffle/<version>/`, and a game's Ruffle version choice is stored in `runtimeData.ruffle.version`.

MacLauncher tracks the Ruffle app's executable, so **Stop** ends the game process. The upstream app's sandbox and file-access prompts stay active.

## Tools

The inspector's **Flash tools** group has **Export ActionScript**, **Export scripts and assets** and **Reveal export**. Both exports use FFDec and save their output in the game's launcher data folder. **Reveal export** opens the latest output in Finder.

- **Export ActionScript** decompiles ActionScript 1, 2 and 3.
- **Export scripts and assets** also extracts images, shapes, audio, fonts, text and embedded binary resources.

Exports contain the script and resource records that the selected FFDec version can decode. Obfuscated or malformed SWF files can produce partial or failed exports. Exports are for inspection, leave the selected player as it is and are removed together with the game. FFDec's [command-line reference](https://github.com/jindrapetrik/jpexs-decompiler/wiki/Commandline-arguments) lists the SWF resource types.

### JPEXS FFDec versions

FFDec versions are listed under **Runtimes → Flash → JPEXS FFDec**. Refresh finds compatible stable releases on GitHub, starting with version 12.0.0. If the release list cannot be loaded, an export can still download version 26.4.0, the fallback version built into MacLauncher.

FFDec needs Java 17 or later and runs on the same Temurin installations that [Java](JAVA.md) games use; a missing compatible Java is downloaded with it. FFDec's update checks are disabled during export. Installations keep the upstream license files and recorded checksums, and the tool and its Java runtime are stored apart from game data.
