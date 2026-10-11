"""Run the managed RFVP desktop C API on the native process main thread."""
import ctypes
import os
import sys


def main():
    if len(sys.argv) != 5 or sys.argv[3] not in ("sjis", "gbk", "utf8") or sys.argv[4] not in ("0", "1"):
        raise ValueError("RFVP needs a library, game directory, text encoding and text scaling option.")
    library_path, game_root, encoding, hidpi = sys.argv[1:]
    if not os.path.isabs(library_path) or not os.path.isabs(game_root):
        raise ValueError("RFVP paths must be absolute.")
    library = ctypes.CDLL(library_path)
    entry = library.rfvp_run_entry
    entry.argtypes = (ctypes.c_char_p, ctypes.c_char_p)
    entry.restype = ctypes.c_int32
    scaling = library.rfvp_set_text_hidpi_enabled
    scaling.argtypes = (ctypes.c_int32,)
    scaling.restype = None
    scaling(int(hidpi))
    result = entry(os.fsencode(game_root), encoding.encode("ascii"))
    if result:
        print("RFVP could not initialize this game. Check its data files, selected runtime version and text encoding.", file=sys.stderr)
    return result


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, AttributeError) as error:
        print("RFVP could not start: " + str(error), file=sys.stderr)
        sys.exit(1)
