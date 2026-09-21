#!/usr/bin/env python3
"""Check sequential visibility between two native NFS clients of one gateway."""

import os
import re
import sys
from pathlib import Path


def write_synced(path: Path, contents: bytes) -> None:
    with path.open("wb") as output:
        output.write(contents)
        output.flush()
        os.fsync(output.fileno())


def expect(path: Path, contents: bytes) -> None:
    actual = path.read_bytes()
    if actual != contents:
        raise RuntimeError(f"{path} contained {actual!r}, expected {contents!r}")


if len(sys.argv) != 4 or sys.argv[1] not in {"create", "second", "first", "finish"}:
    raise SystemExit("Usage: cross-client.py create|second|first|finish MOUNTPOINT TEST_DIRECTORY")

phase, mountpoint, name = sys.argv[1:]

if not re.fullmatch(r"cross-client-[0-9]+", name):
    raise SystemExit("TEST_DIRECTORY must match cross-client-<number>")

if not os.path.ismount(mountpoint):
    raise SystemExit(f"No mount at {mountpoint}")

directory = Path(mountpoint) / name
shared = directory / "shared.txt"
renamed = directory / "renamed.txt"

if phase == "create":
    directory.mkdir()
    write_synced(shared, b"linux-v1\n")
elif phase == "second":
    expect(shared, b"linux-v1\n")
    write_synced(shared, b"mac-v2\n")
    shared.rename(renamed)
elif phase == "first":
    expect(renamed, b"mac-v2\n")
    renamed.rename(shared)
    write_synced(shared, b"linux-v3\n")
else:
    expect(shared, b"linux-v3\n")
    shared.unlink()
    directory.rmdir()

print(f"PASS {phase}: {name}")
