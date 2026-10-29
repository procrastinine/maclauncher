# App, game and engine icons

The MacLauncher app mark is an open doorway with a warm launch arrow on a teal
tile. Its vector source is `src/renderer/src/ui/assets/maclauncher.svg`; the
README and launcher use that source. `src/resources/maclauncher.png` and
`build/icon.icns` provide the matching native app and Dock artwork. The ICNS
contains standard 16, 32, 128, 256 and 512 point sizes at 1x and 2x resolution.
All three assets use the same design and are included locally.

The library and inspector use the same `GameIcon` component. Extracted game/EXE/app
artwork appears first. If it is absent or cannot load, the component shows the game's
bundled engine icon. Unknown types use a gamepad symbol. Images preserve their aspect
ratio; the renderer does not fetch artwork from the network. Bundled engine artwork
appears directly on the launcher surface, without an extra background tile or inset.
Monochrome engine logos use a light foreground for the dark interface.

Every registered module declares `icon.path` and `icon.kind` in its manifest. Current
icons live at `resources/icon.png`, so the existing backend default-icon lookup also
uses them for normalized game records. Vite includes those module-owned images as local
renderer assets, keeping fallbacks available before a backend image is extracted.
`resources/icon.json` records the source, license, modifications and exact SHA-256.
Upstream artwork is copied into module resources; the app reads its included resources to display icons.

Current sources are:

| Types | Artwork source |
| --- | --- |
| Ren'Py | Existing bundled Ren'Py artwork, retained |
| Godot | [Official press icon](https://godotengine.org/press/), Andrea Calabro / Godot contributors, CC BY 4.0 |
| LÖVE | [Official graphics](https://love2d.org/wiki/L%C3%B6ve_Logo_Graphics), Zlib |
| GameMaker, GameMaker HTML5, Construct, HashLink/Haxe | [Simple Icons](https://github.com/simple-icons/simple-icons), CC0; source revision recorded with each asset |
| KiriKiri | Pinned krkrsdl2 application artwork, MIT |
| AliceSoft | Pinned system3-sdl2 haniwa artwork, GPL 2 or later |
| GemRB | Pinned GemRB application artwork, GPL 2 or later |
| Flash | Ruffle application artwork, MIT or Apache 2.0 |
| RPG Maker MV/MZ/RGSS, FNA/XNA, Unity, Java, NScripter, Tyrano, Ikemen/MUGEN, AI5, Siglus, Nitroplus, Minori, FAVORITE/FVP, BGI, CatSystem2, VNDS, web, video and generic app | Distinct MacLauncher-owned category symbols |

Artwork licenses and source attribution remain next to their assets. Names and marks
identify the underlying engine or runtime; no endorsement is implied. Backend runtime
version selection remains independent of icon artwork.

Owned SVG assets are rendered to their checked-in PNGs with `rsvg-convert --width 256
--height 256 --keep-aspect-ratio --output icon.png icon.svg`. The launcher needs no
icon conversion tool.
