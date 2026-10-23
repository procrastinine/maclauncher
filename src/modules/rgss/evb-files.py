"""Read Enigma's virtual files without executing or restoring the Windows EXE."""
import json
import os
import sys

from evbunpack import __main__ as evb


def process(source, destination=None, legacy=False):
    entries = []
    with open(source, "rb") as stream:
        magic = evb.search_for_magic(stream, os.fstat(stream.fileno()).st_size, evb.EVB_MAGIC)
        if magic < 0:
            raise ValueError("Enigma virtual filesystem not found")
        stream.seek(magic)
        nodes = iter(evb.completed(evb.legacy_pe_tree(stream) if legacy else evb.pe_external_tree(stream)))
        main = next(nodes)

        def walk(node, parents):
            name = node["name"]
            if node["type"] == evb.NODE_TYPE_FOLDER:
                name = evb.FOLDER_ALTNAMES.get(name, name)
            if name in (".", "..") or any(char in name for char in ("/", "\\", ":", "\0")):
                raise ValueError("Unsafe Enigma filename")
            parts = parents + ([name] if name else [])
            if node["type"] == evb.NODE_TYPE_FOLDER:
                for _ in range(node["objects_count"]):
                    walk(next(nodes), parts)
            elif node["type"] == evb.NODE_TYPE_FILE:
                if not parts:
                    raise ValueError("Empty Enigma filename")
                entries.append("/".join(parts))
                if destination:
                    target = os.path.join(destination, *parts)
                    os.makedirs(os.path.dirname(target), exist_ok=True)
                    evb.process_file_node(stream, target, node)
            else:
                raise ValueError("Unsupported Enigma node")

        for _ in range(main["objects_count"]):
            walk(next(nodes), [])
    return entries


if __name__ == "__main__":
    source = sys.argv[1]
    destination = sys.argv[2] if len(sys.argv) > 2 else None
    legacy = "--legacy" in sys.argv[3:]
    print(json.dumps(process(source, destination, legacy)))
