#!/usr/bin/env python3
"""Fail if a tracked file looks like it carries real personal data.

The repo is public. Real users' transactions, ids and amounts belong in the
terminal, never in a committed file. This scans every tracked text file for
three shapes:

  clerk-user-id     a Clerk user id: "user_" and 27 letters/digits
  plaid-id          a Plaid-style id: 37 letters/digits mixing upper, lower
                    and digits (transaction, account and item ids)
  amount-near-date  a date (YYYY-MM-DD or MM/DD[/YY]) with an amount in cents
                    later on the same line, within 60 characters

It prints path, line and kind — never the match, so a real hit doesn't end up
in a public CI log.

An invented id says so: any id containing FAKE is allowed
("user_2FAKE..."). A file whose matches are all invented (generated from the
demo seed, say) goes in .github/personal-data-allowlist.txt with a reason.
Tests are scanned like everything else: a real id was once found in one.

What it can't see: real figures written as prose ("125 inflows totalling ...").
Describe real-account findings in relative terms.
"""
import os
import re
import subprocess
import sys

ALLOWLIST = ".github/personal-data-allowlist.txt"

PATTERNS = {
    "clerk-user-id": re.compile(r"\buser_[A-Za-z0-9]{27}\b"),
    "plaid-id": re.compile(
        r"\b(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{37}\b"
    ),
    "amount-near-date": re.compile(
        r"(?:\b20\d\d-\d\d-\d\d\b|\b\d\d/\d\d(?:/\d\d(?:\d\d)?)?\b)[^\n]{0,60}?-?\$?\b\d{1,6}\.\d{2}\b"
    ),
}
# Ids may opt out by saying they're invented; an amount next to a date can't.
FAKE_MARKER_KINDS = {"clerk-user-id", "plaid-id"}

SKIP_PREFIXES = ("frontend/node_modules/",)
SKIP_SUFFIXES = ("package-lock.json", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg", ".pdf", ".woff", ".woff2")


def load_allowlist():
    allowed, problems = {}, []
    if not os.path.exists(ALLOWLIST):
        return allowed, problems
    with open(ALLOWLIST, encoding="utf-8") as f:
        for n, raw in enumerate(f, 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            path, _, reason = line.partition("#")
            path, reason = path.strip(), reason.strip()
            if not reason:
                problems.append(f"{ALLOWLIST}:{n}: an allowlisted file needs a reason after '#'")
            elif not os.path.exists(path):
                problems.append(f"{ALLOWLIST}:{n}: {path} no longer exists; remove the entry")
            else:
                allowed[path] = reason
    return allowed, problems


def main():
    files = subprocess.run(["git", "ls-files"], capture_output=True, text=True, check=True).stdout.splitlines()
    allowed, problems = load_allowlist()
    hits = []
    scanned = 0
    for path in files:
        if path in allowed or path.startswith(SKIP_PREFIXES) or path.endswith(SKIP_SUFFIXES):
            continue
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            continue
        if b"\x00" in data[:8000]:
            continue  # binary
        scanned += 1
        for n, line in enumerate(data.decode("utf-8", "replace").splitlines(), 1):
            for kind, rx in PATTERNS.items():
                for m in rx.finditer(line):
                    if kind in FAKE_MARKER_KINDS and "FAKE" in m.group(0):
                        continue
                    hits.append(f"{path}:{n}: {kind}")

    if problems or hits:
        print("Possible personal data in tracked files (the matches are not printed):\n  " + "\n  ".join(problems + hits))
        print(
            "\nIf it's real, take it out: real data stays in the terminal. If it's invented,"
            "\nput FAKE in the id, or allowlist the file in " + ALLOWLIST + " with a reason."
        )
        sys.exit(1)
    print(f"{scanned} tracked text file(s) checked, {len(allowed)} allowlisted: no personal-data patterns.")


if __name__ == "__main__":
    main()
