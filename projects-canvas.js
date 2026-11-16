/*
 *-------------------------------------------------------------------------------
 * Copyright (C) 2026 Eclipse Foundation
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 *-------------------------------------------------------------------------------
*/

(function () {

// ---------------------------------------------------------------------------
// Projects canvas — the Canvas layout of the Platform page's Projects view
// ---------------------------------------------------------------------------

// Project cards float on a scrollable, pannable canvas in a responsive grid;
// every card is a production .entity-card and is user-resizable by its
// bottom-right grip. Card heads follow one click contract: the title opens the
// production detail drawer, the caret expands a project's task list. The IPs
// listed in a task row are little clickable cards: clicking a chip shows that
// IP card on the canvas, clicking the pressed chip again hides it — the Task
// drawer's "IPs on canvas" toggles are the second surface of the same control.
// Cards are wired by rounded orthogonal dashed lines and never overlap: a
// spawn/expand/resize/drop displaces whatever it now covers by the least amount
// (IP cards prefer stacking downward) and the displaced cards glide to their
// free spot. A live search dims non-matching cards and hides non-matching task
// rows; an unpinned IP card whose every linked task row became unreachable is
// dropped and respawns in place when its chip is pressed again.
//
// Everything about the DATA lives in script.js (loaded first): the datasets,
// the detail drawer, the card widgets, the search needle and its hit counts.
// This module owns the canvas only, and script.js reaches it exclusively
// through the optional window.UapCanvas? hooks at the bottom — a page without
// this file is a page without the Canvas layout, nothing else changes.

// ---------------------------------------------------------------------------
// State the canvas owns
// ---------------------------------------------------------------------------

// Session-scoped view state (positions, manual sizes, scroll, expanded,
// selection, pins) plus the Canvas | Grid choice. localStorage stays reserved
// for the theme (scripts/theme.js).
const STATE_STORAGE_KEY = 'uap-canvas-state';
const STATE_VERSION = 1;
const SVG_NS = 'http://www.w3.org/2000/svg';

const stageEl  = document.getElementById('canvas-stage');
const canvasEl = document.getElementById('uap-canvas');
const svgEl    = document.getElementById('uap-links');
const resetBtn = document.getElementById('uap-reset');
const clearBtn = document.getElementById('uap-clear');

const collator = new Intl.Collator(undefined, { sensitivity: 'base' });

let projectNodes = [];             // { key, name, logo, url, tasks: [taskNode] }
const taskNodeByKey = new Map();   // "t:<project>/<TaskId|Title>" -> taskNode
const refsByIp = new Map();        // ipId -> [taskNode] (sharing lookup)

// Is the canvas the layout on screen? Everything that measures, sizes or paints
// waits for that, because a hidden stage reports zeros everywhere.
let canvasActive = false;
let built = false;         // cards exist for the current model
let needsBuild = true;     // the model changed while the canvas was hidden
let pendingFontRefresh = false;
let lastStageScroll = { x: 0, y: 0 };
// The layout choice lives in this payload; script.js reads and writes it
// through getLayout()/saveLayout() so one key holds the whole Projects state.
let savedLayout = 'canvas';

// Unified-view state. Positions and sizes live here (not in the DOM); cards
// and lines are repainted from it, so geometry never drifts.
const viewState = {
  pos: new Map(),           // nodeKey -> { x, y } (canvas space, top-left)
  size: new Map(),          // nodeKey -> { w, h } (measured; authoritative for layout)
  els: new Map(),           // nodeKey -> HTMLElement
  edges: [],                // { from, to, path } — only Task→IP edges exist
  linesByNode: new Map(),   // nodeKey -> [edge]
  expanded: new Set(),      // projectKeys whose task list is revealed
  selected: [],             // taskKeys, oldest first — last item draws solid lines
  pinned: new Set(),        // ipIds whose card survives losing every task link
  taskRowEls: new Map(),    // taskKey -> { el, projectKey }
  ipCardLinks: new Map(),   // ipId -> Set<taskKey> wired right now (row chip or drawer toggle)
  spawnOrder: [],           // ipIds in spawn order — the collision solver's order
  resized: new Set()        // nodeKeys with a user-set size (the only persisted sizes)
};

// ---------------------------------------------------------------------------
// Small DOM helpers (createElement only — the project avoids innerHTML for
// dynamic content; icons are static <i> markup set via className).
// ---------------------------------------------------------------------------
function mkEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function icon(classes) {
  const i = mkEl('i', classes);
  i.setAttribute('aria-hidden', 'true');
  return i;
}

function asArray(v) {
  return Array.isArray(v) ? v.filter(Boolean) : [v].filter(Boolean);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}





// ---------------------------------------------------------------------------
// Model — built from the production datasets
// ---------------------------------------------------------------------------

// A canvas task node carries its own presentation fields and a back-reference
// to the script.js Task row it came from, which is what the shared search hit
// sets and the detail drawer both speak about.
function taskKeyOf(row) {
  return `t:${row.Project}/${row.TaskId || row.Title || ''}`;
}

function taskNodeFor(taskOrRow) {
  if (!taskOrRow) return null;
  if (taskOrRow.row) return taskOrRow;               // already a canvas node
  return taskNodeByKey.get(taskKeyOf(taskOrRow)) || null;
}

// Project nodes group the production Task rows by their Project field and join
// cfg/projects.json for the logo and the website. Nothing is fetched here: the
// datasets are whatever script.js last loaded, catalogue or local preview.
function buildModel() {
  taskNodeByKey.clear();
  refsByIp.clear();
  const metaByName = new Map(asArray(projectsData).map(p => [p.name, p]));
  const byProject = new Map();
  for (const row of taskDataset) {
    let project = byProject.get(row.Project);
    if (!project) {
      const meta = metaByName.get(row.Project) || {};
      project = {
        key: `p:${row.Project}`,
        name: row.Project,
        logo: meta.logo || '',
        url: httpUrl(meta.url) || '',
        tasks: []
      };
      byProject.set(row.Project, project);
    }
    const ipIds = asArray(row.IPs);
    const node = {
      key: taskKeyOf(row),
      row,
      project: row.Project,
      Title: row.Title || '(untitled task)',
      TaskId: row.TaskId || '',
      WI: asArray(row.WI).join(', '),
      Partners: asArray(row.Partners).join(', '),
      Status: row.Status || '',
      URL: httpUrl(row.URL) || '',
      ipIds,
      ipNames: ipIds.map(ipDisplayName)
    };
    project.tasks.push(node);
    taskNodeByKey.set(node.key, node);
    for (const id of ipIds) {
      if (!refsByIp.has(id)) refsByIp.set(id, []);
      refsByIp.get(id).push(node);
    }
  }
  projectNodes = [...byProject.values()].sort((a, b) => collator.compare(a.name, b.name));
  for (const project of projectNodes) {
    project.tasks.sort((a, b) => collator.compare(a.Title, b.Title));
  }
}

// The production IP row of an id — the same object the grid cards render. An
// id the catalogue does not know must still produce a card, never an exception.
function ipRow(ipId) {
  const row = ipById.get(ipId);
  if (row) return row;
  return { Id: ipId, Name: ipId, Owners: [], Category: [], Tasks: [], _taskDetails: [] };
}

// ---------------------------------------------------------------------------
// Meta rows and pills
// ---------------------------------------------------------------------------

// Labelled meta row of a card. The VALUE rows a whole card shows come from the
// production renderCardMetaRows() (so a Canvas IP card is an IP-view grid card,
// row for row) and the pills are the production renderPill()/renderStatusPill();
// these two helpers only cover the rows the canvas invents — the task rows'
// WI/IPs/Partners/Status rows, whose values are built here.
function metaLabelledRow(label, valueEl) {
  const rowEl = mkEl('div', 'card-meta-row');
  rowEl.appendChild(mkEl('span', 'card-meta-label', label));
  rowEl.appendChild(valueEl);
  return rowEl;
}

function addMetaRow(container, label, valueEl) {
  if (!valueEl) return;   // "when available": no row without a value
  const value = mkEl('span', 'card-meta-value card-meta-value--wrap');
  value.appendChild(valueEl);
  container.appendChild(metaLabelledRow(label, value));
}

// ---------------------------------------------------------------------------
// Layout — project cards start in a responsive grid computed once per build
// (the JS sibling of style.css `.card-grid: repeat(auto-fill, minmax(320px,
// 1fr))`), sized so every project name fits on one line. After that they float
// freely but never overlap: resolveCollisions() pushes cards to the right.
// ---------------------------------------------------------------------------
const L = {
  canvasMinHeight: 900,   // minimum pannable canvas, even with a tiny catalogue
  pad: 24,
  gap: 20,
  projectW: 240,          // recomputed at build from the longest project name
  projectMinW: 240,       // canvas-only floor; the Grid keeps style.css's 320px
  projectMaxW: 520,
  ipW: 320,
  minW: 240,              // resize limits
  maxW: 1200,
  minH: 90,
  maxH: 4000,
  edgeMidGap: 48,         // minimum horizontal room for the orthogonal elbow
  maxCanvasW: 6000,       // beyond this, the collision solver pushes downward
  stackBias: 1.25         // an IP card still takes "down" when it costs up to
                          // 25% more than "right" — IP cards prefer columns
  };

// Width of a single line of `text` in the given production card class.
let measureEl = null;
function measureText(text, className) {
  if (!measureEl) {
    measureEl = mkEl('span', 'mm-measure');
    document.body.appendChild(measureEl);
  }
  measureEl.className = `mm-measure ${className}`;
  measureEl.textContent = text;
  return measureEl.offsetWidth;
}

// One uniform project-card width: wide enough for the longest project name and
// for a 14-character reservation. The head chrome is not guessed — the cards
// already exist at the minimum width, so `card box − title box + wanted title
// box` is the exact width each card needs; the widest one wins.
function computeProjectWidth() {
  const RULER = 'MMMMMMMMMMMMMM';   // 14-char reservation — longer names ellipsize (the title's tooltip carries the full name)
  let wanted = measureText(RULER, 'card-title');
  for (const project of projectNodes) {
    wanted = Math.max(wanted, measureText(project.name, 'card-title'));
  }
  let needed = L.projectMinW;
  for (const project of projectNodes) {
    const card = viewState.els.get(project.key);
    const titleEl = card.querySelector('.mm-project-title');
    // A clipped single-line title reports its full width in scrollWidth.
    const textW = Math.max(titleEl.clientWidth, titleEl.scrollWidth, wanted);
    // The logo sits in its own centred slot above the title, so it neither
    // competes for head width nor needs a reservation here.
    needed = Math.max(needed, card.offsetWidth - titleEl.clientWidth + textW);
  }
  return clamp(Math.ceil(needed), L.projectMinW, L.projectMaxW);
}

function measureNode(key) {
  const nodeEl = viewState.els.get(key);
  if (!nodeEl) return null;
  // A hidden stage measures zero (Grid layout, or the compatibility-matrix
  // tab on top of the catalogue): never let that overwrite the real geometry.
  // The solver keeps working from the last honest size and setActive()
  // re-measures everything once the canvas is back on screen.
  if (!nodeEl.offsetWidth && !nodeEl.offsetHeight) return viewState.size.get(key) || null;
  const size = { w: nodeEl.offsetWidth, h: nodeEl.offsetHeight };
  viewState.size.set(key, size);
  return size;
}

function rectOf(key) {
  const p = viewState.pos.get(key);
  const s = viewState.size.get(key);
  if (!p || !s) return null;
  return { x: p.x, y: p.y, w: s.w, h: s.h, right: p.x + s.w, bottom: p.y + s.h };
}

// AABB test against the gap-inflated boxes: `gap` is required free space, not
// overlap, so exactly-gap-spaced cards (the initial grid) do not collide.
function nodesIntersect(a, b, gap) {
  return a.x - gap < b.right && b.x - gap < a.right
    && a.y - gap < b.bottom && b.y - gap < a.bottom;
}

function applyNodePos(key, x, y) {
  const p = viewState.pos.get(key);
  if (!p) return;
  // Scrollbars cannot reach negative canvas space — keep cards reachable.
  p.x = Math.max(0, Math.round(x));
  p.y = Math.max(0, Math.round(y));
  const nodeEl = viewState.els.get(key);
  if (nodeEl) {
    nodeEl.style.left = `${p.x}px`;
    nodeEl.style.top = `${p.y}px`;
  }
}

// Relaxation solver: anchors keep their place, everything overlapping them
// moves to the candidate side that displaces it the least (right, down, left,
// up — stable tie-break in that order). IP cards prefer the downward move
// (within L.stackBias) so they stack into columns instead of rows. Every
// candidate keeps x,y ≥ 0 and inside maxCanvasW on x, which bounds the search
// space the ≤60-pass relaxation explores; with least-displacement moves the
// sweep converges in a few passes in practice.
function resolveCollisions(anchorKeys = [], gap = L.gap) {
  const anchors = new Set(anchorKeys);
  const order = [...projectNodes.map(p => p.key), ...viewState.spawnOrder.map(id => `i:${id}`)]
    .filter(key => rectOf(key));
  // May `b` be pushed out of `a`'s way? Free cards always give way; between
  // two anchors the later one in `order` gives way to the earlier one.
  const movableOver = (b, a) => !anchors.has(b) || (anchors.has(a) && order.indexOf(a) < order.indexOf(b));
  // Least-displacement destination for `b` around `a`.
  const displaceTo = (bKey, ra, rb) => {
    const cands = [
      { dir: 'R', x: ra.right + gap, y: rb.y, ok: ra.right + gap + rb.w + L.pad <= L.maxCanvasW },
      { dir: 'D', x: rb.x, y: ra.bottom + gap, ok: true },
      { dir: 'L', x: ra.left - gap - rb.w, y: rb.y, ok: ra.left - gap - rb.w >= 0 },
      { dir: 'U', x: rb.x, y: ra.top - gap - rb.h, ok: ra.top - gap - rb.h >= 0 }
    ].filter(c => c.ok);
    const cost = c => Math.abs(c.x - rb.x) + Math.abs(c.y - rb.y);
    let best = cands[0];
    // Strict <: iterating R→D→L→U keeps that order as the tie-break.
    for (const c of cands) if (cost(c) < cost(best)) best = c;
    const right = cands.find(c => c.dir === 'R');
    const down = cands.find(c => c.dir === 'D');   // always valid (no maxCanvasH)
    if (bKey.startsWith('i:') && down && (!right || cost(down) <= cost(right) * L.stackBias)) best = down;
    return best;
  };
  for (let pass = 0; pass < 60 && order.length > 1; pass++) {
    let moved = false;
    for (const aKey of order) {
      for (const bKey of order) {
        if (bKey === aKey || !movableOver(bKey, aKey)) continue;
        // Re-read both rects for every test: the previous move changed them.
        const ra = rectOf(aKey);
        const rb = rectOf(bKey);
        if (!nodesIntersect(ra, rb, gap)) continue;
        const spot = displaceTo(bKey, ra, rb);
        applyNodePos(bKey, spot.x, spot.y);
        moved = true;
      }
    }
    if (!moved) break;
  }
  ensureCanvasExtent();
  repaintAllEdges();
}

// The scroll range must track the content: keep the canvas (and the SVG
// overlay) at least as large as the viewport, and large enough for every card.
function ensureCanvasExtent() {
  // A hidden stage measures zero — sizing from it would collapse the canvas;
  // setActive() re-derives the extent on the way back.
  if (!stageLive()) return;
  // The -2 slack breaks a layout feedback loop: the canvas is measured against
  // the stage's client box, which shrinks the moment the opposite scrollbar
  // appears — an exactly-fitting canvas would then toggle the other one open.
  let w = Math.max(stageEl.clientWidth - 2, L.projectW + L.pad * 2);
  let h = Math.max(stageEl.clientHeight - 2, L.canvasMinHeight);
  // Live cards only — a visibility-pruned card keeps its saved position for
  // the respawn, and that must not keep the canvas artificially large.
  for (const key of viewState.els.keys()) {
    const p = viewState.pos.get(key);
    if (!p) continue;
    const s = viewState.size.get(key) || { w: 0, h: 0 };
    w = Math.max(w, p.x + s.w + L.pad);
    h = Math.max(h, p.y + s.h + L.pad);
  }
  w = Math.round(w);
  h = Math.round(h);
  canvasEl.style.width = `${w}px`;
  canvasEl.style.height = `${h}px`;
  svgEl.setAttribute('width', w);
  svgEl.setAttribute('height', h);
  svgEl.style.width = `${w}px`;
  svgEl.style.height = `${h}px`;
}

// Two-phase grid: cards are already created and measured, so rows are packed
// by real height instead of an estimate — no overlaps by construction.
function initialGridLayout() {
  const canvasW = Math.max(stageEl.clientWidth - 2, L.projectW + L.pad * 2);
  const cols = Math.max(1, Math.floor((canvasW - L.pad * 2 + L.gap) / (L.projectW + L.gap)));
  const rowHeights = [];
  projectNodes.forEach((project, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    let y = L.pad;
    for (let r = 0; r < row; r++) y += (rowHeights[r] || L.minH) + L.gap;
    const size = measureNode(project.key) || { w: L.projectW, h: L.minH };
    rowHeights[row] = Math.max(rowHeights[row] || 0, size.h);
    applyNodePos(project.key, L.pad + col * (L.projectW + L.gap), y);
  });
  ensureCanvasExtent();
}

// ---------------------------------------------------------------------------
// Build — production cards + drag/resize/pan + state restore.
// ---------------------------------------------------------------------------
function buildView() {
  clearSelection({ save: false });
  viewState.taskRowEls.clear();
  viewState.expanded.clear();   // cards are rebuilt collapsed; restore re-populates
  viewState.ipCardLinks.clear();
  viewState.spawnOrder = [];
  viewState.resized.clear();
  for (const key of [...viewState.els.keys()]) {
    if (key.startsWith('i:')) removeIpNode(key.slice(2));
  }
  canvasEl.querySelectorAll('.mm-node, .uap-canvas-empty').forEach(n => n.remove());
  viewState.pos.clear();
  viewState.size.clear();
  viewState.els.clear();
  viewState.linesByNode.clear();

  if (!projectNodes.length) {
    canvasEl.appendChild(mkEl('div', 'uap-canvas-empty', 'No projects with tasks in the catalogue yet.'));
    ensureCanvasExtent();
    return;
  }

  // Phase 1: create every card (at the minimum width, so the measurement
  // below never reads a width left over by an earlier build), hidden from the
  // user, then size them all uniformly from what their titles need.
  document.documentElement.style.setProperty('--mm-project-w', `${L.projectMinW}px`);
  canvasEl.classList.add('mm-building');
  for (const project of projectNodes) {
    const node = renderProjectCard(project);
    viewState.els.set(project.key, node);
    viewState.pos.set(project.key, { x: 0, y: 0 });
    canvasEl.appendChild(node);
    wireNodeDrag(node);
    wireNodeResize(node);
  }
  L.projectW = computeProjectWidth();
  // clearNodeSize() drops the inline widths, so the auto-fit fallback has to
  // read them back from these CSS variables.
  document.documentElement.style.setProperty('--mm-project-w', `${L.projectW}px`);
  document.documentElement.style.setProperty('--mm-ip-w', `${L.ipW}px`);
  for (const project of projectNodes) {
    viewState.els.get(project.key).style.width = `${L.projectW}px`;
  }
  // Phase 2: place by measured heights, then repair/restore, then reveal.
  initialGridLayout();

  const restored = restoreState();
  if (restored) applyRestoredState(restored);
  else ensureCanvasExtent();

  canvasEl.classList.remove('mm-building');
  repaintAllEdges();
  // A live search must be re-applied to the freshly built DOM (positions were
  // restored, dim/hidden classes were not) — force one honest layout pass.
  searchLayoutSig = '\u0000';
  applySearch();
  ensureCanvasExtent();
  }

// Project card: production .entity-card chrome, title on its own head row,
// production-style meta rows for the counters, and the task list revealed
// inside the card's own DOM (so dragging/resizing moves everything together).
function renderProjectCard(project) {
  const subId = `mm-project-tasks-${projectNodes.indexOf(project)}`;
  const card = mkEl('div', 'mm-node mm-node--project entity-card');
  card.dataset.key = project.key;

  const head = mkEl('div', 'card-head mm-project-head');
  // A reserved, centred slot: a card without a logo looks exactly like one
  // with a logo, so filling cfg/projects.json can never shift a layout.
  const logoSlot = mkEl('div', 'mm-project-logo-slot');
  if (project.logo) {
    const img = mkEl('img', 'mm-project-logo');
    img.src = project.logo;
    img.alt = '';
    img.loading = 'lazy';
    logoSlot.appendChild(img);
  }
  head.appendChild(logoSlot);
  const title = mkEl('button', 'card-title mm-project-title', project.name);
  title.type = 'button';
  title.title = project.name;   // the tooltip carries the name if width truncates
  title.setAttribute('aria-haspopup', 'dialog');   // title opens the drawer
  head.appendChild(title);
  if (project.url) head.appendChild(cardExtLink(project.url));
  const caret = mkEl('button', 'uap-caret');
  caret.type = 'button';
  caret.setAttribute('aria-expanded', 'false');
  caret.setAttribute('aria-controls', subId);
  caret.setAttribute('aria-label', `Show tasks of ${project.name}`);
  caret.appendChild(icon('fas fa-caret-down'));
  head.appendChild(caret);
  card.appendChild(head);

  const meta = mkEl('div', 'card-meta');
  meta.appendChild(countMetaRow('Tasks', project.tasks.length));
  meta.appendChild(countMetaRow('IPs', distinctIpCount(project)));
  card.appendChild(meta);

  const list = mkEl('div', 'mm-project-tasks');
  list.id = subId;
  list.hidden = true;
  if (!project.tasks.length) {
    list.appendChild(mkEl('div', 'uap-canvas-empty', 'No tasks in this project yet.'));
  }
  for (const task of project.tasks) list.appendChild(taskRow(task, project));
  card.appendChild(list);
  // Scroll reveal/hide of the connectors anchored on (still selected) rows.
  list.addEventListener('scroll', () => repaintProjectEdges(project), { passive: true });

  // Click contract: title (and the card's empty head/meta area) opens the
  // drawer; only the caret expands/collapses the task list.
  caret.addEventListener('click', () =>
    setProjectExpanded(project, caret.getAttribute('aria-expanded') !== 'true'));
  const openFromCard = e => {
    if (e.target.closest('a[href], button, input, label, .mm-resize, .mm-project-tasks')) return;
    if (movedSincePointerDown(card)) return;   // the gesture was a drag
    openDetailDrawer('project', project.name);
  };
  title.addEventListener('click', e => {
    if (movedSincePointerDown(card)) return;   // the gesture was a drag
    openDetailDrawer('project', project.name);
  });
  card.addEventListener('click', openFromCard);

  card.appendChild(resizeGrip());
  return card;
}

function countMetaRow(label, count) {
  return metaLabelledRow(label, mkEl('span', 'card-meta-value', String(count)));
}

// Grow/shrink the card and shove whatever the new box now covers away.
function setProjectExpanded(project, open) {
  const card = viewState.els.get(project.key);
  if (!card) return;
  const list = card.querySelector('.mm-project-tasks');
  if (!list || list.hidden === !open) return;
  // Only the caret expands — the title button opens the drawer instead.
  const caret = card.querySelector('.uap-caret');
  if (caret) caret.setAttribute('aria-expanded', open ? 'true' : 'false');
  list.hidden = !open;
  card.classList.toggle('mm-expanded', open);
  if (open) viewState.expanded.add(project.key);
  else viewState.expanded.delete(project.key);
  // Keep geometry honest: edges anchor on task rows inside this card.
  measureNode(project.key);
  if (!open) pruneHiddenIpCards();   // its rows were the last anchors of some cards
  resolveCollisions([project.key]);
  repaintProjectEdges(project);
  saveStateDebounced();
}

function distinctIpCount(project) {
  return new Set(project.tasks.flatMap(t => t.ipIds)).size;
}

function cardExtLink(url) {
  const a = mkEl('a', 'card-ext');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.setAttribute('aria-label', 'Open in a new tab');
  a.appendChild(icon('fas fa-arrow-up-right-from-square'));
  return a;
}

// Bottom-right drag handle (see wireNodeResize).
function resizeGrip() {
  const grip = mkEl('button', 'mm-resize');
  grip.type = 'button';
  grip.setAttribute('aria-label', 'Resize card; arrow keys resize width and height, Enter resets both to auto-fit');
  grip.title = 'Drag to resize · double-click or Enter resets both dimensions to auto-fit';
  return grip;
}

// ---------------------------------------------------------------------------
// Task rows — production card meta rows (Title/WI/IPs/Partners/Status) minus
// Project and repo stats, compressed by CSS. Empty fields are skipped, same
// "when available" rule as script.js isRowValueEmpty(). The IPs field is no
// plain text: every IP is a clickable mini-card (taskIpChip) toggling its IP
// card on the canvas.
// ---------------------------------------------------------------------------
function taskRow(task, project) {
  const row = mkEl('div', 'mm-task-row');
  row.dataset.taskKey = task.key;
  // data-task-key + refsByIp drive the sharing lookup; data-ips documents it.
  row.dataset.ips = task.ipIds.join(' ');
  row.setAttribute('role', 'button');
  row.tabIndex = 0;
  row.title = task.ipIds.length
    ? 'Select this task and open its details; its IP chips show / hide the IP cards on the canvas'
    : 'Open this task’s details (it references no IPs)';

  const head = mkEl('div', 'card-head mm-task-head');
  head.appendChild(mkEl('span', 'card-title mm-task-title', task.Title));
  if (task.URL) head.appendChild(cardExtLink(task.URL));
  row.appendChild(head);

  const meta = mkEl('div', 'card-meta mm-task-meta');
  addMetaRow(meta, 'WI', task.WI ? renderPill(task.WI, 'wi') : null);
  if (task.ipIds.length) {
    const ips = mkEl('span', 'card-meta-value card-meta-value--wrap');
    task.ipIds.forEach((ipId, i) => ips.appendChild(taskIpChip(task, ipId, task.ipNames[i])));
    meta.append(metaLabelledRow('IPs', ips));
  }
  addMetaRow(meta, 'Partners', task.Partners ? renderPill(task.Partners, 'partner') : null);
  addMetaRow(meta, 'Status', task.Status ? renderStatusPill(task.Status) : null);
  if (meta.children.length) row.appendChild(meta);

  row.addEventListener('click', e => {
    // The external link and the IP chips own their clicks.
    if (e.target.closest('a[href], .mm-task-ip')) return;
    toggleTaskSelection(task);
  });
  row.addEventListener('keydown', e => {
    // Interactive children (the ext link, the IP chips) activate themselves;
    // swallowing their Enter/Space here would break them — and double-toggle.
    if (e.target !== row) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();   // Space would scroll the page
    toggleTaskSelection(task);
  });
  viewState.taskRowEls.set(task.key, { el: row, projectKey: project.key });
  return row;
}

// One IP of a task row as a little card: clicking the chip shows that IP card
// on the canvas, clicking the pressed chip again hides it — exactly the
// toggleIpCardForTask semantics the Task drawer's "IPs on canvas" toggles, so
// both surfaces stay in sync through ipCardLinks (a shared IP only dies once
// its last wired task toggles off; a pinned card outlives both). Pressed ==
// this task currently has a wired edge to the IP card.
function taskIpChip(task, ipId, name) {
  const on = (viewState.ipCardLinks.get(ipId) || new Set()).has(task.key);
  const chip = mkEl('button', 'mm-task-ip' + (on ? ' is-on' : ''));
  chip.type = 'button';
  chip.dataset.ip = ipId;
  chip.setAttribute('aria-pressed', on ? 'true' : 'false');
  chip.title = `${name}: click to show / hide the IP card on the canvas`;
  chip.appendChild(icon(`mm-task-ip-icon fas ${ipChipGlyph(on)}`));
  chip.appendChild(mkEl('span', 'mm-task-ip-name', name));
  chip.addEventListener('click', e => {
    e.stopPropagation();   // the row owns selection; the chip owns the IP card
    toggleIpCardForTask(task, ipId);
  });
  return chip;
}

function ipChipGlyph(on) {
  return on ? 'fa-check' : 'fa-plus';
}

// Mirror the link table onto every rendered chip, so the task-row chips and
// the Task drawer's toggles never disagree after a spawn, a toggle-off or a
// prune (collapse / search / deselect / unpin).
function refreshIpChipStates() {
  for (const chip of canvasEl.querySelectorAll('.mm-task-ip')) {
    const rowEl = chip.closest('.mm-task-row');
    if (!rowEl) continue;
    const on = (viewState.ipCardLinks.get(chip.dataset.ip) || new Set()).has(rowEl.dataset.taskKey);
    chip.classList.toggle('is-on', on);
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    const glyph = chip.querySelector('.mm-task-ip-icon');
    if (glyph) glyph.className = `mm-task-ip-icon fas ${ipChipGlyph(on)}`;
  }
}

// ---------------------------------------------------------------------------
// Selection & IP-card spawn / prune.
// ---------------------------------------------------------------------------
function isTaskSelected(taskKey) {
  return viewState.selected.includes(taskKey);
}

// Row click contract: select + open the Task drawer; a second click on the
// selected row deselects it and closes the drawer again.
function toggleTaskSelection(task) {
  if (isTaskSelected(task.key)) {
    deselectTask(task.key);
    closeDetailDrawer();
  } else {
    selectTask(task.key);
    openDetailDrawer('task', task.row);
  }
}

function selectTask(taskKey) {
  viewState.selected.push(taskKey);
  const rowInfo = viewState.taskRowEls.get(taskKey);
  if (rowInfo) rowInfo.el.classList.add('mm-task-selected');
  // Selection alone never spawns: IP cards are born from the task-row IP
  // chips or the drawer's "IPs on canvas" toggles. The repaint lets the newest
  // selection draw solid.
  repaintAllEdges();   // newest selection draws solid, older ones ghost
  saveStateDebounced();
}

function deselectTask(taskKey) {
  viewState.selected = viewState.selected.filter(k => k !== taskKey);
  const rowInfo = viewState.taskRowEls.get(taskKey);
  if (rowInfo) rowInfo.el.classList.remove('mm-task-selected');
  removeTaskEdges(taskKey);
  pruneHiddenIpCards();
  repaintAllEdges();
  saveStateDebounced();
}

function clearSelection(opts = {}) {
  for (const key of [...viewState.selected]) {
    viewState.selected = viewState.selected.filter(k => k !== key);
    const rowInfo = viewState.taskRowEls.get(key);
    if (rowInfo) rowInfo.el.classList.remove('mm-task-selected');
    removeTaskEdges(key);
  }
  pruneHiddenIpCards();
  repaintAllEdges();
  closeDetailDrawer();
  if (opts.save !== false) saveStateDebounced();
}

// Expand the owning project, select the task row and flash it, so the Task → IP
// connectors become visible around it.
function revealTask(taskOrRow) {
  // Either a canvas task node or a production Task row (the detail drawer, the
  // compatibility-matrix deep links): the task key ties the two together.
  const task = taskNodeFor(taskOrRow);
  if (!canvasActive || !built || !task) return;
  const project = projectNodes.find(p => p.name === task.project);
  if (project) setProjectExpanded(project, true);
  if (!isTaskSelected(task.key)) selectTask(task.key);
  const info = viewState.taskRowEls.get(task.key);
  if (info) info.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (info) {
    info.el.classList.add('mm-highlight');
    setTimeout(() => info.el.classList.remove('mm-highlight'), 1200);
  }
}

// One card per ipId on the whole canvas (decision: shared IPs deduplicate).
// A card is born or dies through one toggle semantics with two surfaces: the
// little IP chips in the task rows and the drawer's "IPs on canvas" toggles.
// Toggling on spawns the card in the column right of the project card —
// stacked below the cards already shown there — and wires the current task's
// edge; toggling off drops the edge and lets the visibility prune remove the
// card (a pinned card, or one another task still wires, stays). A card that
// was pruned earlier keeps its position in viewState.pos and reappears
// exactly there.
function toggleIpCardForTask(task, ipId) {
  const key = `i:${ipId}`;
  const linked = (viewState.ipCardLinks.get(ipId) || new Set()).has(task.key);
  if (linked) {
    removeTaskIpEdge(task.key, ipId);
    pruneHiddenIpCards();   // drops the card unless a link or a pin keeps it
  } else {
    const saved = viewState.pos.get(key);
    ensureIpNode(ipId);
    if (saved) {
      applyNodePos(key, saved.x, saved.y);   // back to its last spot
    } else {
      const anchor = taskAnchor(task.key);
      const projectRect = rectOf(`p:${task.project}`);
      const x = projectRect ? projectRect.right + L.gap : Math.max(L.pad, anchor.x + L.gap);
      let y = Math.max(0, anchor.y - 40);
      for (const shownId of viewState.spawnOrder) {
        if (shownId === ipId) continue;
        const r = rectOf(`i:${shownId}`);
        if (r && Math.abs(r.x - x) < L.gap) y = Math.max(y, r.bottom + L.gap);
      }
      applyNodePos(key, x, y);
    }
    measureNode(key);
    addTaskIpEdge(task.key, ipId);
    // The new card (and its project) anchor; everything they cover glides
    // away — IP cards give way downward (L.stackBias) so the column grows
    // vertically instead of scattering sideways.
    resolveCollisions([`p:${task.project}`, key]);
  }
  repaintAllEdges();
  refreshIpChipStates();   // both toggle surfaces re-read ipCardLinks
  saveStateDebounced();
}

// Create the card of one IP (no-op when it exists already); caller owns the
// position. A fresh card under an active search is dimmed when it misses.
function ensureIpNode(ipId) {
  const key = `i:${ipId}`;
  const existing = viewState.els.get(key);
  if (existing) return existing;
  const row = ipRow(ipId);
  const node = renderIpCard(row);
  if (searchText && !computeSearchHits(searchText).ips.has(row.Id)) {
    node.classList.add('mm-dim');
  }
  viewState.els.set(key, node);
  const saved = viewState.pos.get(key);   // a pruned card reappears in place
  if (saved) {
    node.style.left = `${saved.x}px`;
    node.style.top = `${saved.y}px`;
  } else {
    viewState.pos.set(key, { x: 0, y: 0 });
  }
  canvasEl.appendChild(node);
  wireNodeDrag(node);
  wireNodeResize(node);
  viewState.spawnOrder.push(ipId);
  if (!viewState.ipCardLinks.has(ipId)) viewState.ipCardLinks.set(ipId, new Set());
  return node;
}

function removeTaskEdges(taskKey) {
  const keep = [];
  for (const edge of viewState.edges) {
    if (edge.from !== taskKey) { keep.push(edge); continue; }
    edge.path.remove();
    viewState.ipCardLinks.get(edge.to.slice(2))?.delete(taskKey);
    for (const key of [edge.from, edge.to]) {
      const list = viewState.linesByNode.get(key);
      if (list) list.splice(list.indexOf(edge), 1);
    }
  }
  viewState.edges = keep;
  // Defensive: a task never leaves a link behind on a card it no longer
  // touches — including cards currently pruned (invisible links, no edges).
  for (const links of viewState.ipCardLinks.values()) links.delete(taskKey);
  refreshIpChipStates();   // its chips un-press even when the card survives
}

// Drop the single edge between one task and one IP (the drawer toggle-off).
function removeTaskIpEdge(taskKey, ipId) {
  const toKey = `i:${ipId}`;
  const keep = [];
  for (const edge of viewState.edges) {
    if (edge.from !== taskKey || edge.to !== toKey) { keep.push(edge); continue; }
    edge.path.remove();
    viewState.ipCardLinks.get(ipId)?.delete(taskKey);
    for (const key of [edge.from, edge.to]) {
      const list = viewState.linesByNode.get(key);
      if (list) list.splice(list.indexOf(edge), 1);
    }
  }
  viewState.edges = keep;
}

// Visibility-driven pruning: an IP card goes when nothing keeps it — its
// links died with the deselecting tasks, or every linked task row became
// unreachable (project collapsed, search miss) — unless it is pinned.
// Scrolling never prunes (isTaskRowReachable). Pruned cards keep their
// geometry so a respawn (chip or drawer toggle) reappears in place.
function pruneHiddenIpCards() {
  let removed = false;
  for (const [ipId, links] of [...viewState.ipCardLinks]) {
    if (viewState.pinned.has(ipId)) continue;
    let keep = false;
    for (const taskKey of links) {
      if (isTaskRowReachable(taskKey, viewState.taskRowEls.get(taskKey))) { keep = true; break; }
    }
    if (keep) continue;
    viewState.ipCardLinks.delete(ipId);
    removeIpNode(ipId, { keepGeometry: true });
    removed = true;
  }
  if (removed) {
    ensureCanvasExtent();
    repaintAllEdges();
    refreshIpChipStates();   // chips of the dead cards un-press
  }
}

function removeIpNode(ipId, { keepGeometry = false } = {}) {
  const key = `i:${ipId}`;
  // Defensive: a card never leaves the canvas with a connector still on it.
  const keep = [];
  for (const edge of viewState.edges) {
    if (edge.to !== key) { keep.push(edge); continue; }
    edge.path.remove();
    const taskEdges = viewState.linesByNode.get(edge.from);
    if (taskEdges) taskEdges.splice(taskEdges.indexOf(edge), 1);
  }
  viewState.edges = keep;
  const node = viewState.els.get(key);
  if (node) node.remove();
  viewState.els.delete(key);
  if (keepGeometry) {
    // Pruned by visibility, not deleted: keep pos/size for the respawn.
  } else {
    viewState.pos.delete(key);
    viewState.size.delete(key);
    viewState.resized.delete(key);
  }
  viewState.linesByNode.delete(key);
  const at = viewState.spawnOrder.indexOf(ipId);
  if (at >= 0) viewState.spawnOrder.splice(at, 1);
}

// IP card: production chrome (card-head with .card-title + .card-ext) and the
// exact IP-view summary column set, plus the pin and the resize grip. Clicking
// the title or the empty body area opens the IP drawer (and highlights the
// other *selected* task rows sharing this IP as a side effect — rows inside
// collapsed projects are not rendered and cannot be highlighted).
function renderIpCard(row) {
  const node = mkEl('div', 'mm-node mm-node--ip entity-card');
  node.dataset.key = `i:${row.Id}`;
  node.dataset.ip = row.Id;
  node.style.width = `${L.ipW}px`;
  if (viewState.pinned.has(row.Id)) node.classList.add('mm-pinned');

  const head = mkEl('div', 'card-head');
  // Logo of the repository this IP points at (cfg/repo-stats.json, written by
  // scripts/fetch_repo_stats.py) — the shared buildRepoLogoImg widget from
  // script.js, so the IP-view grid card and this card cannot drift apart.
  const logo = buildRepoLogoImg(row, 'mm-ip-logo');
  if (logo) head.appendChild(logo);
  const title = mkEl('button', 'card-title', row.Name);
  title.type = 'button';
  title.setAttribute('aria-haspopup', 'dialog');   // title opens the drawer
  title.title = 'Open IP details; highlights the selected tasks sharing this IP';
  title.addEventListener('click', () => {
    if (movedSincePointerDown(node)) return;
    highlightSharingTasks(row.Id);
    openDetailDrawer('ip', row);
  });
  head.appendChild(title);
  if (isValidUrl(row.URL)) head.appendChild(cardExtLink(row.URL));
  head.appendChild(pinControl(node, row.Id));
  node.appendChild(head);

  const meta = mkEl('div', 'card-meta');
  // The exact meta rows of an IP-view grid card: same column set, same
  // widgets, same "no row without a value" rule — one shared emitter.
  renderCardMetaRows(meta, row, COLUMN_SETS.ip, 'Name');
  node.appendChild(meta);

  node.appendChild(resizeGrip());

  node.addEventListener('click', e => {
    if (e.target.closest('a[href], button, label, input')) return;
    if (movedSincePointerDown(node)) return;   // the gesture was a drag
    highlightSharingTasks(row.Id);
    openDetailDrawer('ip', row);
  });
  return node;
}

// Pin checkbox inside the card head (an absolute corner box would collide with
// .card-ext): keeps the card once every task touching it is deselected.
function pinControl(node, ipId) {
  const checkbox = mkEl('input');
  checkbox.type = 'checkbox';
  checkbox.checked = viewState.pinned.has(ipId);
  checkbox.id = `mm-pin-${ipId}`;
  checkbox.addEventListener('click', e => e.stopPropagation());
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) viewState.pinned.add(ipId);
    else viewState.pinned.delete(ipId);
    node.classList.toggle('mm-pinned', checkbox.checked);
    // Unpinning hands the card back to the visibility prune: without a
    // visible link (or any link at all) its stay is over.
    if (!checkbox.checked) pruneHiddenIpCards();
    saveStateDebounced();
  });
  const pinLabel = mkEl('label', 'mm-pin');
  pinLabel.htmlFor = checkbox.id;
  pinLabel.appendChild(checkbox);
  pinLabel.appendChild(mkEl('span', null, 'Pin'));
  return pinLabel;
}

function highlightSharingTasks(ipId) {
  clearSharedHighlight();
  for (const task of refsByIp.get(ipId) || []) {
    if (!isTaskSelected(task.key)) continue;
    const rowInfo = viewState.taskRowEls.get(task.key);
    if (rowInfo) rowInfo.el.classList.add('mm-highlight');
  }
}

function clearSharedHighlight() {
  canvasEl.querySelectorAll('.mm-highlight').forEach(n => n.classList.remove('mm-highlight'));
}

// ---------------------------------------------------------------------------
// Search — dim, don't remove
// ---------------------------------------------------------------------------

// The canvas keeps its layout stable: non-matching whole cards fade to grey
// ghosts and only task rows (which live inside a card) leave the layout. The
// hit sets are script.js computeSearchHits(searchText) — the exact rows the
// status line counts and the grid keeps — so both layouts answer to one needle.
let searchLayoutSig = '';   // the hit-set the layout was last solved for

function applySearch() {
  if (!built) return;
  const on = !!searchText;
  const hits = computeSearchHits(searchText);

  for (const project of projectNodes) {
    const card = viewState.els.get(project.key);
    if (card) card.classList.toggle('mm-dim', on && !hits.projects.has(project.name));
    for (const task of project.tasks) {
      const info = viewState.taskRowEls.get(task.key);
      if (info) info.el.classList.toggle('mm-row-hidden', on && !hits.tasks.has(task.row));
    }
  }
  for (const [key, nodeEl] of viewState.els) {
    if (key.startsWith('i:')) nodeEl.classList.toggle('mm-dim', on && !hits.ips.has(key.slice(2)));
  }

  pruneHiddenIpCards();
  repaintAllEdges();

  // Only a changed hit-set changes card heights (hidden rows leave the flow),
  // so the expensive sweep runs on that change, not on every keystroke.
  const sig = on ? [...hits.tasks].map(taskKeyOf).sort().join('|') : '';
  if (sig !== searchLayoutSig) {
    searchLayoutSig = sig;
    for (const project of projectNodes) {
      if (viewState.els.get(project.key)) measureNode(project.key);
    }
    resolveCollisions([]);
  }
}

// ---------------------------------------------------------------------------
// Rounded orthogonal Task→IP connectors.
// Task anchor: right edge of the task row (the row lives inside the project
// card, so its position is the project pos + offsetTop within it, minus the
// task list's own scroll offset). IP anchor: the card edge facing the task.
// ---------------------------------------------------------------------------
function taskAnchor(taskKey) {
  const info = viewState.taskRowEls.get(taskKey);
  if (!info) return { x: 0, y: 0 };
  const p = viewState.pos.get(info.projectKey) || { x: 0, y: 0 };
  const list = info.el.closest('.mm-project-tasks');
  const scrolled = list ? list.scrollTop : 0;
  return {
    x: p.x + (info.el.offsetLeft || 0) + info.el.offsetWidth,
    y: p.y + info.el.offsetTop - scrolled + info.el.offsetHeight / 2
  };
}

// Attach to the side of the IP card facing the task row, so a card that the
// collision solver pushed past (or left of) its project still routes sanely.
function ipAnchor(ipKey, fromX = Infinity) {
  const p = viewState.pos.get(ipKey) || { x: 0, y: 0 };
  const s = viewState.size.get(ipKey) || { w: 0, h: 0 };
  const fromLeft = fromX <= p.x + s.w / 2;
  return { x: fromLeft ? p.x : p.x + s.w, y: p.y + s.h / 2 };
}

// Elbow with quarter-circle corners; the elbow keeps a usable horizontal room
// even when the IP card sits left of the task row (it then runs backwards).
// Degenerate |dy| collapses the arcs into a straight run.
function ipEdgePath(from, to) {
  const { x: x1, y: y1 } = from;
  const { x: x2, y: y2 } = to;
  const dir = x2 >= x1 ? 1 : -1;
  const midX = x1 + dir * Math.max(L.edgeMidGap, Math.abs(x2 - x1) / 2);
  const r = Math.max(0, Math.min(12, Math.abs(y2 - y1) / 2, Math.abs(midX - x1) / 2));
  const sign = y2 < y1 ? -1 : 1;
  return `M ${x1.toFixed(1)} ${y1.toFixed(1)} ` +
    `L ${(midX - dir * r).toFixed(1)} ${y1.toFixed(1)} ` +
    `Q ${midX.toFixed(1)} ${y1.toFixed(1)} ${midX.toFixed(1)} ${(y1 + sign * r).toFixed(1)} ` +
    `L ${midX.toFixed(1)} ${(y2 - sign * r).toFixed(1)} ` +
    `Q ${midX.toFixed(1)} ${y2.toFixed(1)} ${(midX + dir * r).toFixed(1)} ${y2.toFixed(1)} ` +
    `L ${x2.toFixed(1)} ${y2.toFixed(1)}`;
}

// Registering the link is part of wiring it: a card stays alive while some
// wired task row (chip or drawer toggle) remains reachable — or it is pinned.
function addTaskIpEdge(taskKey, ipId) {
  const toKey = `i:${ipId}`;
  if (!viewState.ipCardLinks.has(ipId)) viewState.ipCardLinks.set(ipId, new Set());
  viewState.ipCardLinks.get(ipId).add(taskKey);
  if (viewState.edges.some(e => e.from === taskKey && e.to === toKey)) return;
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('class', 'mm-line mm-line--ip');
  svgEl.appendChild(path);
  const edge = { from: taskKey, to: toKey, path };
  viewState.edges.push(edge);
  for (const key of [taskKey, toKey]) {
    if (!viewState.linesByNode.has(key)) viewState.linesByNode.set(key, []);
    viewState.linesByNode.get(key).push(edge);
  }
  paintEdge(edge);
}

function paintEdge(edge) {
  const info = viewState.taskRowEls.get(edge.from);
  if (!info || !viewState.els.has(edge.to)) return;
  // While the stage is hidden every anchor offset reads 0 — writing those
  // degenerate paths would leave the connectors mis-anchored on the way back;
  // setActive() repaints all edges once the stage is laid out.
  if (!stageLive()) return;
  const from = taskAnchor(edge.from);
  edge.path.setAttribute('d', ipEdgePath(from, ipAnchor(edge.to, from.x)));
  // Ghosting: everything but the most recent selection fades back so the
  // newest pick stands out (the selected set is kept oldest-first).
  edge.path.classList.toggle('mm-edge--ghost', edge.from !== viewState.selected.at(-1));
  edge.path.classList.toggle('mm-edge--hidden', !isTaskRowVisible(edge.from, info));
}

// Visibility for pruning purposes: the row exists, is not hidden by the
// search and its project card is expanded. Deliberately scroll-agnostic — a
// merely scrolled-out row must not destroy its IP card on an unrelated
// prune trigger; only the connector hides while it is out of view.
function isTaskRowReachable(taskKey, info) {
  if (!info || !info.el.isConnected) return false;
  if (info.el.classList.contains('mm-row-hidden')) return false;
  const list = info.el.closest('.mm-project-tasks');
  return !!list && !list.hidden;
}

// Visibility for connector anchoring: reachable and scrolled into the task
// list's viewport — an anchor off-screen cannot be drawn sanely.
function isTaskRowVisible(taskKey, info) {
  if (!isTaskRowReachable(taskKey, info)) return false;
  const list = info.el.closest('.mm-project-tasks');
  const top = info.el.offsetTop - list.offsetTop;   // row offset inside the list
  return top + info.el.offsetHeight >= list.scrollTop
    && top <= list.scrollTop + list.clientHeight + 1;
}

function repaintAllEdges() {
  for (const edge of viewState.edges) paintEdge(edge);
}

function repaintProjectEdges(project) {
  for (const task of project.tasks) {
    for (const edge of viewState.linesByNode.get(task.key) || []) paintEdge(edge);
  }
}

// ---------------------------------------------------------------------------
// Dragging, resizing & panning — same guarded setPointerCapture pattern as the
// editor.js column resizer; no rAF loop, endpoints are rewritten on every
// pointermove (resize coalesces through one rAF flag).
// ---------------------------------------------------------------------------
function wireNodeDrag(nodeEl) {
  const key = nodeEl.dataset.key;
  // Task→IP edges hang off task rows (inside project cards) and IP cards, so
  // dragging a project card repaints its own tasks' edges explicitly.
  const project = key.startsWith('p:') ? projectNodes.find(p => p.key === key) : null;
  let start = null;
  let dragging = false;
  nodeEl.mmDragMoved = false;
  const onMove = e => {
    const p = viewState.pos.get(key);
    const dx = e.clientX - start.cx;
    const dy = e.clientY - start.cy;
    if (!dragging && Math.abs(dx) > 3 || !dragging && Math.abs(dy) > 3) {
      dragging = true;
      nodeEl.mmDragMoved = true;
      // The dragged card must follow the pointer un-animated; only the
      // solver's later moves glide (CSS .mm-node transition).
      nodeEl.classList.add('mm-dragging');
      // Capture only once this is a drag: capturing on pointerdown would
      // retarget the click that ends a plain click on a button inside the card
      // (card title, the IP card's task links).
      try { nodeEl.setPointerCapture && nodeEl.setPointerCapture(e.pointerId); } catch (_) { /* guarded */ }
    }
    if (!dragging) return;
    p.x = start.x + dx;
    p.y = start.y + dy;
    nodeEl.style.left = `${p.x}px`;
    nodeEl.style.top = `${p.y}px`;
    for (const edge of viewState.linesByNode.get(key) || []) paintEdge(edge);
    if (project) repaintProjectEdges(project);
  };
  const onUp = e => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    dragging = false;
    nodeEl.classList.remove('mm-dragging');
    if (nodeEl.mmDragMoved) {
      applyNodePos(key, viewState.pos.get(key).x, viewState.pos.get(key).y);
      ensureCanvasExtent();
      // The dropped card keeps its spot; whatever it now covers moves away.
      resolveCollisions([key]);
      saveStateDebounced();
    }
    try { nodeEl.releasePointerCapture && nodeEl.releasePointerCapture(e.pointerId); } catch (_) { /* guarded like editor.js */ }
  };
  nodeEl.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    // Interactive children (caret, links, task rows, pin, grip) own their gestures.
    if (e.target.closest('a[href], input, label, .mm-task-row, .uap-caret, .mm-resize')) return;
    e.preventDefault();
    const p = viewState.pos.get(key);
    start = { x: p.x, y: p.y, cx: e.clientX, cy: e.clientY };
    nodeEl.mmDragMoved = false;
    dragging = false;
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
}

// A drag release still fires a click on the card; the moved flag keeps that
// synthetic click from being mistaken for a card-title expand or an "inspect
// shared IPs" click. It is consumed here (one-shot), so a later keyboard
// activation of the same control after an unrelated drag still works.
function movedSincePointerDown(nodeEl) {
  const moved = !!nodeEl.mmDragMoved;
  nodeEl.mmDragMoved = false;
  return moved;
}

// Bottom-right grip: drag to set a manual size, double-click / Enter to drop
// it again (auto-fit). Keyboard: arrows resize, ±10px (±40px with Shift).
function wireNodeResize(nodeEl) {
  const key = nodeEl.dataset.key;
  const grip = nodeEl.querySelector('.mm-resize');
  if (!grip) return;
  let start = null;
  let frame = 0;

  const apply = (w, h) => {
    nodeEl.style.width = `${w}px`;
    nodeEl.style.height = `${h}px`;
    nodeEl.classList.add('mm-sized');   // a manual size lifts the task-list cap
    viewState.resized.add(key);
    measureNode(key);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      resolveCollisions([key]);
    });
  };
  const onMove = e => {
    apply(
      clamp(Math.round(start.w + (e.clientX - start.cx)), L.minW, L.maxW),
      clamp(Math.round(start.h + (e.clientY - start.cy)), L.minH, L.maxH)
    );
  };
  const onUp = e => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    if (frame) { cancelAnimationFrame(frame); frame = 0; resolveCollisions([key]); }
    saveStateDebounced();
    try { grip.releasePointerCapture && grip.releasePointerCapture(e.pointerId); } catch (_) { /* guarded */ }
  };
  grip.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();   // the card drag must never start from the grip
    const size = viewState.size.get(key) || { w: nodeEl.offsetWidth, h: nodeEl.offsetHeight };
    start = { w: size.w, h: size.h, cx: e.clientX, cy: e.clientY };
    try { grip.setPointerCapture && grip.setPointerCapture(e.pointerId); } catch (_) { /* guarded */ }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
  grip.addEventListener('dblclick', e => {
    e.stopPropagation();
    clearNodeSize(key);
  });
  grip.addEventListener('keydown', e => {
    const step = e.shiftKey ? 40 : 10;
    const size = viewState.size.get(key) || { w: nodeEl.offsetWidth, h: nodeEl.offsetHeight };
    if (e.key === 'Enter') { e.preventDefault(); clearNodeSize(key); return; }
    if (e.key === 'ArrowRight') apply(clamp(size.w + step, L.minW, L.maxW), size.h);
    else if (e.key === 'ArrowLeft') apply(clamp(size.w - step, L.minW, L.maxW), size.h);
    else if (e.key === 'ArrowDown') apply(size.w, clamp(size.h + step, L.minH, L.maxH));
    else if (e.key === 'ArrowUp') apply(size.w, clamp(size.h - step, L.minH, L.maxH));
    else return;
    e.preventDefault();   // arrows belong to the card, not to the scrollbars
    saveStateDebounced();
  });
  grip.addEventListener('click', e => e.stopPropagation());
}

// Drop the manual size — on both axes — and let the card auto-fit its content.
function clearNodeSize(key) {
  const nodeEl = viewState.els.get(key);
  if (!nodeEl) return;
  nodeEl.style.width = '';
  nodeEl.style.height = '';
  nodeEl.classList.remove('mm-sized');
  viewState.resized.delete(key);
  measureNode(key);
  resolveCollisions([key]);
  saveStateDebounced();
}

// Drag on the empty stage background drags the content around, i.e. it scrolls
// the stage — the same thing the (native) scrollbars do.
function wireStagePan() {
  let start = null;
  const onMove = e => {
    stageEl.scrollLeft = start.sl - (e.clientX - start.cx);
    stageEl.scrollTop = start.st - (e.clientY - start.cy);
  };
  const onUp = () => {
    stageEl.classList.remove('mm-panning');
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    saveStateDebounced();
  };
  stageEl.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    if (e.target.closest('.mm-node')) return;   // node drag owns its gesture
    e.preventDefault();
    start = { sl: stageEl.scrollLeft, st: stageEl.scrollTop, cx: e.clientX, cy: e.clientY };
    stageEl.classList.add('mm-panning');
    try { stageEl.setPointerCapture && stageEl.setPointerCapture(e.pointerId); } catch (_) { /* guarded */ }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
}

// ---------------------------------------------------------------------------
// Persistence — sessionStorage (positions, manual sizes, scroll, expanded,
// selection, pins); localStorage stays reserved for the theme. Edges/IP cards
// are rebuilt through the normal spawn path, never stored.
// ---------------------------------------------------------------------------
let saveTimer = null;
function saveStateDebounced() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 300);
}

function saveState() {
  try {
    const pos = {};
    for (const [key, p] of viewState.pos) pos[key] = { x: Math.round(p.x), y: Math.round(p.y) };
    const size = {};
    for (const key of viewState.resized) {
      const s = viewState.size.get(key);
      if (s) size[key] = { w: s.w, h: s.h };
    }
    sessionStorage.setItem(STATE_STORAGE_KEY, JSON.stringify({
      v: STATE_VERSION,
      pos,
      size,
      // a hidden stage reports a scroll of 0 — keep the offset that was live
      // before the layout switch
      scroll: !stageLive()
        ? { x: lastStageScroll.x, y: lastStageScroll.y }
        : { x: stageEl.scrollLeft, y: stageEl.scrollTop },
      expanded: [...viewState.expanded],
      selected: [...viewState.selected],
      pinned: [...viewState.pinned],
      // the Canvas | Grid choice belongs to the same payload
      layout: savedLayout
    }));
  } catch { /* best effort */ }
}

function restoreState() {
  try {
    const raw = sessionStorage.getItem(STATE_STORAGE_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw);
    return state && state.v === STATE_VERSION ? state : null;
  } catch {
    return null;
  }
}

function applyRestoredState(state) {
  // Manual sizes change the card boxes the layout then places. Idempotent —
  // the mm-sized class marks what a pass already applied — because IP cards
  // only exist after the selection restore, so this runs once before and once
  // after the spawns (exactly like the saved-position passes below).
  const applySize = (key, s) => {
    const nodeEl = viewState.els.get(key);
    if (!nodeEl || nodeEl.classList.contains('mm-sized')) return;
    if (!Number.isFinite(s?.w) || !Number.isFinite(s?.h)) return;
    nodeEl.style.width = `${clamp(s.w, L.minW, L.maxW)}px`;
    nodeEl.style.height = `${clamp(s.h, L.minH, L.maxH)}px`;
    nodeEl.classList.add('mm-sized');
    viewState.resized.add(key);
    measureNode(key);
  };
  if (state.size) {
    for (const [key, s] of Object.entries(state.size)) applySize(key, s);
  }
  if (state.pos) {
    for (const [key, p] of Object.entries(state.pos)) {
      if (typeof p?.x !== 'number' || typeof p?.y !== 'number') continue;
      if (!viewState.els.has(key)) continue;   // IP cards are re-spawned via selection
      applyNodePos(key, p.x, p.y);
    }
  }
  for (const projectKey of asArray(state.expanded)) {
    const project = projectNodes.find(p => p.key === projectKey);
    if (!project) continue;
    setProjectExpanded(project, true);
  }
  for (const ipId of asArray(state.pinned)) viewState.pinned.add(ipId);
  for (const taskKey of asArray(state.selected)) {
    if (viewState.taskRowEls.has(taskKey) && !isTaskSelected(taskKey)) selectTask(taskKey);
  }
  // The selection restore just created the IP cards, so their saved positions
  // (which did not exist yet in the pass above) are applied here.
  if (state.pos) {
    for (const [key, p] of Object.entries(state.pos)) {
      if (typeof p?.x !== 'number' || typeof p?.y !== 'number') continue;
      if (!key.startsWith('i:') || !viewState.els.has(key)) continue;
      applyNodePos(key, p.x, p.y);
    }
  }
  // Pinned cards with no selected task had no spawn anchor; keep them alive as
  // standalone cards in a fresh column right of everything else.
  const stray = asArray(state.pinned).filter(ipId => !viewState.els.has(`i:${ipId}`));
  if (stray.length) {
    let x = L.pad;
    for (const key of viewState.els.keys()) {
      const r = rectOf(key);
      if (r) x = Math.max(x, r.right + L.gap);
    }
    let y = L.pad;
    for (const ipId of stray) {
      const key = `i:${ipId}`;
      ensureIpNode(ipId);
      viewState.ipCardLinks.set(ipId, new Set());
      const size = measureNode(key) || { h: L.minH };
      // Keep the card's saved spot when it has one (the position passes above
      // ran before this spawn); otherwise stack it in the fresh column. The
      // final repair sweep untangles whatever the restored boxes now share.
      const saved = state.pos && state.pos[key];
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) applyNodePos(key, saved.x, saved.y);
      else { applyNodePos(key, x, y); y += size.h + L.gap; }
    }
  }
  // The selection/pinned restore above created the IP cards, so their saved
  // sizes (skipped by the first pass, like the first position pass was) land
  // here — before the repair sweep, which settles any card the new boxes now
  // overlap.
  if (state.size) {
    for (const [key, s] of Object.entries(state.size)) applySize(key, s);
  }
  // One repair sweep: positions saved by an older build (which allowed free
  // overlap) are untangled instead of stacking cards on cards.
  resolveCollisions([]);
  if (Number.isFinite(state.scroll?.x) && Number.isFinite(state.scroll?.y)) {
    stageEl.scrollLeft = state.scroll.x;
    stageEl.scrollTop = state.scroll.y;
    lastStageScroll = { x: state.scroll.x, y: state.scroll.y };
  }
  }



// ---------------------------------------------------------------------------
// Detail drawer integration
// ---------------------------------------------------------------------------

// script.js renders the drawer; the canvas only adds what is worth adding while
// it is on top of the canvas: the show/hide toggles of a task's IPs (the drawer
// surface of the task-row chips) and a "Show on canvas" jump on an IP drawer.
document.addEventListener('uap:drawer-render', e => {
  const detail = e && e.detail;
  if (!canvasActive || !detail || !drawerBody || !detail.row) return;
  if (detail.kind === 'task') decorateTaskDrawer(detail.row);
  else if (detail.kind === 'ip') decorateIpDrawer(detail.row);
});

// Right below the field block, above the drawer's own relationship sections.
function insertIntoDrawer(node) {
  const fields = drawerBody.querySelector('.drawer-fields');
  if (fields && fields.nextSibling) drawerBody.insertBefore(node, fields.nextSibling);
  else drawerBody.appendChild(node);
}

function decorateTaskDrawer(row) {
  const task = taskNodeFor(row);
  if (!task || !task.ipIds.length) return;
  const list = mkEl('div', 'mm-drawer-ips');
  const section = mkEl('div');
  section.appendChild(mkEl('h3', 'drawer-section-title', 'IPs on canvas'));
  section.appendChild(mkEl('p', 'mm-drawer-hint',
    'Click to show or hide the IP card on the canvas.'));
  section.appendChild(list);
  insertIntoDrawer(section);

  // "On" means this task currently has a wired edge to the card — a shared IP
  // survives another task's toggle-off, and a pinned card outlives every link,
  // exactly like the task-row chips mirror it.
  const renderToggles = () => {
    list.textContent = '';
    for (const ipId of task.ipIds) {
      const on = (viewState.ipCardLinks.get(ipId) || new Set()).has(task.key);
      const btn = mkEl('button', 'mm-ip-toggle' + (on ? ' is-on' : ''));
      btn.type = 'button';
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.appendChild(icon(on ? 'fas fa-check' : 'fas fa-plus'));
      btn.appendChild(mkEl('span', null, ipDisplayName(ipId)));
      btn.appendChild(mkEl('span', 'mm-ip-toggle-state', on ? 'On canvas' : 'Show on canvas'));
      btn.addEventListener('click', () => {
        toggleIpCardForTask(task, ipId);
        renderToggles();          // every button re-reads the canvas state
        const again = list.querySelector(`[data-ip="${CSS.escape(ipId)}"]`);
        if (again) again.focus();  // keyboard users keep their place
      });
      btn.dataset.ip = ipId;
      list.appendChild(btn);
    }
  };
  renderToggles();
}

function decorateIpDrawer(row) {
  const actions = mkEl('div', 'mm-drawer-actions');
  const btn = mkEl('button', 'mm-drawer-action');
  btn.type = 'button';
  btn.appendChild(icon('fas fa-diagram-project'));
  btn.appendChild(mkEl('span', null, 'Show on canvas'));
  btn.addEventListener('click', () => {
    closeDetailDrawer();
    revealIp(row.Id);
  });
  actions.appendChild(btn);
  insertIntoDrawer(actions);
}

// ---------------------------------------------------------------------------
// Toolbar & keyboard
// ---------------------------------------------------------------------------
resetBtn.addEventListener('click', () => {
  try {
    sessionStorage.removeItem(STATE_STORAGE_KEY);
  } catch { /* best effort */ }
  viewState.pinned.clear();
  viewState.ipCardLinks.clear();
  viewState.resized.clear();
  // buildView() needs a visible stage to measure against — and it starts by
  // clearing the selection and restoring nothing, i.e. the initial layout.
  buildView();
  lastStageScroll = { x: 0, y: 0 };
  stageEl.scrollLeft = 0;
  stageEl.scrollTop = 0;
  // Store the fresh default right away (the zeroing above also fires the async
  // scroll listener, which would otherwise re-create the key ~300 ms later).
  saveState();
  });

clearBtn.addEventListener('click', () => clearSelection());

// Webfont metrics land after first paint: the uniform project width was then
// measured with fallback glyphs, so titles can end up truncated and measured
// heights slightly short (which re-admits overlaps). Once the fonts settle,
// re-derive the width — manually resized cards never contribute, a user size
// always wins — then re-measure every card and re-solve the collisions. If the
// fonts arrive before buildView() ran, the build measured with the final
// metrics anyway and this refresh is a no-op.
function refreshAfterFonts() {
  if (!projectNodes.length || !viewState.els.size) return;
  // A hidden stage measures zero — re-deriving the uniform width then would
  // collapse every card to the minimum. Defer it until the canvas is shown
  // again (setActive flushes the pending flag).
  if (!canvasActive || !stageLive()) { pendingFontRefresh = true; return; }
  if (!projectNodes.some(p => viewState.resized.has(p.key))) {
    const w = computeProjectWidth();
    if (w !== L.projectW) {
      L.projectW = w;
      document.documentElement.style.setProperty('--mm-project-w', `${w}px`);
      for (const project of projectNodes) {
        viewState.els.get(project.key).style.width = `${w}px`;
      }
    }
  }
  for (const key of viewState.els.keys()) measureNode(key);
  resolveCollisions([]);
}

// ---------------------------------------------------------------------------
// Layout activation — driven by the production Canvas | Grid switch
// ---------------------------------------------------------------------------

// A hidden stage measures 0 everywhere — both because the Grid layout hides it
// and because the compatibility-matrix tab hides the whole catalogue.
function stageLive() {
  return !!stageEl && !stageEl.hidden && stageEl.offsetParent !== null;
}

function readStoredState() {
  try {
    const raw = sessionStorage.getItem(STATE_STORAGE_KEY);
    if (!raw) return {};
    const state = JSON.parse(raw);
    return state && state.v === STATE_VERSION ? state : {};
  } catch {
    return {};
  }
}

// The Canvas | Grid choice, read back by script.js on boot. Reading also
// refreshes savedLayout, so a save can never rewrite a stored "grid".
function getLayout() {
  savedLayout = readStoredState().layout === 'grid' ? 'grid' : 'canvas';
  return savedLayout;
}

// The layout switch must never overwrite a stored layout's geometry with an
// empty payload: switching layouts changes no geometry at all, and before the
// first build there is none to write — so this is a read-modify-write, not a
// saveState().
function saveLayout(layout) {
  savedLayout = layout === 'grid' ? 'grid' : 'canvas';
  const state = readStoredState();
  state.v = STATE_VERSION;
  state.layout = savedLayout;
  try {
    sessionStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(state));
  } catch { /* best effort */ }
}

function buildViewNow() {
  built = true;
  needsBuild = false;
  buildView();     // ends with a forced applySearch()
}

// script.js calls this after every dataset change — the catalogue load and the
// local-file preview (which empties the datasets before a new file arrives).
function onCatalogLoaded() {
  buildModel();
  built = false;
  needsBuild = true;
  if (canvasActive && stageLive()) buildViewNow();
}

function setActive(nextActive) {
  if (nextActive === canvasActive) {
    // Called again after the compatibility matrix hid the page: the canvas is
    // still the layout of choice, but it measured nothing while it was hidden.
    if (nextActive) restoreAfterShow();
    return;
  }
  canvasActive = nextActive;
  if (!nextActive) {
    if (!built) return;   // nothing to remember — never flush an empty payload
    if (stageLive()) lastStageScroll = { x: stageEl.scrollLeft, y: stageEl.scrollTop };
    saveState();
    return;
  }
  if (!built || needsBuild) buildViewNow();   // needs a visible stage to measure
  restoreAfterShow();
}

// Everything the hidden stage skipped: the honest card sizes, the scroll
// offset, a collision sweep (a search run while hidden can have re-shown task
// rows, so cards may have GROWN back since they were last sized) and a font
// refresh deferred while the canvas was off screen.
function restoreAfterShow() {
  if (!built || !stageLive()) return;
  for (const key of viewState.els.keys()) measureNode(key);
  stageEl.scrollLeft = lastStageScroll.x;
  stageEl.scrollTop = lastStageScroll.y;
  searchLayoutSig = '\u0000';
  applySearch();
  if (pendingFontRefresh) {
    pendingFontRefresh = false;
    refreshAfterFonts();
  }
}

// Show one IP card on the canvas from its detail drawer. A revealed card has no
// task edge that could keep it alive, so it arrives pinned: its own Pin box
// reads as pressed, and un-pinning it is the way to drop it again.
function revealIp(ipId) {
  if (!canvasActive || !built || !stageLive()) return;
  const key = `i:${ipId}`;
  if (!viewState.els.has(key)) {
    const hadPosition = viewState.pos.has(key);   // a pruned card comes back in place
    ensureIpNode(ipId);
    const node = viewState.els.get(key);
    if (!node) return;
    viewState.pinned.add(ipId);
    node.classList.add('mm-pinned');
    const pin = node.querySelector('.mm-pin input');
    if (pin) pin.checked = true;
    if (!hadPosition) {
      let x = L.pad;
      for (const liveKey of viewState.els.keys()) {
        if (liveKey === key) continue;
        const rect = rectOf(liveKey);
        if (rect) x = Math.max(x, rect.right + L.gap);
      }
      applyNodePos(key, x, L.pad);
    }
    measureNode(key);
    resolveCollisions([key]);
  }
  const node = viewState.els.get(key);
  node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  node.classList.add('mm-highlight');
  setTimeout(() => node.classList.remove('mm-highlight'), 1200);
  repaintAllEdges();
  saveStateDebounced();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
let edgeRepaintFrame = 0;

function boot() {
  // The Canvas | Grid choice lives in this payload: read it back before
  // anything can save, so a later save never rewrites a stored "grid".
  getLayout();
  wireStagePan();
  // The collision solver glides displaced cards to their free spot; the SVG
  // connectors must follow the glide, not only the destination. Repaints are
  // rAF-coalesced — one burst of transitionend events means one repaint.
  canvasEl.addEventListener('transitionend', e => {
    if (!e.target.classList || !e.target.classList.contains('mm-node')) return;
    if (e.propertyName !== 'left' && e.propertyName !== 'top') return;
    if (edgeRepaintFrame) return;
    edgeRepaintFrame = requestAnimationFrame(() => {
      edgeRepaintFrame = 0;
      repaintAllEdges();
    });
  });
  // The stage scrolls natively; keep the saved offset and the canvas extent
  // honest. The last live offset is remembered because a hidden stage (Grid
  // layout, or the matrix tab) reports a scroll position of zero.
  stageEl.addEventListener('scroll', () => {
    // A hidden stage reports a scroll of 0 — such a spurious event must not
    // clobber the last live offset.
    if (!stageLive()) return;
    lastStageScroll = { x: stageEl.scrollLeft, y: stageEl.scrollTop };
    saveStateDebounced();
  }, { passive: true });
  window.addEventListener('resize', () => ensureCanvasExtent());
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(refreshAfterFonts);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

// ---------------------------------------------------------------------------
// The only surface script.js may use. Every call site there is optional
// (window.UapCanvas?.…), so the page keeps working without this module.
// ---------------------------------------------------------------------------
window.UapCanvas = {
  getLayout,
  saveLayout,
  onCatalogLoaded,
  setActive,
  applySearch,
  clearSelection,
  revealTask,
  revealIp
};

})();
