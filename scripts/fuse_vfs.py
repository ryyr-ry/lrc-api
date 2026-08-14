#!/usr/bin/env python3
"""
FUSE virtual filesystem that serves JSON chunks on-demand from SQLite via RapidgzipFile.
partykit deploy sees N virtual files; each file's content is generated when read() is called.

Based on mfusepy (ctypes bindings for libfuse 2/3).
"""

import os
import sys
import json
import time
import stat
import errno
import struct
import apsw
from rapidgzip import RapidgzipFile

import mfusepy as fuse

MANIFEST_PATH = sys.argv[1]
GZIP_PATH = sys.argv[2]
MOUNT_POINT = sys.argv[3]

MAX_FILE_SIZE = 18 * 1024 * 1024


class GzipVFSFile:
    def __init__(self, gz_file, db_size):
        self._gz = gz_file
        self._size = db_size
        self._level = apsw.SQLITE_LOCK_NONE

    def xRead(self, amount, offset):
        self._gz.seek(offset)
        data = self._gz.read(amount)
        if len(data) < amount:
            data += b"\x00" * (amount - len(data))
        return data

    def xFileSize(self):
        return self._size

    def xClose(self):
        pass

    def xLock(self, level):
        self._level = level

    def xUnlock(self, level):
        self._level = level

    def xCheckReservedLock(self):
        return False

    def xSync(self, flags):
        return True

    def xSectorSize(self):
        return 4096

    def xDeviceCharacteristics(self):
        return apsw.SQLITE_IOCAP_IMMUTABLE

    def xTruncate(self, newsize):
        pass

    def xWrite(self, data, offset):
        pass

    def xFileControl(self, op, ptr):
        return False

    def xShmMap(self, *a):
        raise apsw.IOError("Shared memory not supported")

    def xShmBarrier(self):
        pass

    def xShmUnmap(self):
        pass


class GzipVFS(apsw.VFS):
    def __init__(self, gz_file, db_size, name="gzipvfs"):
        self._gz = gz_file
        self._size = db_size
        self.vfs_name = name
        super().__init__(name, base="")

    def xOpen(self, name, flags):
        return GzipVFSFile(self._gz, self._size)

    def xDelete(self, name, syncdir):
        pass

    def xAccess(self, name, flags):
        return True

    def xFullPathname(self, name):
        return name

    def xSleep(self, us):
        time.sleep(us / 1e6)
        return True

    def xCurrentTime(self):
        return time.time() / 86400.0 + 2440587.5

    def xGetLastError(self):
        return (0, "")

    def xDlError(self):
        return ""

    def xRandomness(self, n):
        return os.urandom(n)


def normalize(text):
    if not text:
        return ""
    import unicodedata
    s = unicodedata.normalize("NFKC", text).lower()
    for c in "`~!@#$%^&*()_|+-=?;:\",.<>{}[]\\/\x00\n":
        s = s.replace(c, " ")
    s = s.replace("'", "").replace("\u2019", "")
    return " ".join(s.split())


def chunk_index(artist, track, num_chunks):
    key = (normalize(artist) + " " + normalize(track)).encode("utf-8")
    h = 0x811c9dc5
    for b in key:
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h % num_chunks


class ChunkVFS(fuse.Operations):
    def __init__(self, manifest_path, gzip_path):
        print(f"Loading manifest: {manifest_path}", flush=True)
        with open(manifest_path) as f:
            self.manifest = json.load(f)

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

        self.num_chunks = self.manifest["num_chunks"]
        self.track_ids_by_file = {f["name"]: f["track_ids"] for f in self.manifest["files"]}

        print(f"Opening RapidgzipFile: {gzip_path}", flush=True)
        self.gz = RapidgzipFile(gzip_path, parallelization=os.cpu_count())

        header = self.gz.read(100)
        page_size = struct.unpack(">H", header[16:18])[0]
        if page_size == 1:
            page_size = 65536
        page_count = struct.unpack(">I", header[28:32])[0]
        db_size = page_size * page_count
        self.gz.seek(0)

        print(f"Registering VFS...", flush=True)
        self.vfs = GzipVFS(self.gz, db_size)
        self.conn = apsw.Connection(
            "file:dummy?immutable=1",
            vfs=self.vfs.vfs_name,
            flags=apsw.SQLITE_OPEN_READONLY | apsw.SQLITE_OPEN_URI,
        )

        self._cache = {}
        self._cache_max = 3  # cache 3 files max (~54 MB)

        print(f"FUSE ready: {len(self.file_list)} virtual files", flush=True)

    def _get_file_content(self, name):
        if name in self._cache:
            content = self._cache.pop(name)
            self._cache[name] = content  # move to end (LRU)
            return content

        track_ids = self.track_ids_by_file.get(name)
        if not track_ids:
            return b""

        cur = self.conn.cursor()
        id_list = ",".join(str(tid) for tid in track_ids)
        query = f"""
            SELECT t.id, t.name, t.artist_name, t.album_name, t.duration,
                   l.instrumental,
                   l.plain_lyrics, l.synced_lyrics, l.lyricsfile
            FROM tracks t
            LEFT JOIN lyrics l ON t.last_lyrics_id = l.id
            WHERE t.id IN ({id_list})
            ORDER BY t.id
        """

        records = []
        for row in cur.execute(query):
            rec = {
                "id": row[0],
                "name": row[1] or "",
                "trackName": row[1] or "",
                "artistName": row[2] or "",
                "albumName": row[3] or "",
                "duration": row[4] if row[4] is not None else 0,
                "instrumental": bool(row[5]) if row[5] is not None else False,
                "plainLyrics": row[6],
                "syncedLyrics": row[7],
                "lyricsfile": row[8],
                "nameLower": normalize(row[1] or ""),
                "artistNameLower": normalize(row[2] or ""),
                "albumNameLower": normalize(row[3] or ""),
            }
            records.append(rec)

        content = json.dumps(records, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

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
    print(f"Gzip: {GZIP_PATH}", flush=True)

    fs = ChunkVFS(MANIFEST_PATH, GZIP_PATH)
    fuse.FUSE(fs, MOUNT_POINT, foreground=True, nothreads=True)


if __name__ == "__main__":
    main()
