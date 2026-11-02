#!/usr/bin/env python3

# Copyright (c) 2026 Eclipse Foundation
"""
Generate the three `docs/diagrams/UAP-*.drawio.svg` documentation diagrams.

Each output is a **valid, editable draw.io SVG**: the rendered vector content
lives in a `<switch>` group (so the file displays in any browser), and the
native `mxfile` model is embedded inside `<defs><document type="text/xml">`
(the container draw.io itself writes), so "Edit Diagram" in
app.diagrams.net / draw.io round-trips without loss.

The diagram geometry is defined once in SPECS below and rendered into both
the SVG shapes and the embedded mxGraphModel, keeping the two in sync.

Usage:
  python3 scripts/gen_diagrams.py    # (re)write docs/diagrams/*.drawio.svg
"""
import sys
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "docs" / "diagrams"

DRAWIO_VERSION = "24.7.17"
AGENT = "UAP scripts/gen_diagrams.py"


def esc_attr(s):
    """XML-attribute escaping (draw.io keeps newlines inside attribute values)."""
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("\r", "&#13;").replace("\n", "&#10;"))


# --------------------------------------------------------------------------
# SVG rendering
# --------------------------------------------------------------------------
MARKERS = """<marker id="block" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#000000"/></marker>
<marker id="open" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10" stroke="#000000" stroke-width="1.5" fill="none"/></marker>"""


def text_el(x, y, s, size=12, weight="normal", anchor="start", fill="#000000"):
    extra = f' font-weight="{weight}"' if weight != "normal" else ""
    return (
        f'<text x="{x}" y="{y}" font-family="Helvetica" font-size="{size}"{extra} '
        f'fill="{fill}" text-anchor="{anchor}">{escape(s)}</text>'
    )


def render_box(b):
    """UML class box (title + attribute compartment) or plain component box."""
    x, y, w, h = b["x"], b["y"], b["w"], b["h"]
    parts = [
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{b.get("fill", "#ffffff")}" '
        f'stroke="#000000" stroke-width="1.5"/>'
    ]
    kind = b.get("kind", "class")
    if kind == "class" and b.get("attrs"):
        title_y = y + 22
        parts.append(text_el(x + w / 2, title_y, b["title"], size=14, weight="bold", anchor="middle"))
        parts.append(f'<line x1="{x}" y1="{y + 30}" x2="{x + w}" y2="{y + 30}" stroke="#000000" stroke-width="1"/>')
        for i, attr in enumerate(b["attrs"]):
            parts.append(text_el(x + 8, y + 48 + 16 * i, attr, size=12))
    else:
        label = b.get("title", "")
        sub = b.get("sub")
        if sub:
            parts.append(text_el(x + w / 2, y + h / 2 - 4, label, size=13, weight="bold", anchor="middle"))
            parts.append(text_el(x + w / 2, y + h / 2 + 14, sub, size=11, anchor="middle"))
        else:
            parts.append(text_el(x + w / 2, y + h / 2 + 4, label, size=13, weight="bold", anchor="middle"))
    if kind == "artifact":
        # dog-ear corner marking a data artifact
        d = 12
        parts.append(f'<path d="M{x + w - d},{y} L{x + w},{y + d}" stroke="#000000" stroke-width="1" fill="none"/>')
    return "".join(parts)


def render_edge(e):
    pts = [(e["x1"], e["y1"])] + [tuple(v) for v in e.get("via", [])] + [(e["x2"], e["y2"])]
    d = "M{:.0f},{:.0f}".format(*pts[0]) + "".join(" L{:.0f},{:.0f}".format(*p) for p in pts[1:])
    arrow = e.get("arrow", "none")
    marker = ""
    if arrow == "block":
        marker = ' marker-end="url(#block)"'
    elif arrow == "open":
        marker = ' marker-end="url(#open)"'
    dash = ' stroke-dasharray="4 4"' if e.get("dashed") else ""
    parts = [f'<path d="{d}" stroke="#000000" stroke-width="1.5" fill="none"{dash}{marker}/>']
    label = e.get("label")
    if label:
        mx, my = pts[0]
        if len(pts) >= 2:
            mid = pts[len(pts) // 2]
            prev = pts[len(pts) // 2 - 1]
            mx, my = (mid[0] + prev[0]) / 2, (mid[1] + prev[1]) / 2
        lx = e.get("label_x", mx)
        ly = e.get("label_y", my - 8)
        anchor = e.get("label_anchor", "middle")
        parts.append(text_el(lx, ly, label, size=12, anchor=anchor))
    if e.get("m1"):
        parts.append(text_el(e["x1"] + 5, e["y1"] - 6, e["m1"], size=11))
    if e.get("m2"):
        parts.append(text_el(e["x2"] + 5, e["y2"] - 6, e["m2"], size=11))
    return "".join(parts)


def render_lifeline(lf, bottom):
    x, y, w, h = lf["x"], lf["y"], lf["w"], lf["h"]
    cx = x + w / 2
    return (
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="#ffffff" stroke="#000000" stroke-width="1.5"/>'
        + text_el(cx, y + h / 2 + 5, lf["name"], size=13, weight="bold", anchor="middle")
        + f'<line x1="{cx}" y1="{y + h}" x2="{cx}" y2="{bottom}" stroke="#000000" stroke-width="1" stroke-dasharray="4 4"/>'
    )


def render_message(m):
    x1, x2, y = m["x1"], m["x2"], m["y"]
    dash = ' stroke-dasharray="4 4"' if m.get("dashed") else ""
    marker = ' marker-end="url(#open)"' if m.get("dashed") else ' marker-end="url(#block)"'
    parts = [
        f'<line x1="{x1}" y1="{y}" x2="{x2}" y2="{y}" stroke="#000000" stroke-width="1.5"{dash}{marker}/>',
        text_el((x1 + x2) / 2, y - 6, m["label"], size=12, anchor="middle"),
    ]
    return "".join(parts)


def render_svg(spec):
    body = []
    for b in spec.get("boxes", []):
        body.append(render_box(b))
    for e in spec.get("edges", []):
        body.append(render_edge(e))
    bottom = spec.get("height", 600) - 30
    lifelines = {lf["id"]: lf for lf in spec.get("lifelines", [])}
    for lf in spec.get("lifelines", []):
        body.append(render_lifeline(lf, bottom))
    for m in spec.get("messages", []):
        m = dict(m)
        m.setdefault("x1", lifelines[m["from"]]["x"] + lifelines[m["from"]]["w"] / 2)
        m.setdefault("x2", lifelines[m["to"]]["x"] + lifelines[m["to"]]["w"] / 2)
        body.append(render_message(m))
    for t in spec.get("texts", []):
        body.append(
            text_el(t["x"], t["y"], t["text"], size=t.get("size", 12),
                    weight="bold" if t.get("bold") else "normal",
                    anchor=t.get("anchor", "start"))
        )
    w, h = spec["width"], spec["height"]
    model = mxfile(spec)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
        f'width="{w}px" height="{h}px" viewBox="0 0 {w} {h}">\n'
        f'<!-- Do not edit this file by hand. It is generated by scripts/gen_diagrams.py; '
        f'the embedded draw.io model can be edited with draw.io "Edit Diagram". -->\n<g/>\n'
        f'<defs>\n{MARKERS}\n<document type="text/xml" id="0">\n{model}\n</document>\n</defs>\n'
        f'<switch>\n<g id="page-1">\n{"".join(body)}\n</g>\n'
        f'<text x="0" y="{h - 4}">This file contains an embedded draw.io SVG diagram '
        f'(see the mxfile element in the defs section).</text>\n</switch>\n</svg>\n'
    )


# --------------------------------------------------------------------------
# Embedded draw.io (mxGraph) model
# --------------------------------------------------------------------------
def mx_style(b):
    kind = b.get("kind", "class")
    if kind == "class":
        return "whiteSpace=wrap;html=1;align=left;verticalAlign=top;fontSize=12;"
    if kind == "artifact":
        return "shape=mxgraph.uml.artifact;html=1;align=center;fontSize=13;fontStyle=1;"
    if kind == "component":
        return "shape=mxgraph.uml.component;html=1;align=center;fontSize=13;fontStyle=1;"
    return "whiteSpace=wrap;html=1;align=center;fontSize=13;fontStyle=1;"


def mx_value(b):
    if b.get("kind") == "class" and b.get("attrs"):
        return "«class»\n" + b["title"] + "\n\n" + "\n".join(b["attrs"])
    sub = b.get("sub")
    return b.get("title", "") + (f"\n{sub}" if sub else "")


def mx_edge_style(e):
    arrow = e.get("arrow", "none")
    if e.get("dashed"):
        arrow = "open" if arrow == "open" or not arrow else arrow
    if arrow == "block":
        base = "edgeStyle=entityRelationEdgeStyle;html=1;endArrow=block;"
    elif arrow == "open":
        base = "edgeStyle=entityRelationEdgeStyle;html=1;endArrow=open;"
    else:
        base = "edgeStyle=entityRelationEdgeStyle;html=1;endArrow=none;"
    return base + ("dashed=1;" if e.get("dashed") else "") + "fontSize=12;"


def mxfile(spec):
    cells = []
    cid = 0

    def next_id():
        nonlocal cid
        cid += 1
        return f"c{cid}"

    ids = {}
    for b in spec.get("boxes", []):
        bid = next_id()
        ids[b["id"]] = bid
        cells.append(
            f'<mxCell id="{bid}" value="{esc_attr(mx_value(b))}" style="{mx_style(b)}" '
            f'vertex="1" parent="1"><mxGeometry x="{b["x"]}" y="{b["y"]}" '
            f'width="{b["w"]}" height="{b["h"]}" as="geometry"/></mxCell>'
        )
    for e in spec.get("edges", []):
        src = ids.get(e.get("source", ""), "")
        tgt = ids.get(e.get("target", ""), "")
        geom = (
            '<mxGeometry relative="1" as="geometry">'
            + "".join(
                f'<mxPoint as="wayPoint" x="{v[0]}" y="{v[1]}"/>' for v in e.get("via", [])
            )
            + "</mxGeometry>"
        )
        conn = f' source="{src}" target="{tgt}"' if src and tgt else ""
        cells.append(
            f'<mxCell id="{next_id()}" value="{esc_attr(e.get("label", ""))}" '
            f'style="{mx_edge_style(e)}" edge="1" parent="1"{conn}>{geom}</mxCell>'
        )
        for mult_key, end_key in (("m1", "x1"), ("m2", "x2")):
            if e.get(mult_key):
                cells.append(
                    f'<mxCell id="{next_id()}" value="{esc_attr(e[mult_key])}" '
                    f'style="text;html=1;align=left;fontSize=11;" vertex="1" parent="1">'
                    f'<mxGeometry x="{e[end_key] + 6}" y="{e["y1"] - 24}" width="30" height="20" as="geometry"/></mxCell>'
                )
    bottom = spec.get("height", 600) - 30
    lifeline_ids = {}
    for lf in spec.get("lifelines", []):
        lid = next_id()
        lifeline_ids[lf["id"]] = lid
        cells.append(
            f'<mxCell id="{lid}" value="{esc_attr(lf["name"])}" '
            f'style="shape=umlLifeline;perimeter=lifelinePerimeter;container=0;html=1;'
            f'whiteSpace=wrap;colinear=1;align=center;fontStyle=1;size={lf["h"]};" '
            f'vertex="1" parent="1"><mxGeometry x="{lf["x"]}" y="{lf["y"]}" '
            f'width="{lf["w"]}" height="{bottom - lf["y"]}" as="geometry"/></mxCell>'
        )
    for m in spec.get("messages", []):
        lifelines = {l["id"]: l for l in spec.get("lifelines", [])}
        x1 = m.get("x1", lifelines[m["from"]]["x"] + lifelines[m["from"]]["w"] / 2)
        x2 = m.get("x2", lifelines[m["to"]]["x"] + lifelines[m["to"]]["w"] / 2)
        style = "html=1;verticalAlign=bottom;endArrow=open;dashed=1;fontSize=12;" if m.get("dashed") \
            else "html=1;verticalAlign=bottom;endArrow=block;fontSize=12;"
        cells.append(
            f'<mxCell id="{next_id()}" value="{esc_attr(m["label"])}" style="{style}" '
            f'edge="1" parent="1" source="{lifeline_ids[m["from"]]}" target="{lifeline_ids[m["to"]]}"'
            f'><mxGeometry relative="1" as="geometry">'
            f'<mxPoint x="{x1}" y="{m["y"]}" as="sourcePoint"/>'
            f'<mxPoint x="{x2}" y="{m["y"]}" as="targetPoint"/></mxGeometry></mxCell>'
        )
    for t in spec.get("texts", []):
        cells.append(
            f'<mxCell id="{next_id()}" value="{esc_attr(t["text"])}" '
            f'style="text;html=1;align={t.get("anchor", "left")};fontSize={t.get("size", 12)};" '
            f'vertex="1" parent="1"><mxGeometry x="{t["x"]}" y="{t["y"]}" '
            f'width="400" height="30" as="geometry"/></mxCell>'
        )
    diagram_id = spec["file"].split(".")[0].replace("UAP-", "").lower()
    return (
        f'<mxfile host="app.diagrams.net" agent="{AGENT}" version="{DRAWIO_VERSION}">'
        f'<diagram id="{diagram_id}" name="{esc_attr(spec["name"])}">'
        f'<mxGraphModel dx="1000" dy="800" grid="0" gridSize="10" guides="1" tooltips="1" '
        f'connect="1" arrows="1" fold="1" page="1" pageScale="1" '
        f'pageWidth="{spec["width"]}" pageHeight="{spec["height"]}" math="0" shadow="0">'
        f'<root><mxCell id="0"/><mxCell id="1" parent="0"/>'
        + "".join(cells)
        + "</root></mxGraphModel></diagram></mxfile>"
    )


# --------------------------------------------------------------------------
# Diagram 1: Domain Model (UML class diagram)
# --------------------------------------------------------------------------
ORG_ATTRS = ["id: string", "name: string", "aliases: string[]"]

DOMAIN_MODEL = {
    "file": "UAP-Domain-Model.drawio.svg",
    "name": "Domain Model",
    "width": 1120,
    "height": 620,
    "boxes": [
        {"id": "org", "kind": "class", "x": 60, "y": 40, "w": 220, "h": 95,
         "title": "Organization", "attrs": ORG_ATTRS},
        {"id": "ip", "kind": "class", "x": 420, "y": 40, "w": 260, "h": 190,
         "title": "IP", "attrs": ["Id: slug (file name)", "Name", "Owners", "URL",
                                  "License", "Status", "Category", "Description",
                                  "IP_CARD_URL / _PDF_URL"]},
        {"id": "task", "kind": "class", "x": 760, "y": 40, "w": 240, "h": 170,
         "title": "Task (\u2261 Work Item)",
         "attrs": ["TaskId", "WI", "Title", "ForkURL", "Branch", "Status",
                   "Description", "Comment"]},
        {"id": "project", "kind": "class", "x": 760, "y": 280, "w": 240, "h": 110,
         "title": "Project", "attrs": ["Id: slug (file name)", "Name", "url", "logo"]},
        {"id": "org2", "kind": "class", "x": 760, "y": 440, "w": 240, "h": 95,
         "title": "Organization", "attrs": ORG_ATTRS},
        {"id": "category", "kind": "class", "x": 60, "y": 320, "w": 180, "h": 75,
         "title": "Category", "attrs": ["name", "aliases"]},
        {"id": "license", "kind": "class", "x": 280, "y": 320, "w": 180, "h": 75,
         "title": "License", "attrs": ["licenseId", "name"]},
        {"id": "ipcard", "kind": "class", "x": 500, "y": 320, "w": 180, "h": 90,
         "title": "IP Card", "attrs": ["ip_card_json", "ip_card_pdf"]},
    ],
    "edges": [
        {"id": "e_owners", "source": "org", "target": "ip", "x1": 280, "y1": 90,
         "x2": 420, "y2": 90, "label": "Owners (\u22651)", "m1": "*", "m2": "1",
         "label_y": 74},
        {"id": "e_tasks", "source": "ip", "target": "task", "x1": 680, "y1": 110,
         "x2": 760, "y2": 110, "label": "Tasks (held in projects/*.json)",
         "m1": "1", "m2": "*", "label_y": 96},
        {"id": "e_lives", "source": "task", "target": "project", "x1": 880, "y1": 210,
         "x2": 880, "y2": 280, "label": "lives in", "m1": "*", "m2": "1",
         "label_x": 925, "label_y": 250, "label_anchor": "start"},
        {"id": "e_partners", "source": "task", "target": "org2", "x1": 1000, "y1": 150,
         "x2": 1000, "y2": 487, "via": [(1040, 150), (1040, 487)],
         "label": "Partners (\u22651)", "m1": "1", "m2": "*",
         "label_x": 1050, "label_y": 320, "label_anchor": "start"},
        {"id": "e_cat", "source": "ip", "target": "category", "x1": 480, "y1": 230,
         "x2": 150, "y2": 320, "label": "has category"},
        {"id": "e_lic", "source": "ip", "target": "license", "x1": 550, "y1": 230,
         "x2": 370, "y2": 320, "label": "has license"},
        {"id": "e_card", "source": "ip", "target": "ipcard", "x1": 620, "y1": 230,
         "x2": 590, "y2": 320, "label": "links cards"},
    ],
    "texts": [
        {"x": 60, "y": 470, "text": "IP: ips/<Id>.json (one object per file)"},
        {"x": 60, "y": 490, "text": "Task: only inside projects/<Id>.json (no Project field per Task)"},
        {"x": 60, "y": 510, "text": "Owners / Partners: references into cfg/partners.json"},
        {"x": 60, "y": 530, "text": "IP without Tasks is legitimate (Decision 3)"},
    ],
}

# --------------------------------------------------------------------------
# Diagram 2: Architecture (component / deployment)
# --------------------------------------------------------------------------
ARCHITECTURE = {
    "file": "UAP-Architecture.drawio.svg",
    "name": "Architecture",
    "width": 1160,
    "height": 700,
    "boxes": [
        {"id": "editor", "kind": "plain", "x": 60, "y": 60, "w": 200, "h": 60,
         "title": "editor.html", "sub": "contributor edits drafts"},
        {"id": "ips", "kind": "artifact", "x": 60, "y": 170, "w": 200, "h": 60,
         "title": "ips/*.json", "sub": "IP source of truth"},
        {"id": "projects", "kind": "artifact", "x": 60, "y": 260, "w": 200, "h": 60,
         "title": "projects/*.json", "sub": "Task source of truth"},
        {"id": "registries", "kind": "artifact", "x": 60, "y": 350, "w": 200, "h": 60,
         "title": "cfg/*.json", "sub": "partners, projects, categories, licenses"},
        {"id": "build", "kind": "component", "x": 360, "y": 170, "w": 200, "h": 70,
         "title": "build_catalog.py", "sub": "CI scheduled + manual"},
        {"id": "stats", "kind": "component", "x": 360, "y": 350, "w": 200, "h": 70,
         "title": "fetch_repo_stats.py", "sub": "weekly CI, GitHub + GitLab APIs"},
        {"id": "catalog", "kind": "artifact", "x": 660, "y": 170, "w": 200, "h": 70,
         "title": "cfg/catalog.json", "sub": "committed aggregate"},
        {"id": "repostats", "kind": "artifact", "x": 660, "y": 350, "w": 200, "h": 70,
         "title": "cfg/repo-stats.json", "sub": "committed stats cache"},
        {"id": "browser", "kind": "plain", "x": 940, "y": 170, "w": 200, "h": 70,
         "title": "Browser", "sub": "ONE data fetch: catalog.json"},
        {"id": "platform", "kind": "plain", "x": 940, "y": 290, "w": 200, "h": 70,
         "title": "unified-access.html", "sub": "IP | Project \u00d7 Summary | Detailed"},
        {"id": "pages", "kind": "plain", "x": 660, "y": 500, "w": 200, "h": 80,
         "title": "GitHub Pages", "sub": "NO build \u2014 serves committed files"},
        {"id": "selfhost", "kind": "plain", "x": 940, "y": 500, "w": 200, "h": 80,
         "title": "Self-hosting", "sub": "scripts/serve.sh / any static host"},
        {"id": "validate", "kind": "component", "x": 360, "y": 500, "w": 200, "h": 80,
         "title": "validate_ips.py --strict", "sub": "+ build_catalog.py --check on every PR"},
    ],
    "edges": [
        {"id": "a1", "source": "editor", "target": "ips", "x1": 160, "y1": 120,
         "x2": 160, "y2": 170, "arrow": "block", "label": "save / PR",
         "label_x": 175, "label_y": 150, "label_anchor": "start"},
        {"id": "a2", "source": "editor", "target": "projects", "x1": 100, "y1": 120,
         "x2": 100, "y2": 260, "via": [(20, 120), (20, 260)], "arrow": "block"},
        {"id": "a3", "source": "ips", "target": "build", "x1": 260, "y1": 200,
         "x2": 360, "y2": 200, "arrow": "block"},
        {"id": "a4", "source": "projects", "target": "build", "x1": 260, "y1": 290,
         "x2": 440, "y2": 240, "arrow": "block"},
        {"id": "a5", "source": "registries", "target": "build", "x1": 260, "y1": 380,
         "x2": 440, "y2": 240, "arrow": "block", "label": "cross-ref checks"},
        {"id": "a6", "source": "build", "target": "catalog", "x1": 560, "y1": 205,
         "x2": 660, "y2": 205, "arrow": "block", "label": "commit [skip ci]"},
        {"id": "a7", "source": "stats", "target": "repostats", "x1": 560, "y1": 385,
         "x2": 660, "y2": 385, "arrow": "block", "label": "commit [skip ci]"},
        {"id": "a8", "source": "catalog", "target": "browser", "x1": 860, "y1": 205,
         "x2": 940, "y2": 205, "arrow": "block", "label": "single GET"},
        {"id": "a9", "source": "repostats", "target": "browser", "x1": 860, "y1": 385,
         "x2": 1040, "y2": 240, "arrow": "block", "label": "stats cache GET"},
        {"id": "a10", "source": "browser", "target": "platform", "x1": 1040, "y1": 240,
         "x2": 1040, "y2": 290, "arrow": "block", "label": "IP / Task rows",
         "label_x": 1055, "label_y": 270, "label_anchor": "start"},
        {"id": "a11", "source": "catalog", "target": "pages", "x1": 760, "y1": 240,
         "x2": 760, "y2": 500, "arrow": "block", "dashed": True,
         "label": "committed in repo", "label_x": 775, "label_y": 420, "label_anchor": "start"},
        {"id": "a12", "source": "pages", "target": "selfhost", "x1": 860, "y1": 540,
         "x2": 940, "y2": 540, "arrow": "none", "label": "same committed files"},
        {"id": "a13", "source": "pages", "target": "browser", "x1": 860, "y1": 520,
         "x2": 1040, "y2": 240, "arrow": "block", "dashed": True,
         "label": "static HTTPS", "label_x": 960, "label_y": 380},
    ],
    "texts": [
        {"x": 60, "y": 620, "bold": True, "text": "GitHub Pages runs no build: cfg/catalog.json must be committed "
                                                  "and is regenerated by CI (scheduled / manual, commit [skip ci])."},
        {"x": 60, "y": 645, "text": "Per-file JSON under ips/ and projects/ stays the editable source of truth; "
                                    "the runtime never fetches them."},
    ],
}

# --------------------------------------------------------------------------
# Diagram 3: Contribution Workflow (UML sequence)
# --------------------------------------------------------------------------
CONTRIBUTION = {
    "file": "UAP-Contribution-Workflow.drawio.svg",
    "name": "Contribution Workflow",
    "width": 1080,
    "height": 820,
    "lifelines": [
        {"id": "contrib", "x": 20, "y": 40, "w": 140, "h": 40, "name": "Contributor"},
        {"id": "editor", "x": 200, "y": 40, "w": 140, "h": 40, "name": "editor.html"},
        {"id": "git", "x": 380, "y": 40, "w": 140, "h": 40, "name": "Git repo / PR"},
        {"id": "validate", "x": 560, "y": 40, "w": 140, "h": 40, "name": "validate_ips.py"},
        {"id": "build", "x": 740, "y": 40, "w": 140, "h": 40, "name": "build_catalog.py"},
        {"id": "pages", "x": 920, "y": 40, "w": 140, "h": 40, "name": "Pages / site"},
    ],
    "messages": [
        {"from": "contrib", "to": "editor", "y": 120,
         "label": "1. edit an IP or a project Task"},
        {"from": "editor", "to": "contrib", "y": 170, "dashed": True,
         "label": "2. ips/<Id>.json or projects/<Id>.json"},
        {"from": "contrib", "to": "git", "y": 220,
         "label": "3. commit, push, open PR"},
        {"from": "git", "to": "validate", "y": 270,
         "label": "4. --strict (schemas + refs)"},
        {"from": "validate", "to": "git", "y": 320, "dashed": True,
         "label": "5. OK / fail PR"},
        {"from": "git", "to": "build", "y": 370,
         "label": "6. --check (aggregate fresh?)"},
        {"from": "build", "to": "git", "y": 420, "dashed": True,
         "label": "7. up to date / stale fails PR"},
        {"from": "contrib", "to": "git", "y": 470,
         "label": "8. merge PR"},
        {"from": "git", "to": "build", "y": 530,
         "label": "9. CI scheduled / manual rebuild"},
        {"from": "build", "to": "git", "y": 580, "dashed": True,
         "label": "10. commit cfg/catalog.json [skip ci]"},
        {"from": "git", "to": "pages", "y": 630,
         "label": "11. publish committed files"},
        {"from": "pages", "to": "contrib", "y": 680, "dashed": True,
         "label": "12. site loads ONE cfg/catalog.json"},
    ],
    "texts": [
        {"x": 20, "y": 760, "text": "Steps 4-7 run on every merge request; steps 9-10 regenerate the "
                                    "runtime aggregate after merges."},
    ],
}

SPECS = [DOMAIN_MODEL, ARCHITECTURE, CONTRIBUTION]


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for spec in SPECS:
        path = OUT_DIR / spec["file"]
        path.write_text(render_svg(spec), encoding="utf-8")
        print(f"Wrote {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
