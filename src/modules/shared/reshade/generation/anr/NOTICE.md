# ANR Metal runtime

`native/anr_runtime.h`, `native/anr_runtime.mm` and `native/convert_dxil.mm`
come from fsr4-native-macos, revision
`e9d12070dd9b81dc7ec1725368c71a4d3859a108`, under MIT.
`nrx.js` and `prepare.js` adapt its NRX decoder and preparation algorithm.
The accompanying LICENSE.txt preserves the upstream notice.

Source: https://github.com/UzenUPoZiTiV4ik/fsr4-native-macos

Apex Neural Rendering weights, compiled kernels, test frames and Apple's
converter library are separate user-supplied inputs. They are not part of
this source or graphics package and retain their respective terms.
