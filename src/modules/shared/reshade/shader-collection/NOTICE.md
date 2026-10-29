# Shader collection

The collection contains effect source files, shared includes and lookup textures.
The [shader catalog](../shader-packs.json) records source revisions, effect paths,
include paths and texture paths. The ReShade runtime supplies the shared
`ReShade.fxh` and `ReShadeUI.fxh` headers under CC0.

## SweetFX

Source: [CeeJayDK/SweetFX](https://github.com/CeeJayDK/SweetFX/tree/93ddf39b357f5da534ed6d34ba4ec8cc7dcfa361),
revision `93ddf39b357f5da534ed6d34ba4ec8cc7dcfa361`.

- `sweetfx/Shaders/SweetFX/{Tonemap,Vibrance,Curves}.fx`: Christian Cann Schuldt
  Jensen / CeeJayDK, MIT. The complete license is in [sweetfx/LICENSE](sweetfx/LICENSE).
- `sweetfx/Shaders/SweetFX/SMAA.fxh` and
  `sweetfx/Textures/SweetFX/{AreaTex,SearchTex}.png`: SMAA by Jorge Jimenez,
  Jose I. Echevarria, Belen Masia, Fernando Navarro and Diego Gutierrez, MIT.
  The original copyright and permission notice is retained in `SMAA.fxh`.
- `sweetfx/MacLauncher/SMAAColor.fx`: the MacLauncher color-edge integration of
  SweetFX's `Shaders/SweetFX/SMAA.fx`. It uses the original SMAA include and
  lookup textures, disables depth predication and omits the stencil optimization.
  The original MIT notices accompany the adaptation's source.

## RetroArch CRT effects

Source: [Matsilagi/RSRetroArch](https://github.com/Matsilagi/RSRetroArch/tree/73dc21fcc9f1e1d6e4bf0f1c5c95b882078d474d),
revision `73dc21fcc9f1e1d6e4bf0f1c5c95b882078d474d`. The ReShade ports retain
their original authors and license declarations:

| Source under `retroarch/Shaders/` | Author | Terms |
| --- | --- | --- |
| `CRTEasymode.fx` | EasyMode | GNU GPL; the upstream header does not specify a version |
| `CRTLottes.fx` | Timothy Lottes | Public domain, as declared in the source header |
| `GTU.fx` | aliaspider; ReShade port by Matsilagi | GNU GPL version 3 |
| `zfast_crt.fx` | Greg Hogan / SoltanGris42 | GNU GPL version 2 or later |

These files are included as complete, unchanged source with their embedded
notices. The full license texts accompany them in
[retroarch/GPL-2.0.txt](retroarch/GPL-2.0.txt) and
[retroarch/GPL-3.0.txt](retroarch/GPL-3.0.txt).

## CRT Royale

Source: [akgunter/crt-royale-reshade](https://github.com/akgunter/crt-royale-reshade/tree/7ca7f7cbb7e7d016ca1756d0855879c3b7d0cc05),
revision `7ca7f7cbb7e7d016ca1756d0855879c3b7d0cc05`. This is Alex Gunter's
ReShade port of TroggleMonkey's CRT Royale, with the original effect and complete
include tree retained unchanged under `crt-royale/Shaders/`.

The effect and GPL includes are licensed under GNU GPL version 2 or later. The
full license accompanies them in [crt-royale/LICENSE.TXT](crt-royale/LICENSE.TXT).
Reusable helper, blur, gamma, quad-pixel and special-function includes retain
their individual embedded MIT notices and original authors. Geometry code also
retains the original cgwg credit. The original source documentation is in
[crt-royale/README.MD](crt-royale/README.MD), and `source-files.json` records the
included paths and checksums. No external lookup textures are required.

## Image filters

`image/` contains MacLauncher color balance, threshold debanding, ordered palette
quantization and soft highlight bloom hooks under the [MIT license](image/LICENSE).
They process RGB textures on the GPU and preserve the input alpha channel.
Color balance assumes encoded sRGB input and applies exposure in linear light.
Debanding averages nearby colors within a threshold and adds optional static
spatial dither. Pixel palette quantizes each channel with optional ordered
dither. These effects retain the current processing dimensions.
