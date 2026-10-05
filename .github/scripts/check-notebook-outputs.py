#!/usr/bin/env python3
"""Fail if any tracked notebook carries saved outputs.

A notebook's outputs are whatever the cells printed when it was last run. In
this repo that means query results from a real database: transaction
descriptions, amounts, dates. The repo is public, so notebooks are committed
with every output cleared. Clear them before committing, e.g.:

    jupyter nbconvert --clear-output --inplace analytics/Notebook.ipynb

Prints paths and cell numbers only, never the outputs themselves.
"""
import json
import subprocess
import sys

paths = subprocess.run(
    ["git", "ls-files", "*.ipynb"], capture_output=True, text=True, check=True
).stdout.split()

bad = []
for path in paths:
    with open(path, encoding="utf-8") as f:
        nb = json.load(f)
    for i, cell in enumerate(nb.get("cells", [])):
        if cell.get("outputs"):
            bad.append(f"{path}: cell {i} has saved outputs")
        if cell.get("execution_count") is not None:
            bad.append(f"{path}: cell {i} has an execution count (it was run and saved)")

if bad:
    print("Notebooks must be committed with outputs cleared:\n  " + "\n  ".join(bad))
    print("\nClear them with: jupyter nbconvert --clear-output --inplace <notebook>")
    sys.exit(1)
print(f"{len(paths)} notebook(s) checked: no saved outputs.")
