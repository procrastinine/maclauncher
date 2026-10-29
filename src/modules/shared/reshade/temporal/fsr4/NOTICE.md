# FSR 4 Metal provider notices

The native FSR 4.1.1 implementation is adapted from
[fsr4-native-macos](https://github.com/UzenUPoZiTiV4ik/fsr4-native-macos/tree/329d1d7367b6b948a53486505198a5d254f02809)
by UzenUPoZiTiV4ik. The runtime and native Metal implementation declare
`SPDX-License-Identifier: MIT` in their source files.

The FSR 4.1.1 shader reimplementation and model notices are preserved in
`third_party/fsr411/LICENSE` and `third_party/fsr411/LICENSE.AMD.md`.
The former includes the Advanced Micro Devices and int3rrobang copyright notices;
the latter records the MIT exception for the original AMD provider containing the
model weights. Source identities are recorded in `provider.json`.

The AMD shader helpers retain these source copyright notices:

Copyright (C) 2025 Advanced Micro Devices, Inc.

Copyright(C) 2024-2025 Advanced Micro Devices, Inc. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

FSR4 Lite uses the upstream folded coefficients, rounding and inference-reuse
policy. FSR4 Lite2 replaces six layers with integer weights from
[fsr4-shader-performance-overrides](https://github.com/zgauthier2000/fsr4-shader-performance-overrides/tree/69cc9b9979a8fe90b97b1ed2f20e94487df261e2),
under GPL-2.0-or-later. The original source archive is retained in the producer source inputs. Its license
is retained as `third_party/fsr411/LICENSE.Lite2.txt` in the runtime.
Their hashes and distinct profile identities are recorded in `provider.json`.
Lite2 uses the unchanged Lite network for Ultra Performance; its six trained
layers apply to the normal model family. The exact-fast default retains the
original AMD model coefficients.
