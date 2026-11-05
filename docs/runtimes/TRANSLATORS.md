# Translator runtimes

Translator versions use the shared runtime catalogs and local registration. Refresh reads one source's published releases. Status and registered-file inspection remain offline. CrossOver and Sikarugir use the same installed versions; selecting another game adds no translator payload copy.

| Manager | Download sources | Local sources |
| --- | --- | --- |
| MoltenVK | KhronosGroup/MoltenVK | Library, folder, archive or installed runtime |
| KosmicKrisp | Mesa distributions | Driver and loader folder, archive or installed runtime |
| DXMT | 3Shain/dxmt builtin releases; Sikarugir Template | Folder, archive or installed runtime |
| DXVK | doitsujin/dxvk; Gcenx/DXVK-macOS, with a separate async catalog; Template dxvk, dxvk3 and d9vk | Folder, archive or installed runtime |
| vkd3d-proton | HansKristian-Work/vkd3d-proton | Folder or archive |
| D3DMetal | Sikarugir Template | Apple Game Porting Toolkit disk image or folder; installed runtime |
| GStreamer codecs | Local registration | Prepared plugin folder with its matching dependency closure |

Each catalog has its own Refresh control and publisher link. Release labels identify the source. Installed files supply PE machine and builtin/native form, Mach-O CPU slices, deployment targets and Unix imports. Release numbers and vendor labels do not determine compatibility.

Directory and installed-application registrations reference the selected files. Archive registrations extract once into shared storage. Publisher archives are cached by asset identity across managers; installing another component from the same Template reuses that download. Template component installations retain their complete component tree, including notices, without installing another Wine engine. Removing a local registration preserves the original files.

An installed application selection resolves its component folder, framework or driver library. An application whose component cannot be identified requires selection of the component folder or library. Selecting a component inside CrossOver retains the CrossOver-only source restriction.

D3DMetal is downloaded from Sikarugir Template or supplied locally. MacLauncher does not host or build it. Apple's Game Porting Toolkit licence applies, including Apple hardware and distribution restrictions; the supplied notice remains with the component. Components registered from CrossOver are restricted to CrossOver launches.

GStreamer plugin registration is intended for a prepared codec directory. An unmodified GStreamer SDK can load a second GStreamer core alongside Wine's core. Its plugin dependencies must resolve to the intended libraries before the directory is selected through `GST_PLUGIN_PATH`. Registration does not replace `winegstreamer` or another Wine module, relocate library imports, or supply a codec SDK download catalog.

## Sources and notices

[DXMT](https://github.com/3Shain/dxmt/releases) carries its release licence; v0.80 uses MIT and later source uses LGPL-2.1-or-later. [DXVK](https://github.com/doitsujin/dxvk) and [Gcenx's macOS and async builds](https://github.com/Gcenx/DXVK-macOS) use the zlib licence. [vkd3d-proton](https://github.com/HansKristian-Work/vkd3d-proton) uses LGPL-2.1. [Sikarugir Template](https://github.com/Sikarugir-App/Template/releases) supplies its component notices. [GStreamer](https://gstreamer.freedesktop.org/) and codec dependencies retain their own licences.
