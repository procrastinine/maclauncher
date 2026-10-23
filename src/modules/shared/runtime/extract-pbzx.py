"""Extract selected files from Apple's PBZX-compressed CPIO package payload.

The system archive reader owns CPIO paths and members; this adapter only unwraps
bounded PBZX chunks. The caller verifies the publisher payload before extraction.
"""
import lzma
import struct
import subprocess
import sys


def extract(payload, destination, members):
    with open(payload, "rb") as source:
        if source.read(4) != b"pbzx" or len(source.read(8)) != 8:
            raise ValueError("Invalid PBZX header")
        child = subprocess.Popen(
            ["/usr/bin/tar", "-xf", "-", "-C", destination, "-T", members],
            stdin=subprocess.PIPE,
        )
        try:
            total = 0
            while header := source.read(16):
                if len(header) != 16:
                    raise ValueError("Truncated PBZX chunk header")
                _, size = struct.unpack(">QQ", header)
                if size > 128 * 1024 * 1024:
                    raise ValueError("PBZX input chunk limit exceeded")
                content = source.read(size)
                if len(content) != size:
                    raise ValueError("Truncated PBZX chunk")
                if content.startswith(b"\xfd7zXZ\0"):
                    decoder = lzma.LZMADecompressor(memlimit=256 * 1024 * 1024)
                    content = decoder.decompress(content, max_length=16 * 1024 * 1024 + 1)
                    if not decoder.eof or decoder.unused_data:
                        raise ValueError("PBZX compressed chunk bounds differ")
                if len(content) > 16 * 1024 * 1024:
                    raise ValueError("PBZX expanded chunk limit exceeded")
                total += len(content)
                if total > 4 * 1024 * 1024 * 1024:
                    raise ValueError("PBZX expanded payload limit exceeded")
                child.stdin.write(content)
            child.stdin.close()
            if child.wait():
                raise RuntimeError("Package payload extraction failed")
        except BaseException:
            child.kill()
            child.wait()
            raise


if __name__ == "__main__":
    extract(*sys.argv[1:])
