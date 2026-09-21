#!/usr/bin/env python3
"""Prepare, write, and verify one file across an injected R2 response loss."""

import os
import sys
from pathlib import Path

if len(sys.argv) != 3 or sys.argv[1] not in {"prepare", "write", "verify"}:
    raise SystemExit("Usage: fault-file.py prepare|write|verify FILE")

phase, filename = sys.argv[1:]
path = Path(filename)

if phase == "prepare":
    with path.open("wb") as output:
        output.write(b"old-content\n")
        output.flush()
        os.fsync(output.fileno())
    print("PASS prepared and synced old content")
elif phase == "write":
    try:
        with path.open("r+b", buffering=0) as output:
            output.write(b"new-content\n")
            os.fsync(output.fileno())
    except OSError as error:
        print(f"EXPECTED write or fsync error: {error}")
    else:
        raise SystemExit("FAIL: uncertain NFS WRITE reported success")
else:
    actual = path.read_bytes()
    if actual != b"new-content\n":
        raise SystemExit(f"FAIL: recovered {actual!r}")
    path.unlink()
    print("PASS recovered complete content and removed test file")
