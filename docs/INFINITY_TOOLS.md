# Infinity Engine tools

**Open Near Infinity** in the Infinity Engine inspector opens the detected game in [Near Infinity](https://github.com/Argent77/NearInfinity). It browses resources, decompiles scripts and edits supported Infinity Engine files, including saved games. These capabilities are separate from GemRB playback support.

Near Infinity opens the original game's resource index. Edits saved in its editor can change original game files. Files exported through Near Infinity use the destination selected in that application.

Near Infinity is managed under **Runtimes → Tools**. Refresh discovers stable 2.4 and later releases from the maintained upstream repository. A selected default version remains selected through refresh and restart. A first use prompts for a missing tool download, installs it and opens the inspector automatically. If discovery is unavailable, the known compatible release remains downloadable.

The launcher reuses a compatible managed Temurin Java 17 or later installation. If no compatible host is installed, its download is requested and handled automatically. Installed tools work offline. Near Infinity's update checks and its separate game-launch command are disabled; game playback remains available from the library.

Near Infinity retains its LGPL license and its bundled dependency notices. Its Java preferences use the normal macOS preferences store. Other files written relative to the tool's home directory live in the launcher's runtime data directory, separately from game files and GemRB saves.
