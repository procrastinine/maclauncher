"""Bounded primitive-only archive-index loading and correct multi-part reads.

The rpatool checkout stays read-only. RPA indexes are dictionaries of filename ->
lists of primitive tuples; reducer/global/object-construction opcodes have no
place here. This loader is deliberately unrelated to Ren'Py save unpickling.
"""
import io
import os
import pickle
import pickletools
import zlib
from pathlib import Path, PurePosixPath

MAX_INDEX_BYTES = 32 * 1024 * 1024
MAX_FILES = 250000
MAX_MEMBER_BYTES = 512 * 1024 * 1024
MAX_ARCHIVE_OUTPUT_BYTES = 8 * 1024 * 1024 * 1024
PRIMITIVE_OPS = frozenset("PROTO FRAME STOP MARK POP POP_MARK DUP NONE NEWTRUE NEWFALSE INT BININT BININT1 BININT2 LONG LONG1 LONG4 STRING BINSTRING SHORT_BINSTRING UNICODE BINUNICODE SHORT_BINUNICODE BINUNICODE8 BINBYTES SHORT_BINBYTES BINBYTES8 EMPTY_LIST APPEND APPENDS LIST EMPTY_TUPLE TUPLE TUPLE1 TUPLE2 TUPLE3 EMPTY_DICT DICT SETITEM SETITEMS PUT BINPUT LONG_BINPUT MEMOIZE GET BINGET LONG_BINGET".split())


class PrimitiveUnpickler(pickle.Unpickler):
    def find_class(self, module, name):
        raise ValueError("Object construction is forbidden in RPA indexes")

    def persistent_load(self, pid):
        raise ValueError("Persistent references are forbidden in RPA indexes")


def load_primitive_index(blob):
    if len(blob) > MAX_INDEX_BYTES:
        raise ValueError("RPA index exceeds size limit")
    last_position = None
    for count, (opcode, argument, position) in enumerate(pickletools.genops(blob)):
        if count > 2000000:
            raise ValueError("RPA index exceeds opcode limit")
        if opcode.name not in PRIMITIVE_OPS:
            raise ValueError("Forbidden RPA index pickle opcode: " + opcode.name)
        last_position = position
    if last_position != len(blob) - 1:
        raise ValueError("RPA index contains trailing data")
    return PrimitiveUnpickler(io.BytesIO(blob), encoding="latin1").load()


def decompress_index(compressed):
    if len(compressed) > MAX_INDEX_BYTES:
        raise ValueError("Compressed RPA index exceeds size limit")
    inflater = zlib.decompressobj()
    blob = inflater.decompress(compressed, MAX_INDEX_BYTES + 1)
    if len(blob) > MAX_INDEX_BYTES or inflater.unconsumed_tail or not inflater.eof or inflater.unused_data:
        raise ValueError("Invalid or oversized compressed RPA index")
    return blob


def normalized_member_name(name):
    if isinstance(name, bytes):
        name = name.decode("utf-8")
    if type(name) is not str or not name or "\\" in name or "\x00" in name:
        raise ValueError("Invalid RPA member name")
    parts = name.split("/")
    if name.startswith("/") or any(p in ("", ".", "..") for p in parts) or ":" in parts[0]:
        raise ValueError("Unsafe RPA member name: " + name)
    return name


def safe_output_path(root, name):
    name = normalized_member_name(name)
    root = Path(root).resolve()
    target = root.joinpath(*PurePosixPath(name).parts)
    target.resolve().relative_to(root)
    # Reject even in-root symlinks so extraction never modifies another file
    # through an alias or races an existing symlink in a partial destination.
    for part in [target, *target.parents]:
        if part == root:
            break
        if part.is_symlink():
            raise ValueError("RPA output path contains a symlink")
    return target


def safe_archive_class(base):
    class SafeRenPyArchive(base):
        def get_version(self):
            self.handle.seek(0)
            magic = self.handle.readline(1024)
            for signature, version in ((b"RPA-3.2 ", 3.2), (b"RPA-3.0 ", 3), (b"RPA-2.0 ", 2)):
                if magic.startswith(signature):
                    return version
            if self.file.lower().endswith(".rpi"):
                return 1
            raise ValueError("Invalid or unsupported RPA archive header")

        def extract_indexes(self):
            self.handle.seek(0)
            size = os.fstat(self.handle.fileno()).st_size
            header_size = 0
            if self.version in (2, 3, 3.2):
                metadata = self.handle.readline(1024)
                if not metadata.endswith(b"\n"):
                    raise ValueError("Invalid RPA header")
                header_size = len(metadata)
                values = metadata.split()
                index_offset = int(values[1], 16)
                self.key = 0
                if self.version in (3, 3.2):
                    for subkey in values[3 if self.version == 3.2 else 2:]:
                        self.key ^= int(subkey, 16)
                if index_offset < header_size or index_offset > size:
                    raise ValueError("RPA index offset is outside archive")
                if size - index_offset > MAX_INDEX_BYTES:
                    raise ValueError("Compressed RPA index exceeds size limit")
                self.handle.seek(index_offset)
                data_limit = index_offset
            else:
                if size > MAX_INDEX_BYTES:
                    raise ValueError("Compressed RPI index exceeds size limit")
                companion = Path(self.file).with_suffix(".rpa")
                data_limit = companion.stat().st_size
            index = load_primitive_index(decompress_index(self.handle.read(MAX_INDEX_BYTES + 1)))
            if type(index) is not dict or len(index) > MAX_FILES:
                raise ValueError("Invalid or oversized RPA index dictionary")
            result = {}
            total_size = 0
            for name, chunks in index.items():
                name = normalized_member_name(name)
                if name in result or type(chunks) is not list or not chunks or len(chunks) > 65536:
                    raise ValueError("Invalid RPA member chunks")
                normalized_chunks = []
                member_size = 0
                for chunk in chunks:
                    if type(chunk) is not tuple or len(chunk) not in (2, 3):
                        raise ValueError("Invalid RPA member tuple")
                    offset, length = chunk[:2]
                    if type(offset) is not int or type(length) is not int:
                        raise ValueError("Invalid RPA member offset or length")
                    if self.version in (3, 3.2):
                        offset ^= self.key
                        length ^= self.key
                    prefix = chunk[2] if len(chunk) == 3 else b""
                    if prefix is None:
                        prefix = b""
                    if type(prefix) is str:
                        prefix = prefix.encode("latin1")
                    if type(prefix) is not bytes or offset < header_size or length < 0 or offset + length > data_limit:
                        raise ValueError("RPA member is outside archive")
                    # Ren'Py treats the prefix separately from the disk length.
                    member_size += length + len(prefix)
                    if member_size > MAX_MEMBER_BYTES:
                        raise ValueError("RPA member exceeds extraction size limit")
                    normalized_chunks.append((offset, length, prefix))
                total_size += member_size
                if total_size > MAX_ARCHIVE_OUTPUT_BYTES:
                    raise ValueError("RPA archive exceeds total extraction size limit")
                result[name] = normalized_chunks
            return result

        def load(self, filename):
            super().load(filename)
            if self.version == 1:
                self.handle.close()
                self.handle = open(Path(self.file).with_suffix(".rpa"), "rb")

        def read(self, filename):
            chunks = self.indexes[normalized_member_name(filename)]
            output = []
            for offset, length, prefix in chunks:
                self.handle.seek(offset)
                blob = self.handle.read(length)
                if len(blob) != length:
                    raise ValueError("RPA member is truncated")
                output.extend((prefix, blob))
            return b"".join(output)

    return SafeRenPyArchive
