#!/usr/bin/env python3

# -----------------------------------------------------------------------------
#  Copyright (C) 2026 Eclipse Foundation
#
#  This program and the accompanying materials are made
#  available under the terms of the Eclipse Public License 2.0
#  which is available at https://www.eclipse.org/legal/epl-2.0/
#
#  SPDX-License-Identifier: EPL-2.0
# -----------------------------------------------------------------------------
#
# check_ascii_console.py
#
# Regression guard for the 2026-11-14 incident in which `py: fetch repo stats`
# died with a UnicodeEncodeError: the task shell ran with an ASCII console
# encoding, and the "fetching ..." progress line printed a literal ellipsis
# (\u2026). Every printing script now hardens its console via
# uap_common.harden_console() at import, so printing Unicode can no longer
# crash a run.
#
# How it proves that: ONE child interpreter PER module, each forced to an
# ASCII encoding (PYTHONIOENCODING=ascii + LC_ALL=C, so the check is
# reproducible from any locale). The child imports that single module — its
# harden_console() call runs at import — then asserts BOTH sys.stdout and
# sys.stderr already carry the utf-8 encoding and prints accents, an ellipsis
# and an em dash to both streams. Per-module isolation matters: with one
# shared child, the first hardened stream would mask a deleted
# harden_console() call in the second module (and the first module happened
# to be build_catalog.py, NOT the incident's fetch_repo_stats.py).
# validate_ips.py is deliberately not probed by import: it sys.exit(2)s at
# import time when jsonschema is missing, indistinguishable from a real
# failure; its harden_console() call sits next to the covered ones, and
# `py: validate ips strict` / CI exercise the whole script anyway.
#
# Run via the 'py: ascii console check' task (also a CI step in
# .github/workflows/validate-ips.yml), or directly:
#   python3 scripts/check_ascii_console.py
"""Assert every importable printing script survives an ASCII console locale."""

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"

# The guard dog guards itself: the failure report prints the child's captured
# non-ASCII output, which must not raise under the very locale checked here.
sys.path.insert(0, str(SCRIPTS))

from uap_common import harden_console  # noqa: E402

harden_console()

# The modules hardening their console at import, verified one per child.
MODULES = ("build_catalog", "fetch_repo_stats", "upstream_audit")

# Pure-ASCII source: \u escapes are resolved by the CHILD's parser, so the
# child prints exactly what a data-derived non-ASCII string would.
CHILD = """
import sys
sys.path.insert(0, {scripts!r})
import {module}
out_enc = (sys.stdout.encoding or "").lower()
err_enc = (sys.stderr.encoding or "").lower()
assert out_enc in ("utf-8", "utf8"), "stdout not hardened: " + repr(sys.stdout.encoding)
assert err_enc in ("utf-8", "utf8"), "stderr not hardened: " + repr(sys.stderr.encoding)
print("stdout \\u00e9\\u2026\\u2014 ok")
print("stderr \\u00e9\\u2026\\u2014 ok", file=sys.stderr)
sys.stderr.flush()
"""

STDOUT_MARKER = "stdout \u00e9\u2026\u2014 ok"
STDERR_MARKER = "stderr \u00e9\u2026\u2014 ok"


def check_module(module):
    """Run one isolated child; return None on success, a report line on failure."""
    env = dict(os.environ, PYTHONIOENCODING="ascii", LC_ALL="C", LANG="C")
    proc = subprocess.run(
        [sys.executable, "-c",
         CHILD.format(scripts=str(SCRIPTS), module=module)],
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    out = proc.stdout.decode("utf-8", "replace")
    err = proc.stderr.decode("utf-8", "replace")
    if proc.returncode == 0 and STDOUT_MARKER in out and STDERR_MARKER in err:
        return None
    return "%s (exit %s)\n  stdout: %s\n  stderr: %s" % (
        module, proc.returncode, out.strip(), err.strip())


def main():
    failures = []
    for module in MODULES:
        failure = check_module(module)
        if failure:
            failures.append(failure)
    if failures:
        print("ASCII_CONSOLE_CHECK_FAILED — module dropped its console hardening:")
        for failure in failures:
            print("  " + failure)
        return 1
    print("ASCII_CONSOLE_CHECK_OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
