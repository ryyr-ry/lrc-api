#!/usr/bin/env python3
"""
FUSE virtual filesystem that serves JSON chunks from zstd-compressed files.
partykit deploy reads files via FUSE; content is decompressed on-demand.

Based on mfusepy (ctypes bindings for libfuse 2/3).
"""

import os
import sys
import json
import time
import stat
import errno

try:
    import orjson
    HAVE_ORJSON = True
except ImportError:
    HAVE_ORJSON = False

import zstandard
import mfusepy as fuse

MANIFEST_PATH = sys.argv[1]
CHUNK_DIR = sys.argv[2]
MOUNT_POINT = sys.argv[3]


def loads_json(data):
    if HAVE_ORJSON:
        return orjson.loads(data)
    return json.loads(data)


class ChunkVFS(fuse.Operations):
    def __init__(self, manifest_path, chunk_dir):
        print(f"Loading manifest: {manifest_path}", flush=True)
        with open(manifest_path) as f:
            self.manifest = json.load(f)

        self.chunk_dir = chunk_dir
        self.files = {}
        self.file_list = []
        now = int(time.time() * 1e9)

        for entry in self.manifest["files"]:
            name = entry["name"]
            path = f"/{name}"
            self.files[path] = {
                "st_mode": stat.S_IFREG | 0o444,
                "st_nlink": 1,
                "st_size": entry["size"],
                "st_ctime": now,
                "st_mtime": now,
                "st_atime": now,
                "st_uid": os.getuid() if hasattr(os, "getuid") else 0,
                "st_gid": os.getgid() if hasattr(os, "getgid") else 0,
            }
            self.file_list.append(name)

        self.root_stat = {
            "st_mode": stat.S_IFDIR | 0o755,
            "st_nlink": 2,
            "st_size": 0,
            "st_ctime": now,
            "st_mtime": now,
            "st_atime": now,
            "st_uid": os.getuid() if hasattr(os, "getuid") else 0,
            "st_gid": os.getgid() if hasattr(os, "getgid") else 0,
        }

        self._cache = {}
        self._cache_max = 3
        self._dctx = zstandard.ZstdDecompressor()

        print(f"FUSE ready: {len(self.file_list)} virtual files", flush=True)

    def _get_file_content(self, name):
        if name in self._cache:
            content = self._cache.pop(name)
            self._cache[name] = content
            return content

        zst_path = os.path.join(self.chunk_dir, name + ".zst")
        if not os.path.exists(zst_path):
            return b"[]"

        with open(zst_path, "rb") as f:
            compressed = f.read()
        content = self._dctx.decompress(compressed)

        if len(self._cache) >= self._cache_max:
            oldest = next(iter(self._cache))
            del self._cache[oldest]
        self._cache[name] = content

        return content

    @fuse.overrides(fuse.Operations)
    def getattr(self, path, fh=None):
        if path == "/":
            return self.root_stat
        if path in self.files:
            return self.files[path]
        raise fuse.FuseOSError(errno.ENOENT)

    @fuse.overrides(fuse.Operations)
    def readdir(self, path, fh):
        yield "."
        yield ".."
        for name in self.file_list:
            yield name

    @fuse.overrides(fuse.Operations)
    def read(self, path, size, offset, fh):
        name = path.lstrip("/")
        content = self._get_file_content(name)
        return content[offset:offset + size]

    @fuse.overrides(fuse.Operations)
    def open(self, path, flags):
        return 0

    @fuse.overrides(fuse.Operations)
    def release(self, path, fh):
        return 0

    @fuse.overrides(fuse.Operations)
    def statfs(self, path):
        return {
            "f_bsize": 512,
            "f_blocks": 4096 * 1024 * 1024,
            "f_bavail": 2048 * 1024 * 1024,
            "f_files": len(self.file_list),
            "f_ffree": 0,
        }


def main():
    print(f"Mount: {MOUNT_POINT}", flush=True)
    print(f"Manifest: {MANIFEST_PATH}", flush=True)
    print(f"Chunk dir: {CHUNK_DIR}", flush=True)

    fs = ChunkVFS(MANIFEST_PATH, CHUNK_DIR)
    fuse.FUSE(fs, MOUNT_POINT, foreground=True, nothreads=True)


if __name__ == "__main__":
    main()
