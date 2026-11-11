# VNDS

VNDS is a visual novel script format. MacLauncher plays games that have already been converted to VNDS, using [VNDS-LOVE](https://github.com/ajusa/VNDS-LOVE), an interpreter that runs on [LÖVE](https://love2d.org/) `11.5`. Original games are not converted to VNDS automatically.

| Runtime | Description |
| --- | --- |
| VNDS-LOVE (default) | VNDS interpreter hosted by LÖVE |
| CrossOver, Sikarugir | Run a compatible Windows executable |

## Game files and saves

Original game folders and supported ZIP archives are read in place, and the original novel folder is used as the working directory. Saves follow VNDS-LOVE's folder identity and LÖVE's [save-directory rules](https://github.com/love2d/love/blob/11.5/src/modules/filesystem/physfs/Filesystem.cpp), so they go to `~/Library/Application Support/LOVE/VNDS-LOVE/novels/<novel folder>`. Import assigns a visible save-folder override, based on the library game ID, only when another library game already uses the same save location, and an existing override remains the effective save location. AAC and M4A audio that the interpreter cannot play is converted once and cached in launcher data. Like the shared interpreter and the archive mount plan, this converted audio is kept separate from game content and saves.

The inspector can edit these saves, and **Show scripts** opens the game's existing script folder in Finder.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Fullscreen | Off | Start the game in fullscreen. |

## Runtimes

### VNDS-LOVE

VNDS-LOVE is the default runtime, and it has two parts. The interpreter is published by MacLauncher Builds, with MacLauncher's changes, as a separate [package](https://procrastinine.github.io/maclauncher-builds/#vnds-love), and the [LÖVE](LOVE.md) runtime hosts it. Play installs whichever of the two is missing.

**Runtimes → VNDS → VNDS-LOVE** lists the interpreter packages in the MacLauncher Builds catalog. Each package records its source revision and interpreter version, and MacLauncher accepts any compatible source revision instead of requiring a particular one. The runtime status then reports which package is installed.

### CrossOver and Sikarugir

When a game includes a compatible x86 or x64 Windows executable, that executable can also run through a registered [CrossOver](../runtimes/CROSSOVER.md) application or [Sikarugir](../runtimes/SIKARUGIR.md).
