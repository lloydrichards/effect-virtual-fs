"""Measure installed tree entries without recursively expanding dependency aliases.

Usage: python3 measure.py INSTALL_ROOT OUTPUT_JSON
Paths map INSTALL_ROOT to /project. Host checkout prefixes are excluded.
"""
from collections import deque
import hashlib
import json
import math
import os
from pathlib import Path
import sys

root = Path(sys.argv[1]).resolve()
paths, components, links, packages = [], [], [], []
for directory, dirs, files in os.walk(root / 'node_modules', followlinks=False):
    for name in dirs + files:
        path = Path(directory) / name
        relative = path.relative_to(root).as_posix()
        virtual = '/project/' + relative
        paths.append({'path': virtual, 'bytes': len(os.fsencode(virtual))})
        components.append(len(os.fsencode(name)))
        if path.is_symlink():
            target = os.readlink(path)
            resolved = path.resolve()
            links.append({'path': virtual, 'target': target,
                          'targetBytes': len(os.fsencode(target)),
                          'resolvedPathBytes': len(os.fsencode('/project/' + resolved.relative_to(root).as_posix()))
                          if resolved.is_relative_to(root) else None,
                          'exists': path.exists()})
        elif name == 'package.json':
            data = json.loads(path.read_text())
            if 'name' in data and 'version' in data:
                packages.append({'path': virtual, 'name': data['name'], 'version': data['version']})

def stats(values):
    values = sorted(values)
    return {'count': len(values), 'max': max(values, default=0),
            **{f'p{n}': values[max(0, math.ceil(len(values)*n/100)-1)] if values else 0 for n in [50, 95, 99]}}

def trace(relative):
    pending = deque(Path(relative).parts)
    current = root
    followed = 0
    maximum = 0
    while pending:
        part = pending.popleft()
        if part == '.':
            continue
        if part == '..':
            current = current.parent
            continue
        candidate = current / part
        if candidate.is_symlink():
            followed += 1
            if followed > 100:
                return {'error': 'traversal probe exceeded 100'}
            target = os.readlink(candidate)
            replacement = target + ('/' + '/'.join(pending) if pending else '')
            maximum = max(maximum, len(os.fsencode(replacement)))
            if os.path.isabs(target):
                return {'error': 'absolute host target'}
            pending = deque(Path(target).parts + tuple(pending))
        else:
            current = candidate
    return {'followed': followed, 'maxReplacementBytes': maximum, 'exists': current.exists()}

for link in links:
    relative = link['path'].removeprefix('/project/')
    link['resolution'] = trace(relative)
    if (root / relative).is_dir():
        link['packageJsonResolution'] = trace(relative + '/package.json')

locks = {}
for name in ['package-lock.json', 'pnpm-lock.yaml']:
    path = root / name
    if path.exists():
        locks[name] = hashlib.sha256(path.read_bytes()).hexdigest()
result = {'virtualRoot': '/project', 'manifest': json.loads((root/'package.json').read_text()),
          'lockSha256': locks, 'pathBytes': stats([p['bytes'] for p in paths]),
          'componentBytes': stats(components), 'symlinkTargetBytes': stats([p['targetBytes'] for p in links]),
          'symlinks': links, 'packageInventory': sorted(packages, key=lambda p:p['path']),
          'longestPaths': sorted(paths,key=lambda p:p['bytes'],reverse=True)[:5],
          'pathsOverCandidates': {str(n): sum(p['bytes'] > n for p in paths) for n in [1024,4096,16384]},
          'limitations': 'Physical installed entries; no recursive alias expansion, build, or complete resolver simulation.'}
Path(sys.argv[2]).write_text(json.dumps(result,indent=2)+'\n')
print(root.name, json.dumps({k:result[k] for k in ['pathBytes','componentBytes','symlinkTargetBytes','pathsOverCandidates']}))
