#!/usr/bin/env python3

# Copyright (c) 2026 Eclipse Foundation
"""
Audit upstream UAP data (the old per-project IP arrays) against this branch's
IP-centric layout (`ips/<id>.json` + `projects/<project>.json`).

Upstream (`github.com/openhwfoundation/uap`, branch `main`) still stores one
**array per project** in `ips/<project>.json`, each row mixing IP fields with
work-item fields. This branch splits every such row into an independent IP
document plus a Task, so upstream data commits cannot simply be merged — each
one has to be *translated*. This script enumerates what that translation still
owes, and (with `--base-ref` equal to `--upstream-ref`) proves that a finished
port did not silently drop an upstream row.

Usage:
  python3 scripts/upstream_audit.py                                   # coverage only — no delta
  python3 scripts/upstream_audit.py --base-ref 74625780 --out docs/upstream-audit.md
  python3 scripts/upstream_audit.py --upstream-ref 74625780 --base-ref 74625780   # port regression check
  python3 scripts/upstream_audit.py --upstream-dir /tmp/upstream --fail-on-missing

Upstream arrays are read with `git show <ref>:ips/<project>.json`, so nothing
is fetched, checked out or stashed; `--upstream-dir <path>` audits a directory
(`ips/*.json`, or the files directly) instead — e.g. an unpacked tarball.

`--base-ref` defaults to `--upstream-ref`. The delta buckets (`NEW-UPSTREAM`,
`CHANGED`, `REMOVED`, `UPSTREAM-COMMENT`) compare upstream against that base, so
with the default there is no delta left to report and `--fail-on-changed` can
never fire — always pass `--base-ref <last-synced>` when auditing a sync. With
`--upstream-dir` there is no history at all, so `--base-ref` is ignored.

Findings per project:
  MISSING        upstream row with no Task here
  NEW-UPSTREAM   upstream row that appeared after `--base-ref`
  CHANGED        upstream changed a value since `--base-ref` and no place here
                 carries it — this is the porting to-do list
  PARTIAL        one place carries the upstream value but a sibling does not,
                 i.e. a change that was only half translated
  REMOVED        upstream row deleted after `--base-ref`
  UPSTREAM-COMMENT  upstream rewrote a `Comment` since `--base-ref`; the
                 migration rewrote comments on purpose, so this is a heads-up
  FIELD-DIFF     value differs from upstream but upstream did not change it
                 recently — an accepted migration divergence, review only
  BRANCH-ONLY    Task here with no upstream counterpart

Every CHANGED / PARTIAL / FIELD-DIFF line states where the value belongs here:
`ips/<id>.json#Field` for IP-level fields, `projects/<p>.json#<TaskId>.Field`
for work-item fields. A changed IP `Status` additionally lists the Tasks on
that IP still holding the old value, because a Task's `Status` follows the
`Status` of the IP it reports on.

Values are compared after canonicalisation (category and partner aliases
resolved through `cfg/`, the `openhwgroup` → `openhwfoundation` rename, branch
URL suffixes, zero-width junk, a trailing period), so a diff means the content
really differs — the report always prints the raw values.

Output is deterministic (no timestamps) so re-running only produces a diff when
the data changed. Standard library only.
"""

import argparse
import io
import json
import re
import subprocess
import sys
from pathlib import Path

# Task shells may run with an ASCII locale; the report contains Unicode
# (en-dashes, checkmarks), so never crash while printing it.
if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(
        sys.stdout.buffer, encoding="utf-8", errors="replace", line_buffering=True
    )
    sys.stderr = io.TextIOWrapper(
        sys.stderr.buffer, encoding="utf-8", errors="replace", line_buffering=True
    )

sys.path.insert(0, str(Path(__file__).resolve().parent))

from uap_common import load_json, to_list  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]

DEFAULT_PROJECTS = ["tristan", "isolde", "rebecca", "rigoletto", "scale4edge"]

# Upstream row fields describing the IP itself → the same field name in
# `ips/<id>.json`. `Name` is deliberately absent: the row name is the *task*
# title, while an IP document names the IP (one document routinely covers
# several work items), so the two differing is the design, not a divergence.
# `DefaultBranch` has no upstream counterpart either.
IP_FIELDS = [
    "URL",
    "License",
    "Status",
    "Category",
    "Description",
    "IP_CARD_URL",
    "IP_CARD_PDF_URL",
]

# Upstream row fields describing the work item → the Task field holding them.
TASK_FIELDS = {
    "Name": "Title",
    "WI": "WI",
    "Partners": "Partners",
    "Status": "Status",
    "Description": "Description",
    "Comment": "Comment",
}

# The migration rewrote `Comment` on purpose (provenance, PROVISIONAL markers),
# so a differing Comment only reaches the report when upstream changed it.
INFORMATIONAL_FIELDS = {"Comment"}

# Fields whose items are registry references (compared through the registry).
REGISTRY_FIELDS = {"Category": "category", "Partners": "partner", "Owners": "partner"}

PLACEHOLDER_VALUES = {"", "tbd", "n/a", "none"}

# Upstream work-item ids look like "ID 3.3.02" / "WI2.2.5" / "T2.3".
WI_PREFIX = re.compile(r"^(ID|WI|WP|T)[\s.]*", re.IGNORECASE)

# Zero-width and no-break junk that upstream descriptions accumulate.
INVISIBLE = re.compile(u"[\u200b\u200c\u200d\u200e\u200f\ufeff\u00a0]")

# Repository-browser noise: `/tree/<branch>` / `/-/blob/<branch>` suffixes,
# `?ref_type=heads` style queries, trailing slashes.
URL_TREE = re.compile(r"/(?:-/)?(?:tree|blob|src)/.*$", re.IGNORECASE)
URL_QUERY = re.compile(r"[?#].*$")


# --------------------------------------------------------------------------
# canonicalisation helpers
# --------------------------------------------------------------------------


class Canonicaliser(object):
    """Canonical forms of field values, using the `cfg/` registries.

    Comparison only: the report always shows the raw values. Unknown values
    fall back to their normalised text, so a genuinely unknown category still
    compares equal to itself and unequal to everything else.
    """

    def __init__(self, categories_path=None, partners_path=None):
        self.category = {}
        self.partner = {}
        if categories_path and Path(categories_path).is_file():
            for entry in load_json(categories_path):
                name = entry.get("name", "")
                keys = {name}
                keys.update(entry.get("aliases") or [])
                for key in keys:
                    self.category.setdefault(norm_text(key), norm_text(name))
        if partners_path and Path(partners_path).is_file():
            for entry in load_json(partners_path):
                name = entry.get("name", "")
                keys = {name}
                keys.update(entry.get("aliases") or [])
                for key in keys:
                    self.partner.setdefault(norm_text(key), norm_text(name))

    def value(self, field, raw):
        kind = REGISTRY_FIELDS.get(field)
        items = to_list(raw)
        if not items:
            return ()
        out = []
        for item in items:
            text = norm_text(item)
            if kind == "category":
                text = self.category.get(text, text)
            elif kind == "partner":
                text = self.partner.get(text, text)
            elif field in ("URL", "IP_CARD_URL", "IP_CARD_PDF_URL"):
                text = norm_url(text)
            else:
                text = norm_text(text)
            out.append(text)
        return tuple(sorted(out))


def norm_text(value):
    """Case-folded, whitespace-collapsed form of a scalar value."""
    if value is None:
        return ""
    text = INVISIBLE.sub(" ", str(value))
    return re.sub(r"\s+", " ", text).strip().rstrip(".")


def norm_url(value):
    """Repository identity of a URL, ignoring org renames and browser paths."""
    text = norm_text(value).rstrip("/")
    if not text:
        return ""
    text = URL_QUERY.sub("", text)
    text = URL_TREE.sub("", text)
    text = text.replace("github.com/openhwgroup/", "github.com/openhwfoundation/")
    return text.rstrip("/")


def is_placeholder(value):
    """True for the empty / TBD values the migration used for unknown data."""
    items = to_list(value)
    if not items:
        return True
    return all(
        norm_text(item) in PLACEHOLDER_VALUES or norm_text(item).startswith("tbd (")
        for item in items
    )


def norm_wi(value):
    """Sorted tuple of normalised work-item identifiers.

    `ID 3.3.02`, `WI3.3.02` and `T3.3.02` all collapse to `3.3.02`, so the two
    layouts agree on an identifier; `TBD` and empty values carry none.
    """
    out = []
    for item in to_list(value):
        text = re.sub(r"\s+", "", str(item)).upper()
        if not text or text == "TBD":
            continue
        out.append(WI_PREFIX.sub("", text))
    return tuple(sorted(out))


def esc(text):
    return str(text).replace("|", "\\|").replace("\n", " ")


def show(value):
    """Render a field value compactly for the report."""
    if isinstance(value, list) and value and all(not isinstance(v, list) for v in value):
        parts = [show(v) for v in value]
        if all(part == "*(absent)*" for part in parts):
            return "*(absent)*"
        return " ⋅ ".join(part for part in parts if part) or "*(absent)*"
    if value is None:
        return "*(absent)*"
    items = to_list(value)
    if not items:
        return "*(empty)*"
    return esc(", ".join(str(item) for item in items))


# --------------------------------------------------------------------------
# loading
# --------------------------------------------------------------------------


def git_show(ref, path):
    """`git show <ref>:<path>` as text; None when the ref or file is unknown."""
    try:
        out = subprocess.check_output(
            ["git", "-C", str(ROOT), "show", "{}:{}".format(ref, path)],
            stderr=subprocess.DEVNULL,
        )
    except (subprocess.CalledProcessError, OSError):
        return None
    return out.decode("utf-8")


def load_upstream_rows(project, ref, directory):
    """Upstream array of one project, or None when absent."""
    if directory:
        base = Path(directory)
        for candidate in (base / "ips" / (project + ".json"), base / (project + ".json")):
            if candidate.is_file():
                return json.loads(candidate.read_text(encoding="utf-8"))
        return None
    text = git_show(ref, "ips/{}.json".format(project))
    return None if text is None else json.loads(text)


def load_branch(catalog_path):
    """`(ip docs by id, tasks by project)` from the runtime aggregate."""
    catalog = load_json(catalog_path)
    tasks_by_project = {}
    for project_id, doc in catalog.get("projects", {}).items():
        for task in doc.get("Tasks", []):
            task["_project"] = project_id
        tasks_by_project[project_id] = doc.get("Tasks", [])
    return catalog.get("ips", {}), tasks_by_project


# --------------------------------------------------------------------------
# matching upstream rows to Tasks
# --------------------------------------------------------------------------


def row_identity(row):
    """Stable identity of an upstream row, for base-vs-current diffs."""
    return (norm_text(row.get("Name")), norm_wi(row.get("WI")))


def match_project(rows, tasks):
    """Pair upstream rows with Tasks of this branch.

    Deterministic and greedy in upstream order: an exact title match wins,
    otherwise a *unique* work-item match; a Task is never used twice. Returns
    `(pairs, matched_task_ids)` with `pairs` = `(row, task | None)`.
    """
    by_name = {}
    by_wi = {}
    for task in tasks:
        by_name.setdefault(norm_text(task.get("Title")), []).append(task)
        wi = norm_wi(task.get("WI"))
        if wi:
            by_wi.setdefault(wi, []).append(task)

    consumed = set()
    pairs = []
    for row in rows:
        task = None
        for candidate in by_name.get(norm_text(row.get("Name")), []):
            if id(candidate) not in consumed:
                task = candidate
                break
        if task is None:
            candidates = [
                candidate
                for candidate in by_wi.get(norm_wi(row.get("WI")), [])
                if id(candidate) not in consumed
            ]
            if len(candidates) == 1:
                task = candidates[0]
        if task is not None:
            consumed.add(id(task))
        pairs.append((row, task))
    return pairs, consumed


def find_ip_docs(task, ip_docs):
    """IP documents a Task references, in `Task.IPs` order."""
    return [ip_docs[ip_id] for ip_id in to_list(task.get("IPs")) if ip_id in ip_docs]


def wi_in_text(token, text):
    """Is the work-item `token` present in `text` as a whole identifier?"""
    if not token:
        return False
    return bool(
        re.search(r"(?<![\d.]){}(?![\d.])".format(re.escape(token)), text)
    )


def doc_mirrors_row(row, doc, canon):
    """Does this IP document carry the identity of this upstream row?

    One IP document is often shared by several work items, and its `Name`,
    `Description` or `Category` then belong to the IP rather than to any single
    row. A document only inherits a row's IP-level values when it mirrors it:
    by name, by repository URL, or by the `WI` provenance the migration wrote
    into `Comment` (`"ISOLDE WIs ID 3.3.02 (hardware) and ID 4.3.02 …"`).
    """
    if canon.value("Name", doc.get("Name")) and (
        canon.value("Name", doc.get("Name")) == canon.value("Name", row.get("Name"))
    ):
        return True
    if canon.value("URL", doc.get("URL")) and (
        canon.value("URL", doc.get("URL")) == canon.value("URL", row.get("URL"))
    ):
        return True
    comment = norm_text(doc.get("Comment"))
    return any(wi_in_text(token.lower(), comment) for token in norm_wi(row.get("WI")))


# --------------------------------------------------------------------------
# field comparison
# --------------------------------------------------------------------------


def compare_field(field, row, task, docs, row_base, canon):
    """Diff one upstream field against this branch; None when in agreement.

    Places a value belongs in: the mirroring IP documents of an IP-level field
    (`doc_mirrors_row`) and the Task of a work-item field. Agreement means some
    place already carries the upstream value; a *second, recorded* place saying
    something else is a partial port. A place that records nothing is not a
    contradiction — `Status` and `Description` are optional on a Task — but a
    value recorded nowhere upstream-visible still shows up as CHANGED.
    """
    upstream = row.get(field)
    wanted = canon.value(field, upstream)

    is_ip_field = field in IP_FIELDS
    task_field = TASK_FIELDS.get(field)
    if not is_ip_field and not task_field:
        return None

    ip_places = []
    if is_ip_field:
        mirrors = [doc for doc in docs if doc_mirrors_row(row, doc, canon)]
        if len(docs) > 1 and len(mirrors) > 1:
            return None  # several mirrored documents: nothing to decide here
        for doc in mirrors:
            value = doc.get(field)
            ip_places.append(
                {
                    "kind": "ip",
                    "target": "ips/{}.json#{}".format(doc.get("Id", "?"), field),
                    "value": value,
                    "matches": canon.value(field, value) == wanted,
                    "blank": value is None or is_placeholder(value),
                }
            )
        if not ip_places:
            return None

    task_places = []
    if task_field:
        value = task.get(task_field)
        task_places.append(
            {
                "kind": "task",
                "target": "projects/{}.json#{}.{}".format(
                    task.get("_project", "?"), task.get("TaskId", "?"), task_field
                ),
                "value": value,
                "matches": canon.value(field, value) == wanted,
                "blank": value is None or is_placeholder(value),
            }
        )

    places = ip_places + task_places
    if not places:
        return None
    matching = [place for place in places if place["matches"]]
    recorded = [place for place in places if not place["blank"]]
    if matching:
        # In agreement somewhere; only a mirroring IP document still saying
        # something else is a finding. An empty sibling is a field this branch
        # left out, and a Task value chosen freely (its own Status wording, its
        # own Description) is a work-item decision, not a translation error —
        # the audit compares upstream → branch, not Task ↔ IP.
        conflicting = [
            place
            for place in recorded
            if not place["matches"] and place["kind"] == "ip"
        ]
        if not conflicting:
            return None
        places = matching + conflicting
    elif not recorded:
        return None
    # Nothing recorded upstream and nothing recorded here → nothing to port.
    if is_placeholder(upstream) and not recorded:
        return None

    upstream_base = row_base.get(field) if row_base else None
    return {
        "field": field,
        "upstream": upstream,
        "upstream_base": upstream_base,
        "places": places,
        "partial": bool(matching),
        "changed_upstream": row_base is not None
        and canon.value(field, upstream) != canon.value(field, upstream_base),
        "ip_ids": set(doc.get("Id") for doc in docs),
        "mirrors": [],
    }


def status_mirrors(old_value, ip_ids, tasks_by_project, canon):
    """Tasks on the IPs `ip_ids` whose `Status` still equals `old_value`.

    A Task's `Status` follows the `Status` of the IP it reports on, so an IP
    status change lists the Tasks that carried the previous value. Tasks on
    other IPs that happen to share the wording (`"Prototype"` is common) are
    not theirs to change and stay out of the list.
    """
    wanted = canon.value("Status", old_value)
    if not wanted or wanted == ("",) or not ip_ids:
        return []
    hits = []
    for project_id in sorted(tasks_by_project):
        for task in tasks_by_project[project_id]:
            if not set(to_list(task.get("IPs"))) & ip_ids:
                continue
            status = task.get("Status")
            if canon.value("Status", status) == wanted and not is_placeholder(status):
                hits.append("projects/{}.json#{}".format(project_id, task.get("TaskId")))
    return hits


# --------------------------------------------------------------------------
# audit
# --------------------------------------------------------------------------


def row_label(row):
    wi = ", ".join(to_list(row.get("WI"))) or "no WI"
    return "**{}** (`{}`)".format(esc(row.get("Name", "")), esc(wi))


def audit_project(project, rows, rows_base, tasks, ip_docs, tasks_by_project, canon):
    """Collect every finding for one project file."""
    result = {
        "project": project,
        "rows": len(rows),
        "missing": [],
        "new": [],
        "removed": [],
        "changed": [],
        "partial": [],
        "comment": [],
        "diff": [],
        "branch_only": [],
        }

    pairs, matched = match_project(rows, tasks)
    base_by_identity = {}
    for row in rows_base:
        base_by_identity.setdefault(row_identity(row), row)
    current_identities = {row_identity(row) for row in rows}

    for row, task in pairs:
        identity = row_identity(row)
        row_base = base_by_identity.get(identity)
        if task is None:
            if identity in base_by_identity:
                result["missing"].append(
                    (
                        row_label(row),
                        "no Task here, although the row already existed at the base ref — "
                        "a past port dropped it",
                    )
                )
            else:
                result["new"].append(
                    (
                        row_label(row),
                        "upstream row absent at the base ref — add a Task in "
                        "projects/{}.json and, for a new IP, ips/<id>.json; keep Owners and "
                        "Partners resolvable in cfg/partners.json".format(project),
                    )
                )
            continue
        docs = find_ip_docs(task, ip_docs)
        for field in IP_FIELDS + [name for name in TASK_FIELDS if name not in IP_FIELDS]:
            diff = compare_field(field, row, task, docs, row_base, canon)
            if diff is None:
                continue
            diff["row"] = row_label(row)
            if diff["field"] == "Status" and diff["changed_upstream"]:
                diff["mirrors"] = status_mirrors(
                    diff["upstream_base"], diff["ip_ids"], tasks_by_project, canon
                )
            if diff["field"] in INFORMATIONAL_FIELDS:
                # The migration rewrote comments on purpose: an upstream
                # rewrite is a heads-up, never a porting task.
                if diff["changed_upstream"]:
                    result["comment"].append(diff)
                continue
            if diff["changed_upstream"]:
                result["changed"].append(diff)
            elif diff["partial"]:
                result["partial"].append(diff)
            else:
                result["diff"].append(diff)

    for row in rows_base:
        if row_identity(row) not in current_identities:
            result["removed"].append(
                (
                    row_label(row),
                    "upstream deleted this row after the base ref — check whether the Task "
                    "here should go too (upstream also folds duplicates into one row)",
                )
            )

    for task in tasks:
        if id(task) not in matched:
            result["branch_only"].append(
                (
                    "`{}` — {}".format(task.get("TaskId"), esc(task.get("Title", ""))),
                    "no upstream row matches this Task; expected for migration splits, "
                    "renames and local additions",
                )
            )
    return result


# --------------------------------------------------------------------------
# report
# --------------------------------------------------------------------------


def diff_line(diff):
    if diff["changed_upstream"]:
        value = "{} → **{}**".format(show(diff["upstream_base"]), show(diff["upstream"]))
    else:
        value = "**{}** upstream".format(show(diff["upstream"]))
    suffix = " *(partially applied)*" if diff["partial"] else ""
    lines = ["- {} `{}` — {}{}".format(diff["row"], diff["field"], value, suffix)]
    for place in diff["places"]:
        if place["matches"]:
            continue
        lines.append("  - {}: {}".format(place["target"], show(place["value"])))
    if diff["mirrors"]:
        lines.append(
            "  - a Task `Status` follows the IP `Status`: also update {}".format(
                "; ".join(diff["mirrors"])
            )
        )
    return "\n".join(lines)


def pair_line(item):
    return "- {}\n  - {}".format(item[0], item[1])


def render(results, projects, extra):
    out = []
    add = out.append
    add("# Upstream audit: `openhwfoundation/uap` → IP-centric branch")
    add("")
    add("Generated by `scripts/upstream_audit.py`; regenerate it after every")
    add("upstream sync (routine: `docs/upstream-sync.md`). This report is the")
    add("porting to-do list for translating upstream's per-project IP arrays")
    add("into `ips/<id>.json` + `projects/<project>.json`.")
    add("")
    add("- upstream data: {}".format(extra["upstream_source"]))
    add("- comparison base: {}".format(extra["base_source"]))
    add("- this branch: `{}`".format(extra["catalog"]))
    add("- projects audited: {}".format(", ".join("`{}`".format(p) for p in projects)))
    add("")
    add("Upstream rows are matched to Tasks by title first, then by a unique")
    add("work-item identifier. Values are compared after canonicalising the")
    add("`cfg/` registries, the `openhwgroup` → `openhwfoundation` rename,")
    add("branch URL suffixes and invisible characters; raw values are printed.")
    add("")
    add("**CHANGED** is what a sync still owes: upstream moved a value since the")
    add("base ref and nothing here carries it. **PARTIAL** is a field whose two")
    add("homes disagree — usually the IP document describing the IP while the")
    add("Task describes the work item. **FIELD-DIFF** is an accepted migration")
    add("divergence. Neither is a work order on its own: review, never")
    add("blind-apply.")
    add("")
    add("## Totals")
    add("")
    add(
        "| Project | Upstream rows | Missing | New | Changed | Partial | Removed | Comment edits | Field diffs | Branch-only |"
    )
    add("|---|---|---|---|---|---|---|---|---|---|")
    for res in results:
        add(
            "| `{}` | {} | {} | {} | {} | {} | {} | {} | {} | {} |".format(
                res["project"],
                res["rows"],
                len(res["missing"]),
                len(res["new"]),
                len(res["changed"]),
                len(res["partial"]),
                len(res["removed"]),
                len(res["comment"]),
                len(res["diff"]),
                len(res["branch_only"]),
            )
        )
    add("")
    add(
        "**Totals:** {} upstream rows — {} missing, {} new, {} changed and unported, "
        "{} only half translated, {} removed upstream, {} upstream comment edits, "
        "{} field diffs accepted on purpose, {} branch-only Tasks.".format(
            sum(r["rows"] for r in results),
            sum(len(r["missing"]) for r in results),
            sum(len(r["new"]) for r in results),
            sum(len(r["changed"]) for r in results),
            sum(len(r["partial"]) for r in results),
            sum(len(r["removed"]) for r in results),
            sum(len(r["comment"]) for r in results),
            sum(len(r["diff"]) for r in results),
            sum(len(r["branch_only"]) for r in results),
        )
    )
    add("")

    sections = [
        ("MISSING — upstream rows not represented here", "missing", pair_line),
        ("NEW-UPSTREAM — rows added since the base ref", "new", pair_line),
        (
            "CHANGED — upstream changed the value and this branch has not followed",
            "changed",
            diff_line,
        ),
        (
            "PARTIAL — one place carries the upstream value, its sibling does not",
            "partial",
            diff_line,
        ),
        ("REMOVED — rows upstream deleted since the base ref", "removed", pair_line),
        (
            "UPSTREAM-COMMENT — upstream rewrote a comment since the base ref",
            "comment",
            diff_line,
        ),
        ("FIELD-DIFF — accepted migration divergences", "diff", diff_line),
        ("BRANCH-ONLY — Tasks with no upstream counterpart", "branch_only", pair_line),
    ]
    for title, key, renderer in sections:
        if not any(res[key] for res in results):
            add("## {} — none".format(title))
            add("")
            continue
        add("## {}".format(title))
        add("")
        for res in results:
            if not res[key]:
                continue
            add(
                "### {} (`projects/{}.json`, {})".format(
                    res["project"].upper(), res["project"], len(res[key])
                )
            )
            add("")
            for item in res[key]:
                add(renderer(item))
            add("")
        add("")

    return "\n".join(out).rstrip() + "\n"


def print_summary(results):
    print("project       rows  missing    new  changed  partial  removed  comments   diffs  branch-only")
    for res in results:
        print(
            "{:<13} {:>4}  {:>7}  {:>3}  {:>7}  {:>7}  {:>7}  {:>8}  {:>6}  {:>11}".format(
                res["project"],
                res["rows"],
                len(res["missing"]),
                len(res["new"]),
                len(res["changed"]),
                len(res["partial"]),
                len(res["removed"]),
                len(res["comment"]),
                len(res["diff"]),
                len(res["branch_only"]),
            )
        )


# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(
        description="Audit upstream UAP data against the IP-centric layout."
    )
    parser.add_argument(
        "--upstream-ref",
        default="upstream/main",
        help="git ref holding the upstream per-project arrays (default: upstream/main).",
    )
    parser.add_argument(
        "--upstream-dir",
        help="read the upstream arrays from a directory instead of a git ref.",
    )
    parser.add_argument(
        "--projects",
        default=",".join(DEFAULT_PROJECTS),
        help="comma-separated project files to audit (default: all).",
    )
    parser.add_argument(
        "--catalog",
        default=str(ROOT / "cfg" / "catalog.json"),
        help="runtime aggregate describing this branch (default: cfg/catalog.json).",
    )
    parser.add_argument(
        "--categories",
        default=str(ROOT / "cfg" / "categories.json"),
        help="category registry used to resolve aliases when comparing.",
    )
    parser.add_argument(
        "--partners",
        default=str(ROOT / "cfg" / "partners.json"),
        help="partner registry used to resolve aliases when comparing.",
    )
    parser.add_argument(
        "--base-ref",
        help="earlier upstream ref to diff against; defaults to --upstream-ref, "
        "which audits that ref's port for lost rows.",
    )
    parser.add_argument("--out", help="write the markdown report to this path.")
    parser.add_argument(
        "--fail-on-missing",
        action="store_true",
        help="exit 1 when an upstream row is MISSING or NEW-UPSTREAM.",
    )
    parser.add_argument(
        "--fail-on-changed",
        action="store_true",
        help="exit 1 when a CHANGED upstream value is still unported.",
    )
    args = parser.parse_args()

    projects = [p.strip() for p in args.projects.split(",") if p.strip()]
    base_ref = args.base_ref or args.upstream_ref

    canon = Canonicaliser(args.categories, args.partners)
    ip_docs, tasks_by_project = load_branch(args.catalog)

    results = []
    for project in projects:
        rows = load_upstream_rows(project, args.upstream_ref, args.upstream_dir)
        if rows is None:
            print(
                "{}: no upstream ips/{}.json at {} — skipped".format(
                    project,
                    project,
                    args.upstream_dir or args.upstream_ref,
                )
            )
            continue
        rows_base = []
        if args.upstream_dir:
            if args.base_ref:
                print("warning: --base-ref is ignored with --upstream-dir")
        else:
            base_rows = load_upstream_rows(project, base_ref, None)
            rows_base = base_rows if base_rows is not None else []
        if not tasks_by_project.get(project):
            print(
                "{}: no projects/{}.json in the aggregate — every row is reported".format(
                    project, project
                )
            )
        results.append(
            audit_project(
                project,
                rows,
                rows_base,
                tasks_by_project.get(project, []),
                ip_docs,
                tasks_by_project,
                canon,
            )
        )

    if args.upstream_dir:
        upstream_source = "`{}` (directory)".format(args.upstream_dir)
        base_source = "*(none — directory mode)*"
    else:
        upstream_source = "`{}` via `git show`".format(args.upstream_ref)
        base_source = "`{}` via `git show`".format(base_ref)
    catalog_display = Path(args.catalog)
    if catalog_display.is_absolute() and str(catalog_display).startswith(str(ROOT) + "/"):
        catalog_display = catalog_display.relative_to(ROOT)
    extra = {
        "upstream_source": upstream_source,
        "base_source": base_source,
        "catalog": str(catalog_display),
    }

    if not results:
        print(
            "no upstream data readable at {} — check the ref (`git fetch upstream`).".format(
                args.upstream_dir or args.upstream_ref
            )
        )
        return 1

    report = render(results, projects, extra)
    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(report, encoding="utf-8")
        print("Wrote {}:".format(out_path))
    print_summary(results)

    missing = sum(len(r["missing"]) + len(r["new"]) for r in results)
    changed = sum(len(r["changed"]) for r in results)
    if args.fail_on_missing and missing:
        print("{} upstream row(s) not represented here.".format(missing))
        return 1
    if args.fail_on_changed and changed:
        print("{} upstream field change(s) not ported.".format(changed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
