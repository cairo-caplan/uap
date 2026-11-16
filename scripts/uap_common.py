#!/usr/bin/env python3

# Copyright (c) 2026 Eclipse Foundation
"""Shared helpers for the UAP scripts (validation, catalogue build, stats).

Used by every printing script — scripts/validate_ips.py,
scripts/build_catalog.py, scripts/fetch_repo_stats.py and
scripts/upstream_audit.py. Standard library only.
"""

import io
import json
import sys
from pathlib import Path


def harden_console():
    """Make sys.stdout/sys.stderr survive a non-UTF-8 locale.

    2026-11-14: a `py: fetch repo stats` run died on the ellipsis of its
    "fetching ..." progress line because the shell's console encoding was
    ASCII — and interpolated provider text can carry any codepoint, so the
    stream must be fixed, not the call site. Everything is written as UTF-8
    (errors="replace" covers lone surrogates), so printing can no longer
    raise. Call once, right after the imports, in every script that prints
    data. Streams without a `.buffer` (test captures, redirected objects)
    are left alone, and a stream that refuses to be detached keeps its old
    behaviour — this must never crash the script at import time.
    """
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name)
        if not hasattr(stream, "buffer"):
            continue
        try:
            # detach() first: the discarded wrapper must not flush its
            # (empty) buffer behind the new wrapper's writes.
            buffer = stream.detach()
            setattr(sys, name, io.TextIOWrapper(
                buffer, encoding="utf-8", errors="replace",
                line_buffering=True))
        except (AttributeError, ValueError, OSError):
            continue


def load_json(path):
    """Load a JSON file; raises on missing/invalid input."""
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def iter_json_files(directory):
    """Sorted list of *.json files in a directory (missing dir -> [])."""
    directory = Path(directory)
    if not directory.is_dir():
        return []
    return sorted(p for p in directory.glob("*.json") if p.is_file())


def partner_lookup(partners_registry):
    """Build a case-insensitive map from every organisation name/alias to
    its registry entry, plus a set of all known lowercase names/aliases.

    Returns a function ``resolve(value) -> entry | None`` accepting an
    organisation name or alias (case-insensitively, surrounding whitespace
    ignored).
    """
    index = {}
    for entry in partners_registry:
        keys = {entry.get("name", "")}
        keys.update(entry.get("aliases") or [])
        for key in keys:
            key = key.strip().lower()
            if key:
                index.setdefault(key, entry)

    def resolve(value):
        if not isinstance(value, str):
            return None
        return index.get(value.strip().lower())

    return resolve


def org_exists(resolve, value):
    """True when an organisation name/alias resolves in partners.json."""
    return resolve(value) is not None


def to_list(value):
    """Normalise a field that may be a string, a list, or empty."""
    if value is None or value == "":
        return []
    if isinstance(value, list):
        return value
    return [value]


def flatten_task_fields(project_doc):
    """Yield ``(task_ref, doc)`` pairs of a project document's tasks."""
    for task in project_doc.get("Tasks", []):
        yield task, project_doc