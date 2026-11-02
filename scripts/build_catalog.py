#!/usr/bin/env python3

# Copyright (c) 2026 Eclipse Foundation
"""
Build the runtime catalogue aggregate `cfg/catalog.json` from the per-file
JSON sources of truth:

  - `ips/<id>.json`      — one JSON object per independent IP
  - `projects/<proj>.json` — one JSON object per project, holding its Tasks
  - `cfg/projects.json`  — the project registry (id / name / logo / url)

The static site (GitHub Pages or any plain web host) runs **no build**: it
serves the committed `cfg/catalog.json`, so this script must be run before
publishing and its output committed back (CI does both on a schedule and on
demand).

Usage:
  python3 scripts/build_catalog.py                 # write cfg/catalog.json
  python3 scripts/build_catalog.py --check          # fail if stale / refs broken
  python3 scripts/build_catalog.py --out /tmp/cat.json
  python3 scripts/build_catalog.py --ips-dir ... --projects-dir ...

Checks performed (also in --check mode, which additionally compares against
the committed aggregate):
  - every `Task.IPs[]` id has a matching `ips/<id>.json` whose `Id` matches;
  - every `Task.Partners[]` and every `IP.Owners[]` resolves in
    `cfg/partners.json` (by name or alias);
  - every project file's `Id` exists in `cfg/projects.json`.

Output is deterministically ordered (sorted keys, sorted entries) so that
regenerating only changes the diff when the source data actually changed.
Standard library only.
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from uap_common import (  # noqa: E402
    iter_json_files,
    load_json,
    partner_lookup,
    to_list,
)

ROOT = Path(__file__).resolve().parents[1]


def utc_now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_sources(ips_dir, projects_dir, projects_json_path, partners_path):
    """Assemble the `ips` and `projects` maps of the aggregate, plus a list
    of referential-integrity errors found along the way."""
    errors = []
    resolve_partner = partner_lookup(load_json(partners_path))
    projects_registry = {p["id"]: p for p in load_json(projects_json_path)}

    # --- IPs -------------------------------------------------------------
    ip_docs = {}
    for path in iter_json_files(ips_dir):
        doc = load_json(path)
        if not isinstance(doc, dict):
            errors.append(f"{path.name}: expected a single JSON object")
            continue
        ip_id = doc.get("Id")
        if ip_id != path.stem:
            errors.append(f"{path.name}: Id {ip_id!r} does not match file stem {path.stem!r}")
            continue
        if ip_id in ip_docs:
            errors.append(f"{path.name}: duplicate IP id {ip_id!r}")
            continue
        for owner in to_list(doc.get("Owners")):
            if not resolve_partner(owner):
                errors.append(f"{path.name}: Owner {owner!r} not in cfg/partners.json")
        ip_docs[ip_id] = doc

    # --- Projects ---------------------------------------------------------
    project_docs = {}
    for path in iter_json_files(projects_dir):
        doc = load_json(path)
        if not isinstance(doc, dict):
            errors.append(f"{path.name}: expected a single JSON object")
            continue
        proj_id = doc.get("Id")
        if proj_id != path.stem:
            errors.append(f"{path.name}: Id {proj_id!r} does not match file stem {path.stem!r}")
            continue
        if proj_id not in projects_registry:
            errors.append(f"{path.name}: project id {proj_id!r} not in cfg/projects.json")
        seen_task_ids = set()
        for task in doc.get("Tasks", []):
            task_id = task.get("TaskId")
            if task_id in seen_task_ids:
                errors.append(f"{path.name}: duplicate TaskId {task_id!r}")
            seen_task_ids.add(task_id)
            for ip_ref in to_list(task.get("IPs")):
                if ip_ref not in ip_docs:
                    errors.append(
                        f"{path.name} task {task_id}: IP {ip_ref!r} has no ips/{ip_ref}.json"
                    )
            partners = to_list(task.get("Partners"))
            if not partners:
                errors.append(f"{path.name} task {task_id}: no Partners")
            for partner in partners:
                if not resolve_partner(partner):
                    errors.append(
                        f"{path.name} task {task_id}: Partner {partner!r} "
                        "not in cfg/partners.json"
                    )
        project_docs[proj_id] = doc

    return ip_docs, project_docs, errors


def build_payload(ips_dir, projects_dir, projects_json_path, partners_path, generated_at):
    ip_docs, project_docs, errors = build_sources(
        ips_dir, projects_dir, projects_json_path, partners_path
    )
    if errors:
        return None, errors
    # Deterministic ordering: sorted by id; json.dumps(sort_keys=True) keeps
    # the field order stable within each document.
    payload = {
        "generated_at": generated_at,
        "source": "generated by scripts/build_catalog.py from ips/ + projects/",
        "ips": {ip_id: ip_docs[ip_id] for ip_id in sorted(ip_docs)},
        "projects": {
            proj_id: project_docs[proj_id] for proj_id in sorted(project_docs)
        },
    }
    return payload, []


def serialise(payload):
    return json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1].strip())
    parser.add_argument("--out", default=str(ROOT / "cfg" / "catalog.json"))
    parser.add_argument("--ips-dir", default=str(ROOT / "ips"))
    parser.add_argument("--projects-dir", default=str(ROOT / "projects"))
    parser.add_argument("--projects-json", default=str(ROOT / "cfg" / "projects.json"))
    parser.add_argument("--partners-json", default=str(ROOT / "cfg" / "partners.json"))
    parser.add_argument(
        "--check",
        action="store_true",
        help="Do not write; exit 1 when the aggregate is missing, stale, or "
        "any cross-reference is broken.",
    )
    args = parser.parse_args()

    out_path = Path(args.out)
    payload, errors = build_payload(
        args.ips_dir,
        args.projects_dir,
        args.projects_json,
        args.partners_json,
        generated_at=utc_now_iso(),
    )
    if errors:
        print(f"{len(errors)} referential error(s):")
        for err in errors:
            print(f"  - {err}")
        return 1

    if args.check:
        if not out_path.exists():
            print(f"{out_path} is missing — run: python3 scripts/build_catalog.py")
            return 1
        # Compare structurally, ignoring the generated_at timestamp.
        try:
            existing = load_json(out_path)
        except (OSError, json.JSONDecodeError) as exc:
            print(f"{out_path} cannot be read: {exc}")
            return 1
        fresh = dict(payload)
        current = {k: v for k, v in existing.items() if k != "generated_at"}
        fresh_cmp = {k: v for k, v in fresh.items() if k != "generated_at"}
        if serialise(current) != serialise(fresh_cmp):
            print(f"{out_path} is STALE relative to ips/ + projects/.")
            print("Regenerate with: python3 scripts/build_catalog.py")
            return 1
        print(f"{out_path} is up to date and all cross-references resolve.")
        return 0

    # Keep the previous timestamp when nothing else changed, so re-running
    # never produces a spurious git diff.
    if out_path.exists():
        try:
            existing = load_json(out_path)
            if serialise(
                {k: v for k, v in existing.items() if k != "generated_at"}
            ) == serialise(
                {k: v for k, v in payload.items() if k != "generated_at"}
            ):
                payload["generated_at"] = existing.get("generated_at", payload["generated_at"])
        except (OSError, json.JSONDecodeError):
            pass

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(serialise(payload))
    print(
        f"Wrote {out_path}: {len(payload['ips'])} IPs, "
        f"{len(payload['projects'])} projects "
        f"({sum(len(p['Tasks']) for p in payload['projects'].values())} tasks)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())