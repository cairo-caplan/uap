#!/usr/bin/env python3

# Copyright (c) 2026 Eclipse Foundation
"""
One-shot well-formedness check for the generated docs/diagrams/*.drawio.svg:
the SVG must parse as XML, the embedded mxfile must parse as XML too, and no
rendered shape may exceed the declared viewBox.
"""
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

ok = True
for path in sorted((ROOT / "docs" / "diagrams").glob("*.drawio.svg")):
    text = path.read_text(encoding="utf-8")
    try:
        ET.fromstring(text)
        svg = "SVG-OK"
    except ET.ParseError as exc:
        svg = f"SVG-PARSE-FAIL {exc}"
        ok = False
    mx = re.search(r"<mxfile.*</mxfile>", text, re.S)
    if not mx:
        svg += " NO-MXFILE"
        ok = False
    else:
        try:
            ET.fromstring(mx.group(0))
            svg += " MXFILE-OK"
        except ET.ParseError as exc:
            svg += f" MXFILE-PARSE-FAIL {exc}"
            ok = False
    # geometry inside the declared page
    vb = re.search(r'viewBox="0 0 (\d+) (\d+)"', text)
    if vb:
        w, h = int(vb.group(1)), int(vb.group(2))
        out_of_view = [
            (x, y)
            for x, y in re.findall(r'([0-9.]+),([0-9.]+)', text)
            if float(x) > w or float(y) > h
        ]
        if out_of_view:
            svg += f" OUT-OF-VIEW {out_of_view[:4]}"
            ok = False
    # width/height attributes carry px units (draw.io convention)
    if vb and f'width="{w}px"' not in text[:600]:
        svg += " NO-PX-WIDTH"
        ok = False
    print(f"{path.name}: {svg}")

sys.exit(0 if ok else 1)
