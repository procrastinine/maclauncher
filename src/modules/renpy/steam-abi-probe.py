"""Inspect the selected, trusted Ren'Py SDK provider without loading Steam/game code."""
from __future__ import print_function
import hashlib
import json
import os
import sys

lib_root = os.path.realpath(sys.argv[1])
# Never import a game's Python package or environment-supplied Steam wrapper.
sys.path = [entry for entry in sys.path if entry and
            os.path.realpath(entry).startswith(lib_root + os.sep)]
import steamapi
provider = os.path.realpath(steamapi.__file__)
if not provider.startswith(lib_root + os.sep):
    raise RuntimeError("Steam provider is outside the selected Ren'Py runtime.")
if os.path.getsize(provider) > 4 * 1024 * 1024:
    raise RuntimeError("Ren'Py Steam provider exceeds inspection limits.")

class Function(object):
    def __call__(self, *args):
        raise RuntimeError("Steam ABI inspection must not call native functions.")

class Library(object):
    def __init__(self):
        self.names = set()
    def __getattr__(self, name):
        if not name.startswith(("SteamAPI_", "SteamInternal_", "GetHSteam")):
            raise RuntimeError("Unknown Ren'Py native Steam symbol: " + name)
        self.names.add(name)
        return Function()

library = Library()
steamapi.load(library)
if not library.names or len(library.names) > 4096:
    raise RuntimeError("Ren'Py Steam API requirements exceed inspection limits.")
with open(provider, "rb") as source:
    digest = hashlib.sha256(source.read()).hexdigest()
print(json.dumps({"provider": provider, "sha256": digest,
                  "executable": os.path.realpath(sys.executable),
                  "python": list(sys.version_info[:3]), "symbols": sorted(library.names)}))
