# App, game and engine icons

This page describes the icon artwork that ships with MacLauncher: the app icon, the default engine icons that modules provide and the sources of that artwork. [Game icons](../library/GAME_ICONS.md) describes how icons are extracted from games and cached.

## App icon

The MacLauncher app mark is an open doorway with a warm launch arrow on a teal tile. Three files in the repository carry the same design:

| File | Use |
| --- | --- |
| `src/renderer/src/ui/assets/maclauncher.svg` | Vector source, used by the README and the launcher |
| `src/resources/maclauncher.png` | Dock artwork |
| `build/icon.icns` | macOS app icon, with the standard 16, 32, 128, 256 and 512 point sizes at 1x and 2x resolution |

[UI styles](UI_STYLES.md#app-identity) lists the commands that regenerate the PNG and ICNS files.

## Icons in the launcher

The library and the inspector both use the `GameIcon` component. It shows the artwork extracted from the game, executable or app first. When there is none, or it cannot be decoded, the main process supplies the game's bundled engine icon instead, and unknown game types show a gamepad symbol. Images keep their aspect ratio, and the renderer never fetches artwork from the network. Bundled engine artwork sits directly on the launcher surface, without an extra background tile or inset, and monochrome engine logos use a light foreground for the dark interface.

## Engine icons

Every registered module declares `icon.path` and `icon.kind` in its manifest. The icons are stored at `resources/icon.png` in each module, so the backend's existing default-icon lookup also uses them for normalized game records. The main process reads these files whenever a game has no usable artwork of its own, so each module image ships once and the renderer bundle holds no copies. The module's `resources/icon.json` records the artwork's source, license, modifications and exact SHA-256. Upstream artwork is copied into the module resources, and the app reads its included resources to display icons.

| Game types | Artwork source |
| --- | --- |
| Ren'Py | The bundled Ren'Py artwork |
| Godot | [Official press icon](https://godotengine.org/press/), Andrea Calabro / Godot contributors, CC BY 4.0 |
| LÖVE | [Official graphics](https://love2d.org/wiki/L%C3%B6ve_Logo_Graphics), Zlib |
| GameMaker, GameMaker HTML5, Construct, HashLink/Haxe | [Simple Icons](https://github.com/simple-icons/simple-icons), CC0, with the source revision recorded for each asset |
| KiriKiri | krkrsdl2 application artwork from the source commit MacLauncher uses, MIT |
| AliceSoft | system3-sdl2 haniwa artwork from the source commit MacLauncher uses, GPL 2 or later |
| GemRB | GemRB application artwork from the source commit MacLauncher uses, GPL 2 or later |
| Flash | Ruffle application artwork, MIT or Apache 2.0 |
| RPG Maker MV/MZ/RGSS, FNA/XNA, Unity, Java, NScripter, Tyrano, Ikemen/MUGEN, AI5, Siglus, Nitroplus, Minori, FAVORITE/FVP, BGI, CatSystem2, VNDS, web, video and generic app | A distinct category symbol for each, made for MacLauncher |

Licenses and source attribution are stored next to the assets. Names and marks identify the underlying engine or runtime and imply no endorsement. Runtime version selection in the backend does not depend on icon artwork.

MacLauncher's own SVG assets are rendered to their checked-in PNG files with:

```sh
rsvg-convert --width 256 --height 256 --keep-aspect-ratio --output icon.png icon.svg
```

The launcher itself needs no icon conversion tool.
