# OpenGMK corresponding-source archive

The `0.2.0-9ccc47a9-macos-v7` package uses the same native executable and
`maclauncher-appkit-gl-6` implementation as the preceding Mac package. Its
complete source archive is distributed separately from the app. The app
contains the executable and upstream notices; Play needs no source files.

The source includes the exact emulator build recipe in
`maclauncher-overlay/source-build.js`, its upstream sources, owned adaptations,
locked Rust dependency sources and licenses. `BUILD.md` describes the offline
emulator build. `SOURCE.json` records the pinned upstream and dependency
revisions. The native package records the compiler versions and build options.

`maclauncher-overlay/source-archive.py` creates a new source archive without
extracting or modifying its input:

```sh
python3 maclauncher-overlay/source-archive.py INPUT.tar.gz OUTPUT.tar.gz \
  --expected-sha256 INPUT_SHA256
```

The command uses the script and its `SOURCE_ARCHIVE.md` companion from either
the extracted source package or launcher source. `OUTPUT.tar.gz`
must be a new path. The script adds these two creation files when absent and
checks their exact bytes when already present. Each existing source member
retains its path, type, contents and permissions. Archive members are sorted,
UID and GID are zero, owner and group names are empty, and TAR and gzip
timestamps are zero. The gzip header contains no filename. Repeating creation
from the same inputs produces the same archive; applying the included recipe
to that archive also produces the same bytes with the same Python/zlib version.

Archives contain only regular files and directories. Unsafe paths, duplicate
members, links, permission mismatches, excess sizes and changed input
identities stop creation. Existing output files are preserved. Source archive
metadata changes use a new package version without changing the executable's
compiled source or overlay identity.

## License for MacLauncher source and archive tools

MIT License

Copyright (c) 2026 MacLauncher contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
