#!/usr/bin/env python3
"""Compare a pynfs --jsonout result with the classified known-failures file.

Usage: check-pynfs-results.py KNOWN_FAILURES_JSON RESULTS_JSON

The comparison is strict in both directions. A failure that is not listed is a defect until
it is classified, and a listed test that now passes is a stale entry to remove. Skipped tests
and a changed selection size also fail, because either means the run no longer matches the
pinned baseline.
"""

import json
import sys

if len(sys.argv) != 3:
    raise SystemExit("Usage: check-pynfs-results.py KNOWN_FAILURES_JSON RESULTS_JSON")

with open(sys.argv[1]) as source:
    known = json.load(source)
with open(sys.argv[2]) as source:
    results = json.load(source)

classes = known["classes"]
listed = known["failures"]
problems = []

for code, entry in listed.items():
    if entry["class"] not in classes:
        problems.append(f"{code}: unknown class {entry['class']!r}")
    if entry["class"] == "disputed" and not entry.get("reference"):
        problems.append(f"{code}: a disputed entry must cite the RFC 8881 rule or erratum in 'reference'")

cases = results["testcase"]
failed = {}
passed = set()
skipped = set()
for case in cases:
    code = case["code"]
    outcome = case.get("failure") or case.get("error")
    if outcome is not None:
        message = outcome.get("message", "") if isinstance(outcome, dict) else str(outcome)
        failed[code] = " ".join(message.split())
    elif case.get("skipped"):
        skipped.add(code)
    else:
        passed.add(code)

selected = len(failed) + len(passed)
if selected != known["suite"]["selected"]:
    problems.append(f"the run selected {selected} tests; the baseline selects {known['suite']['selected']}")

# pynfs lists deselected tests as skipped, so only a skip inside the selection is a problem.
unexpected_skips = sorted(skipped & set(listed))
for code in unexpected_skips:
    problems.append(f"{code}: listed as a known failure but skipped")

for code in sorted(set(failed) - set(listed)):
    problems.append(f"{code}: unclassified failure, a defect until proven otherwise: {failed[code]}")

for code in sorted(set(listed) & passed):
    problems.append(f"{code}: listed as a known failure but passed; remove the stale entry")

for code in sorted(set(listed) - set(failed) - passed - skipped):
    problems.append(f"{code}: listed as a known failure but did not run")

counts = {}
for code in failed:
    if code in listed:
        name = listed[code]["class"]
        counts[name] = counts.get(name, 0) + 1

print(f"pynfs {known['suite']['commit'][:8]}: {selected} selected, {len(passed)} passed, {len(failed)} failed")
for name in classes:
    print(f"  {name:<18} {counts.get(name, 0)}")

if problems:
    print(f"\n{len(problems)} difference(s) from the known-failures file:", file=sys.stderr)
    for problem in problems:
        print(f"FAIL  {problem}", file=sys.stderr)
    sys.exit(1)

print("\nEvery failure matches its classified entry.")
