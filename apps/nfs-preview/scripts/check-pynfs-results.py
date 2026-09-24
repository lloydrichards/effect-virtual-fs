#!/usr/bin/env python3
"""Compare a pynfs testserver.py log with the classified known-failures file.

Usage: check-pynfs-results.py KNOWN_FAILURES_JSON PYNFS_LOG

The log is the verdict source because it is the only pynfs output that names every outcome.
The --jsonout file writes WARNING, UNSUPPORTED, and dependency-omitted tests the same way as
a PASS or a deselected test, so it cannot prove a clean run.

The comparison is strict in both directions. It fails when the selected tests differ from
the pinned codes, when a selected test ends in anything but PASS or FAILURE, when a failure
is not listed, and when a listed test passes.
"""

import json
import re
import sys

ENTRY_KEYS = {"class", "reason", "reference"}
# printresults() writes each shown test as "%-65s : %s"; messages follow on indented lines.
RESULT_LINE = re.compile(r"^(\S+)\s+(\S+)\s+: (.+)$")
SUMMARY_LINE = re.compile(r"^Command line asked for (\d+) of (\d+) tests$")


def fail(message):
    print(f"FAIL  {message}")
    sys.exit(1)


def validate_known(known):
    """Returns the problems in the known-failures file itself."""
    problems = []
    classes = known["classes"]
    selected = known["suite"]["selected"]
    if len(selected) != len(set(selected)):
        problems.append("suite.selected lists a code more than once")
    for code, entry in known["failures"].items():
        extra = set(entry) - ENTRY_KEYS
        if extra:
            problems.append(f"{code}: unknown field(s) {sorted(extra)}")
        if entry.get("class") not in classes:
            problems.append(f"{code}: unknown class {entry.get('class')!r}")
        if not str(entry.get("reason", "")).strip():
            problems.append(f"{code}: an entry must give a reason")
        has_reference = bool(str(entry.get("reference", "")).strip())
        if entry.get("class") == "disputed" and not has_reference:
            problems.append(f"{code}: a disputed entry must cite the RFC 8881 rule or erratum in 'reference'")
        if entry.get("class") != "disputed" and "reference" in entry:
            problems.append(f"{code}: only disputed entries carry a reference")
        if code not in selected:
            problems.append(f"{code}: listed as a known failure but not in suite.selected")
    return problems


def read_outcomes(log):
    """Returns the pynfs summary counts and each shown test's outcome and message."""
    lines = log.splitlines()
    summary = [index for index, line in enumerate(lines) if SUMMARY_LINE.match(line)]
    if len(summary) != 1:
        fail("the log has no single 'Command line asked for' summary; the run was interrupted or crashed")
    asked, total = map(int, SUMMARY_LINE.match(lines[summary[0]]).groups())
    # The result block sits between the last two rules before the summary.
    rules = [index for index, line in enumerate(lines[: summary[0]]) if line == "*" * 50]
    if len(rules) < 2:
        fail("the log has no result block before its summary")
    outcomes = {}
    messages = {}
    current = None
    for line in lines[rules[-2] + 1 : rules[-1]]:
        match = RESULT_LINE.match(line)
        if match:
            current = match.group(1)
            if current in outcomes:
                fail(f"{current}: the log reports this code more than once")
            outcomes[current] = match.group(3)
            messages[current] = []
        elif current and line.startswith(" "):
            messages[current].append(line.strip())
        elif line.strip():
            fail(f"unrecognised result line: {line!r}")
    return asked, total, outcomes, {code: " ".join(text) for code, text in messages.items()}


if len(sys.argv) != 3:
    sys.exit("Usage: check-pynfs-results.py KNOWN_FAILURES_JSON PYNFS_LOG")

try:
    with open(sys.argv[1]) as source:
        known = json.load(source)
    with open(sys.argv[2]) as source:
        log = source.read()
    suite = known["suite"]
    listed = known["failures"]
    selected = set(suite["selected"])
    problems = validate_known(known)
except (OSError, ValueError, KeyError, TypeError) as error:
    fail(f"could not read the inputs: {error!r}")

asked, total, outcomes, messages = read_outcomes(log)

if total != suite["catalog"]:
    problems.append(f"the suite catalog has {total} tests; the pin records {suite['catalog']}")
if asked != len(selected):
    problems.append(f"the run selected {asked} tests; the pin selects {len(selected)}")
for code in sorted(selected - set(outcomes)):
    problems.append(f"{code}: pinned as selected but did not report a result")
for code in sorted(set(outcomes) - selected):
    problems.append(f"{code}: reported a result but is not pinned as selected")

failed = set()
passed = set()
for code, outcome in outcomes.items():
    if outcome == "FAILURE":
        failed.add(code)
    elif outcome == "PASS":
        passed.add(code)
    else:
        problems.append(f"{code}: ended in {outcome}, which is neither PASS nor a classified FAILURE")

for code in sorted(failed - set(listed)):
    problems.append(f"{code}: unclassified failure, a defect until proven otherwise: {messages[code]}")
for code in sorted(set(listed) & passed):
    problems.append(f"{code}: listed as a known failure but passed; remove the stale entry")

counts = {name: 0 for name in known["classes"]}
for code in failed & set(listed):
    name = listed[code].get("class")
    counts[name] = counts.get(name, 0) + 1

print(f"pynfs {suite['commit'][:8]}: {len(outcomes)} reported, {len(passed)} passed, {len(failed)} failed")
for name, count in counts.items():
    print(f"  {name:<20} {count}")

if problems:
    print(f"\n{len(problems)} difference(s) from the known-failures file:")
    for problem in problems:
        print(f"FAIL  {problem}")
    sys.exit(1)

print("\nEvery selected test passed or failed as classified.")
