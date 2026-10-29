# EasyRPG Player

[EasyRPG Player](https://easyrpg.org/player/) runs RPG Maker 2000 and 2003 game data on macOS. Import accepts a game folder, `RPG_RT.exe`, `RPG_RT.ldb` or `RPG_RT.lmt`. MacLauncher identifies the database and map tree by their LCF signatures. It downloads the selected Mac runtime after consent and resumes launch automatically.

**Runtimes → EasyRPG Player** lists official published releases from **0.8** onward after **Refresh**. Releases remain distinct, and installed versions work offline. Individual game inspectors select an exact runtime version.

The selected official Mac app supplies its executables and native dependencies. Intel-only releases use Rosetta on Apple Silicon, selected from the executable's CPU information. Runtime choices come from the refreshed publisher catalog and verified installed receipts.

Settings are available globally and per game: fullscreen, integer/nearest/bilinear scaling, original engine edition, text encoding, translation language, RTP folders, MIDI soundfont, audio, frame-rate display and additional command-line arguments. Engine edition and text encoding are detected automatically; explicit values override detection. A translation language selects a matching `language` folder supplied with the game. MIDI playback uses EasyRPG's built-in FM synthesizer when no game or selected SF2 soundfont is available.

Game input includes its graphics, audio and other required assets. **RTP folders** selects installed RPG Maker Runtime Package assets. The native engine consumes RPG Maker 2000/2003 formats; XP, VX, VX Ace, MV and MZ use separate backends.

Save files, configuration and logs use per-game launcher storage under `games/<gameId>/modules/easyrpg/`. Existing `Save*.lsd` files are copied into that game's save folder once, without replacing launcher saves. Original project files are read directly and remain unchanged. Save snapshots, import/export and folder reveal use `.lsd` files.

The inspector includes **Export project JSON**, **Export game text** and **Reveal export**. These read-only tools decode the database, map tree and map files with bundled [rpgrt 0.2.0](https://github.com/johannschopplich/rpgrt). JSON exports contain structured project data; text exports include source field addresses for dialogue, names and other strings. Exports use `games/<gameId>/modules/easyrpg/exports/` and leave original files unchanged. No tool download or compiler is required. Export limits are 4,096 files, 16 MB per input file, 128 MB total input and 256 MB total output. Engine edition and encoding follow Runtime Settings when specified.

The managed runtime uses official [versioned Mac downloads](https://easyrpg.org/downloads/player/) and the [upstream release list](https://github.com/EasyRPG/Player/releases). Release records retain the publisher URL, source commit and archive size; installation records a local SHA-256 for later integrity checks when the publisher supplies no digest. No runtime is included in the application bundle.

EasyRPG Player is licensed under GPL-3.0-or-later; its bundled libraries, fonts and other assets retain their upstream notices. [liblcf](https://github.com/EasyRPG/liblcf) and rpgrt are MIT-licensed. Runtime archives keep the supplied license files.
