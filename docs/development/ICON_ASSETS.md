# App, game and engine icons

This page describes the icon artwork that ships with MacLauncher: the app icon, the default engine icons that modules provide and the sources of that artwork. [Game icons](../library/GAME_ICONS.md) describes how icons are extracted from games and cached.

## App icon

MacLauncher's app mark is an open doorway with a warm launch arrow on a teal tile. The same design is kept in three files in the repository:

| File | Use |
| --- | --- |
| `src/renderer/src/ui/assets/maclauncher.svg` | Vector source, used by the README and the launcher |
| `src/resources/maclauncher.png` | Dock artwork |
| `build/icon.icns` | macOS app icon, with the standard 16, 32, 128, 256 and 512 point sizes at 1x and 2x resolution |

[UI styles](UI_STYLES.md#app-identity) lists the commands that regenerate the PNG and ICNS files.

## Icons in the launcher

Wherever a game's icon appears, in the library or in the inspector, the launcher draws it with the same `GameIcon` component. This component prefers the artwork extracted from the game, executable or app. When there is none, or when it cannot be decoded, the main process supplies the game's bundled engine icon instead, and a game of an unknown type shows a gamepad symbol. Images keep their aspect ratio, and the renderer never fetches artwork from the network. Every library row's image loads with the list rather than when it scrolls into view, so rows show their icons as soon as they appear. Bundled engine artwork is drawn directly on the launcher surface, without an extra background tile or inset, and monochrome engine logos use a light foreground for the dark interface. The Steam and External views draw local artwork the same way, with each row as it first paints; artwork from a connected account or a store's servers loads as its row nears the view.

## Engine icons

Each module supplies the default icon for its engine. Every registered module declares this icon in its manifest, with `icon.path` and `icon.kind`, and stores the image at `resources/icon.png`. Because the location is the same in every module, the backend's default-icon lookup also uses these images for normalized game records. Whenever a game has no usable artwork of its own, the main process reads the module's file, so each module image ships once and the renderer bundle holds no copies. Beside each image, `resources/icon.json` records the artwork's source, license, modifications and exact SHA-256. Upstream artwork is copied into the module resources, and the app reads these included resources to display icons.

The artwork comes from these sources:

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
| Doom engine (UZDoom) | UZDoom application icon from the source commit the icon record names, © 2025 The UZDoom Team, CC BY-SA 4.0 |
| Build engine (Raze) | Raze application icon from the source commit the icon record names, GPL 2 |
| RPG Maker MV/MZ/RGSS, FNA/XNA, Unity, Java, NScripter, Tyrano, Ikemen/MUGEN, AI5, Siglus, Nitroplus, Minori, FAVORITE/FVP, BGI, CatSystem2, VNDS, LucasArts (DREAMM), web, video and generic app | A distinct category symbol for each, made for MacLauncher |

The store logos in the External view come from [Simple Icons](https://github.com/simple-icons/simple-icons) 13.21.0, CC0, each drawn in a single color: the `steam` glyph in the Steam tab, and the `epicgames`, `gogdotcom` and `itchdotio` glyphs in the sign-in intros of the Epic, GOG and itch.io tabs. Their sources are noted beside the paths in `SteamView.tsx` and `StoreMarks.tsx`, with each store's trademark notice.

Licenses and source attribution are stored next to the assets. The names and marks identify the underlying engine or runtime and imply no endorsement, and runtime version selection in the backend does not depend on icon artwork.

MacLauncher's own SVG assets are rendered to the PNG files checked into the repository with this command:

```sh
rsvg-convert --width 256 --height 256 --keep-aspect-ratio --output icon.png icon.svg
```

The launcher itself needs no icon conversion tool.
