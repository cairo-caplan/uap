#!/usr/bin/env python3

# Copyright (c) 2025-2026 Eclipse Foundation
"""
Validate the UAP data files against their JSON Schemas.

  - every `ips/*.json` is a single IP object validated against
    `cfg/schema-ip.json`;
  - every `projects/*.json` is a project document (with its Tasks) validated
    against `cfg/schema-project.json`;
  - cross-references are checked as well: every `Task.IPs[]` id must have a
    matching `ips/<id>.json` (whose `Id` matches the file), every
    `Task.Partners[]` / `IP.Owners[]` must resolve in `cfg/partners.json`
    (by name or alias), and every `projects/<file>.json` `Id` must exist in
    `cfg/projects.json`.

Usage:
  python3 scripts/validate_ips.py            # prints results, non-zero on error
  python3 scripts/validate_ips.py --strict   # also reject unknown properties

This script uses the `jsonschema` package (pip install jsonschema).
"""
import argparse
import json
import sys
from pathlib import Path
from urllib.parse import urlparse

# Task shells may run with an ASCII locale; error output includes file
# content with Unicode (en-dashes, etc.), so never crash while printing it.
import io  # noqa: E402

if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(
        sys.stdout.buffer, encoding="utf-8", errors="replace", line_buffering=True
    )
    sys.stderr = io.TextIOWrapper(
        sys.stderr.buffer, encoding="utf-8", errors="replace", line_buffering=True
    )

sys.path.insert(0, str(Path(__file__).resolve().parent))

from uap_common import iter_json_files, load_json, partner_lookup, to_list  # noqa: E402

try:
    import jsonschema
except Exception:
    print("Missing dependency: run `pip install jsonschema` first.")
    sys.exit(2)

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_IP_PATH = ROOT / "cfg" / "schema-ip.json"
SCHEMA_PROJECT_PATH = ROOT / "cfg" / "schema-project.json"


def load_schema(path, strict=False):
    schema = load_json(path)
    if strict:
        # create a copy where every object disallows additionalProperties
        schema = dict(schema)
        schema["additionalProperties"] = False
        props = schema.get("properties", {})
        if "Tasks" in props:
            tasks = dict(props["Tasks"])
            item = dict(tasks.get("items", {}))
            item["additionalProperties"] = False
            tasks["items"] = item
            schema["properties"] = dict(props)
            schema["properties"]["Tasks"] = tasks
    return schema


# Custom validator for URI format that allows empty strings.
def is_uri_or_empty(instance):
    if not isinstance(instance, str):
        return True  # Let the "type" validation handle non-strings
    if instance == "":
        return True  # Allow empty strings

    # Use Python's built-in URL parser for robust validation.
    # It must have a scheme (http, https, etc.) OR a network location
    try:
        result = urlparse(instance)
        if result.scheme:
            return True
        # Re-parse with a prepended scheme to correctly identify the netloc;
        # a valid netloc must exist AND contain at least one dot.
        result_with_scheme = urlparse("//" + instance)
        return bool(result_with_scheme.netloc and "." in result_with_scheme.netloc)
    except ValueError:
        return False


# Shared helper for the IP Card URL formats. Accepts a valid URI, an empty
# string, or a relative path into the ip_cards/ directory (the only allowed
# local location) whose extension is one of allowed_exts.
def make_ip_card_checker(allowed_exts):
    def check(instance):
        if not isinstance(instance, str):
            return True
        if instance == "":
            return True
        try:
            result = urlparse(instance)
            if result.scheme:
                return True
            result_with_scheme = urlparse("//" + instance)
            if result_with_scheme.netloc and "." in result_with_scheme.netloc:
                return True
        except ValueError:
            pass
        normalized = instance.replace("\\", "/").lower()
        if normalized.startswith("ip_cards/") and len(normalized) > len("ip_cards/"):
            filename = normalized.rsplit("/", 1)[1]
            ext = Path(filename).suffix
            return ext in allowed_exts
        return False

    return check


def make_format_checker():
    format_checker = jsonschema.FormatChecker()
    format_checker.checks("uri", raises=(ValueError,))(is_uri_or_empty)
    format_checker.checks("uri-or-empty", raises=(ValueError,))(is_uri_or_empty)
    format_checker.checks("ip_card_json", raises=(ValueError,))(
        make_ip_card_checker({".json", ".jsonc"})
    )
    format_checker.checks("ip_card_pdf", raises=(ValueError,))(
        make_ip_card_checker({".pdf"})
    )
    return format_checker


def validate_file(path, schema, resolver_base, format_checker, root_validator=None):
    data = load_json(path)
    resolver = jsonschema.RefResolver(
        base_uri=f"file://{resolver_base}", referrer=schema
    )
    validator = jsonschema.Draft7Validator(
        schema, resolver=resolver, format_checker=format_checker
    )
    errors = sorted(validator.iter_errors(data), key=lambda e: list(e.path))
    return data, errors


def check_file_name_matches_id(path, data, kind):
    """The document Id must match the file stem so the aggregate keys and
    the file layout stay consistent."""
    errors = []
    if not isinstance(data, dict):
        return [f"expected a single JSON object, got {type(data).__name__}"]
    if data.get("Id") != path.stem:
        errors.append(f"Id {data.get('Id')!r} does not match file name {path.name}")
    return errors


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--strict", action="store_true",
        help="Fail on unknown properties (additionalProperties=false)",
    )
    args = parser.parse_args()

    if not SCHEMA_IP_PATH.exists() or not SCHEMA_PROJECT_PATH.exists():
        print("Schemas not found under cfg/ (schema-ip.json / schema-project.json)")
        return 2

    schema_ip = load_schema(SCHEMA_IP_PATH, strict=args.strict)
    schema_project = load_schema(SCHEMA_PROJECT_PATH, strict=args.strict)
    format_checker = make_format_checker()

    for path, schema, kind in (
        (SCHEMA_IP_PATH, schema_ip, "IP"),
        (SCHEMA_PROJECT_PATH, schema_project, "project"),
    ):
        try:
            jsonschema.Draft7Validator.check_schema(schema)
            print(f"Schema {path} appears to be a valid Draft7 JSON Schema")
        except Exception as e:
            print(f"Schema validation ERROR ({path}): {e}")
            return 2

    any_errors = False

    # Referential-integrity setup.
    try:
        resolve_partner = partner_lookup(load_json(ROOT / "cfg" / "partners.json"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"cfg/partners.json cannot be loaded: {exc}")
        return 2
    try:
        projects_registry = {p["id"] for p in load_json(ROOT / "cfg" / "projects.json")}
    except (OSError, json.JSONDecodeError) as exc:
        print(f"cfg/projects.json cannot be loaded: {exc}")
        return 2

    # The compatibility matrix is runtime data the page fetches but no schema
    # covers; at minimum it must parse and carry the expected shape.
    try:
        matrix = load_json(ROOT / "cfg" / "compatibility-matrix.json")
        if not isinstance(matrix.get("columns"), list) or not isinstance(
            matrix.get("rows"), list
        ):
            print("cfg/compatibility-matrix.json must have 'columns' and 'rows' arrays")
            return 2
    except (OSError, json.JSONDecodeError) as exc:
        print(f"cfg/compatibility-matrix.json cannot be loaded: {exc}")
        return 2

    # --- ips/*.json -------------------------------------------------------
    ip_ids = {}
    for path in iter_json_files(ROOT / "ips"):
        print(f"Validating {path} ...", end=" ")
        try:
            data, errors = validate_file(
                path, schema_ip, SCHEMA_IP_PATH, format_checker
            )
        except Exception as e:
            print(f"ERROR parsing/validating: {e}")
            any_errors = True
            continue
        errors = errors + check_file_name_matches_id(path, data, "IP")
        if isinstance(data, dict):
            for owner in to_list(data.get("Owners")):
                if not resolve_partner(owner):
                    errors.append(
                        f"Owner {owner!r} not in cfg/partners.json"
                    )
        if not errors:
            print("OK")
        else:
            any_errors = True
            print(f"{len(errors)} error(s)")
            for err in errors:
                if isinstance(err, str):
                    print(f"  - {err}")
                else:
                    loc = ".".join(str(p) for p in err.path) or "<root>"
                    print(f"  - {loc}: {err.message}")
        if isinstance(data, dict) and data.get("Id"):
            ip_ids.setdefault(data["Id"], path)

    # --- projects/*.json --------------------------------------------------
    for path in iter_json_files(ROOT / "projects"):
        print(f"Validating {path} ...", end=" ")
        try:
            data, errors = validate_file(
                path, schema_project, SCHEMA_PROJECT_PATH, format_checker
            )
        except Exception as e:
            print(f"ERROR parsing/validating: {e}")
            any_errors = True
            continue
        errors = errors + check_file_name_matches_id(path, data, "project")
        if isinstance(data, dict):
            if data.get("Id") not in projects_registry:
                errors.append(
                    f"project Id {data.get('Id')!r} not registered in cfg/projects.json"
                )
            for task in data.get("Tasks", []):
                for ip_ref in to_list(task.get("IPs")):
                    if ip_ref not in ip_ids:
                        errors.append(
                            f"task {task.get('TaskId')}: IP {ip_ref!r} "
                            f"has no ips/{ip_ref}.json"
                        )
                partners = to_list(task.get("Partners"))
                if not partners:
                    errors.append(f"task {task.get('TaskId')}: no Partners")
                for partner in partners:
                    if not resolve_partner(partner):
                        errors.append(
                            f"task {task.get('TaskId')}: Partner {partner!r} "
                            "not in cfg/partners.json"
                        )
                # Task must not re-declare the project (it is the document root).
                if "Project" in (task or {}):
                    errors.append(
                        f"task {task.get('TaskId')}: carries a Project field; "
                        "the project is the document root"
                    )
        if not errors:
            print("OK")
        else:
            any_errors = True
            print(f"{len(errors)} error(s)")
            for err in errors:
                if isinstance(err, str):
                    print(f"  - {err}")
                else:
                    loc = ".".join(str(p) for p in err.path) or "<root>"
                    print(f"  - {loc}: {err.message}")

    if any_errors:
        print("\nOne or more files failed validation.")
        return 1
    print("\nAll ips/*.json and projects/*.json files validate and cross-reference.")
    return 0


if __name__ == "__main__":
    sys.exit(main())