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

// Projects view PREVIEW (prototype) — prototype-mindmap.html
//
// Non-production preview of a redesigned Projects view, reachable from a
// subtle link on the Platform page. One unified view: Project cards float on a
// scrollable canvas in a responsive grid; every card is a production
// .entity-card (same chrome, same meta-row idiom) and is user-resizable by
// its bottom-right grip. Card heads follow one click contract: the title
// opens the detail drawer (Project, Task or IP — the same drawers as the
// Platform page), the caret expands a project's task list. The IPs listed in
// a task row are little clickable cards: clicking a chip spawns that IP card
// on the canvas, clicking the pressed chip again hides it — the Task drawer's
// actionable "IPs" section is the second surface of the same toggle. The
// cards are wired by rounded orthogonal dashed lines and show exactly the
// IP-view summary columns of the Platform page. A live search dims
// non-matching cards and hides non-matching task rows; an unpinned IP card
// whose every linked task row became unreachable (project collapsed, search
// miss - never mere scrolling) is dropped, and re-toggling its chip respawns
// it in place.
// Cards are
// laid out collision-free: a spawn/expand/resize/drop displaces whatever it
// now covers by the least amount (IP cards prefer stacking downward) and the
// displaced cards glide to their free spot. Pinning an IP card keeps it after
// every linked task is deselected.
// The toolbar switches between two views of the same contents: the Canvas
// described above, and a Table view — Projects, Tasks and IPs as sortable
// tables that can be exported to CSV, or to a ZIP archive holding one CSV
// per table (the rows the current search leaves visible).
// Reads cfg/catalog.json + cfg/projects.json + cfg/repo-stats.json — the same
// runtime data the Platform page uses. Nothing here feeds back into the
// catalogue.

const CATALOG_URL  = 'cfg/catalog.json';
const PROJECTS_URL = 'cfg/projects.json';
const REPO_STATS_URL = 'cfg/repo-stats.json';
// Session-scoped view state (positions, manual sizes, scroll, expanded,
// selection, pins, view mode, table tab). localStorage stays reserved for the theme
// (scripts/theme.js); the retired 'uap-proto-view' key from the old Tree|Map
// prototype is simply ignored (and purged by "Reset view").
const STATE_STORAGE_KEY = 'uap-proto-state';
const STATE_VERSION = 2;
const SVG_NS = 'http://www.w3.org/2000/svg';

// Summary columns of an IP card, in the production IP-view order (script.js
// COLUMN_SETS.ip). "Name" is the card title, the rest become meta rows.
const IP_CARD_COLUMN  = 'IP Card';
const REPO_STATS_COLUMN = 'Repo Stats';
const IP_COLUMNS = ['Name', 'Category', 'Owners', 'License', 'Status',
  IP_CARD_COLUMN, REPO_STATS_COLUMN, 'Tasks'];
// Labels of the mirrored columns (subset of script.js columnLabels).
const columnLabels = { [IP_CARD_COLUMN]: 'IP Card', 'Tasks': 'Tasks (project · WI · title)' };
// Enumerated fields rendered as pills (subset of script.js PILL_FIELDS).
const PILL_FIELDS = { License: 'license', Owners: 'owner', Partners: 'partner', Category: 'category', WI: 'wi' };
// An IP touched by dozens of tasks would otherwise produce an enormous card.
const IP_TASK_LIST_LIMIT = 5;
// Search columns per card type, mirroring matchesSearch()'s use of the view's
// own columns (script.js): Task view columns minus Project (the owning card's
// name is matched separately), IP view columns. IP cards additionally match
// their IP Card JSON/PDF URLs, the fallback matchesSearch() applies in the
// IP view.
const TASK_SEARCH_COLUMNS = ['Title', 'TaskId', 'WI', 'Status', 'Partners', 'Description', 'ipNames'];
const IP_SEARCH_COLUMNS   = ['Name', 'Id', 'Category', 'Owners', 'License', 'Status', 'Description'];

const statusEl   = document.getElementById('proto-status');
const stageEl    = document.getElementById('mm-stage');
const canvasEl   = document.getElementById('mm-canvas');
const svgEl      = document.getElementById('mm-links');
const resetBtn   = document.getElementById('proto-reset');
const clearBtn   = document.getElementById('proto-clear');
const searchEl     = document.getElementById('mm-search');
const searchClearEl = document.getElementById('mm-search-clear');
const searchCountEl = document.getElementById('mm-search-count');
const legendEl      = document.querySelector('.mm-legend');
const viewSwitchEl  = document.getElementById('proto-view-switch');
const tableRootEl   = document.getElementById('mm-table');
const tableTabsEl   = document.getElementById('mm-table-tabs');
const tablePanelEl  = document.getElementById('mm-table-panel');
const exportCsvBtn  = document.getElementById('mm-export-csv');
const exportZipBtn  = document.getElementById('mm-export-zip');
const drawerEl        = document.getElementById('detail-drawer');
const drawerOverlayEl = document.getElementById('drawer-overlay');
const drawerKindEl    = document.getElementById('drawer-kind');
const drawerTitleEl   = document.getElementById('drawer-title');
const drawerBodyEl    = document.getElementById('drawer-body');

// Search text (lower-cased, trimmed) — like production, it is view state, not
// persisted state: a reload starts from the saved canvas with a clean input.
let mmSearchText = '';

// Canvas | Table mode and the table's own presentation state. The mode and
// the active tab belong to the persisted session state; per-column sorting
// is transient view state, like the search text. The stage reports a scroll
// position of 0 while hidden, so the last live offset is remembered for the
// save.
let currentView = 'canvas';
let pendingFontRefresh = false;
let lastStageScroll = { x: 0, y: 0 };
const TABLE_KINDS = ['project', 'task', 'ip'];
let currentTableTab = 'project';
const tableSortState = {
  project: { col: 0, dir: 1 },
  task: { col: 0, dir: 1 },
  ip: { col: 0, dir: 1 }
};

const collator = new Intl.Collator(undefined, { sensitivity: 'base' });

let catalog = null;
let projectsData = [];     // cfg/projects.json entries ({ id, name, logo, url })
let projectNodes = [];     // { name, logo, url, tasks: [taskNode] }
let taskNodes = [];        // flat list of taskNode
let ipNodes = [];          // production-shaped IP rows — referenced IPs only
const ipRowById = new Map();   // ipId -> production-shaped IP row
const refsByIp = new Map();    // ipId -> [taskNode]
const ipById = new Map();      // ipId -> catalog IP record

// Repository statistics cache (mirrors script.js): null when unavailable.
let repoStats = null;
let repoStatsIndex = new Map();

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
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function icon(classes) {
  const i = el('i', classes);
  i.setAttribute('aria-hidden', 'true');
  return i;
}

function asArray(v) {
  return Array.isArray(v) ? v.filter(Boolean) : [v].filter(Boolean);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function httpUrl(v) {
  return typeof v === 'string' && /^https?:\/\//i.test(v.trim()) ? v.trim() : '';
}

// http(s)-only URL check for generated hrefs (mirrors script.js isValidUrl).
function isValidUrl(string) {
  if (!string) return false;
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Repository statistics — mirrors script.js (parse_repo_refs stays in sync
// with scripts/fetch_repo_stats.py). Copied, never imported: AGENTS.md forbids
// the prototype reusing script.js behaviour code.
// ---------------------------------------------------------------------------
const GITHUB_SLUG_RE = /(?<![A-Za-z0-9.\-])(?:www\.)?github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/g;
const GITLAB_SLUG_RE = /https?:\/\/([A-Za-z0-9.\-]*gitlab[A-Za-z0-9.\-]*)\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/gi;

function parseRepoRefs(urlValue) {
  if (!urlValue || typeof urlValue !== 'string') return [];
  const refs = [];
  const seen = new Set();
  const push = (provider, key) => {
    const lower = key.toLowerCase();
    if (seen.has(lower)) return;
    seen.add(lower);
    refs.push({ provider, key: lower });
  };
  urlValue.split(';').forEach(chunk => {
    const ghRe = new RegExp(GITHUB_SLUG_RE.source, 'g');
    let match;
    while ((match = ghRe.exec(chunk)) !== null) {
      const owner = match[1].replace(/^\.+|\.+$/g, '');
      const repo = match[2].replace(/^\.+|\.+$/g, '');
      if (!owner || !repo) continue;
      push('github', `github.com/${owner}/${repo}`);
    }
    const glRe = new RegExp(GITLAB_SLUG_RE.source, 'gi');
    while ((match = glRe.exec(chunk)) !== null) {
      const host = match[1].toLowerCase();
      if (host !== 'gitlab.com' && !host.includes('gitlab')) continue;
      const group = match[2].replace(/^\.+|\.+$/g, '');
      const project = match[3].replace(/^\.+|\.+$/g, '');
      if (!group || !project) continue;
      push('gitlab', `${host}/${group}/${project}`);
    }
  });
  return refs;
}

function lookupRepoStats(key) {
  if (!repoStatsIndex || !key) return null;
  return repoStatsIndex.get(key.toLowerCase()) || null;
}

// Merge the stats of every GitHub/GitLab repo referenced by a row's URL field.
// Returns { repos: [{key, provider, record|null}], total: {...}|null } or null
// when the row references no known repository host at all.
function getRowRepoStats(row) {
  const refs = parseRepoRefs(row ? row['URL'] : '');
  if (!refs.length) return null;

  const repos = refs.map(ref => ({ ...ref, record: lookupRepoStats(ref.key) }));
  const found = repos.filter(r => r.record).map(r => r.record);
  if (!found.length) return { repos, total: null };

  const sumField = field => {
    const values = found.map(r => r[field]).filter(v => typeof v === 'number');
    return values.length ? values.reduce((acc, v) => acc + v, 0) : null;
  };
  const licenses = [...new Set(
    found.map(r => r.license_spdx_id).filter(v => v && v !== 'NOASSERTION')
  )];
  const pushedValues = found.map(r => Date.parse(r.pushed_at)).filter(ts => !Number.isNaN(ts));
  const latestPush = pushedValues.length
    ? new Date(Math.max(...pushedValues)).toISOString()
    : null;

  return {
    repos,
    total: {
      stars: sumField('stars'),
      forks: sumField('forks'),
      commits: sumField('commits'),
      watchers: sumField('watchers'),
      open_issues: sumField('open_issues'),
      contributors: sumField('contributors'),
      pushed_at: latestPush,
      license_spdx_id: licenses.length ? licenses.join(', ') : null,
      archived: found.every(r => r.archived === true)
    }
  };
}

function formatRelativeDate(isoString) {
  const ts = Date.parse(isoString);
  if (!isoString || Number.isNaN(ts)) return 'unknown';
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (Number.isNaN(days)) return 'unknown';
  if (days < 0) return 'today';
  if (days < 31) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function formatStatNumber(value) {
  if (value === null || value === undefined) return '?';
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (value >= 10000) return `${Math.round(value / 1000)}k`;
  return value.toLocaleString('en-US');
}

function statsProviderLine(repos) {
  const records = repos.filter(r => r.record).map(r => r.record);
  if (!records.length) return null;
  const labels = [...new Set(records.map(r => {
    const provider = (r.provider || '').toLowerCase() === 'gitlab' ? 'GitLab' : 'GitHub';
    return r.host ? `${provider} · ${r.host}` : provider;
  }))];
  return labels.join(', ');
}

function statsTooltipText(total, generatedAt, providerLine) {
  const parts = [];
  if (providerLine) parts.push(providerLine);
  if (total.watchers !== null) parts.push(`Watchers: ${total.watchers}`);
  if (total.open_issues !== null) parts.push(`Open issues/PRs: ${total.open_issues}`);
  if (total.contributors !== null) parts.push(`Contributors: ${total.contributors}`);
  parts.push(`Last push: ${formatRelativeDate(total.pushed_at)}`);
  parts.push(`Detected license: ${total.license_spdx_id || 'unknown'}`);
  if (generatedAt) parts.push(`Stats refreshed ${formatRelativeDate(generatedAt)}`);
  return parts.join('\n');
}

// Repo Stats block of a card (into `container`) — mirrors script.js.
function renderRepoStats(container, row) {
  const stats = getRowRepoStats(row);
  if (!stats) {
    const na = el('span', 'gh-stats-na', 'n/a');
    na.title = 'No GitHub or GitLab repository referenced for this entry (empty URL or a non-repository source).';
    container.appendChild(na);
    return;
  }

  const wrapper = el('div', 'gh-stats');

  if (!stats.total) {
    // Repositories are known but the cache has no (fresh) entry for them.
    const missing = el('span', 'gh-stats-na', 'n/a');
    missing.title = `Statistics for ${stats.repos.map(r => r.key).join(', ')} are not refreshed yet.`;
    wrapper.appendChild(missing);
    container.appendChild(wrapper);
    return;
  }

  const t = stats.total;
  const generatedAt = repoStats ? repoStats.generated_at : null;

  // With several repositories in one row, show which block belongs to which repo.
  if (stats.repos.length > 1) {
    stats.repos.forEach(entry => {
      const line = el('a', 'gh-stats-repo', entry.key);
      const record = entry.record;
      if (record && record.html_url) {
        line.href = record.html_url;
        line.target = '_blank';
        line.rel = 'noopener noreferrer';
      } else {
        line.title = 'Statistics not refreshed yet for this repository.';
      }
      wrapper.appendChild(line);
    });
  }

  const addChip = (iconClass, value, label) => {
    const chip = el('span', 'gh-stat');
    chip.appendChild(icon(`fas ${iconClass}`));
    chip.appendChild(document.createTextNode(formatStatNumber(value)));
    chip.title = `${label}: ${value === null ? 'unknown' : value}`;
    wrapper.appendChild(chip);
  };

  addChip('fa-star', t.stars, 'Stars');
  addChip('fa-code-fork', t.forks, 'Forks');
  addChip('fa-code-commit', t.commits, 'Commits');

  // GitLab's public API exposes no watchers/subscribers count.
  if (t.watchers === null && stats.repos.some(r => r.record)) {
    const chip = el('span', 'gh-stat');
    chip.appendChild(icon('fas fa-eye'));
    chip.appendChild(document.createTextNode('n/a'));
    chip.title = 'Watchers: not exposed by the GitLab API.';
    wrapper.appendChild(chip);
  }

  if (t.archived) {
    const archived = el('span', 'gh-stat gh-stat--archived', 'archived');
    archived.title = 'The repository is marked as archived.';
    wrapper.appendChild(archived);
  }

  if (stats.repos.length === 1) {
    const record = stats.repos[0].record;
    if (record && record.html_url) {
      const line = el('a', 'gh-stats-repo');
      line.href = record.html_url;
      line.target = '_blank';
      line.rel = 'noopener noreferrer';
      line.textContent = stats.repos[0].key;
      wrapper.appendChild(line);
    }
  }

  wrapper.title = statsTooltipText(t, generatedAt, statsProviderLine(stats.repos));
  container.appendChild(wrapper);
}

// IP Card icon links (JSON / PDF) — mirrors script.js renderIpCardLinks.
function renderIpCardLinks(container, row) {
  const iconSpecs = [
    { key: 'IP_CARD_URL',     cls: 'fas fa-file-code', title: 'Open IP Card (JSON)', aria: 'IP Card JSON' },
    { key: 'IP_CARD_PDF_URL', cls: 'fas fa-file-pdf',  title: 'Open IP Card (PDF)',  aria: 'IP Card PDF'  }
  ];
  for (const spec of iconSpecs) {
    if (!row[spec.key]) continue;
    const a = el('a', 'ip-card-link');
    a.href = row[spec.key];
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = spec.title;
    a.setAttribute('aria-label', spec.aria);
    a.appendChild(icon(spec.cls));
    container.appendChild(a);
  }
}

// Tasks block of an IP card — mirrors script.js renderTasksBlock, capped to
// IP_TASK_LIST_LIMIT entries (a shared IP can be touched by 30+ tasks).
function renderTasksBlock(container, row) {
  const refs = row._taskDetails || [];
  const shown = IP_TASK_LIST_LIMIT > 0 ? refs.slice(0, IP_TASK_LIST_LIMIT) : refs;
  const list = el('div', 'task-list');
  for (const task of shown) {
    const item = el('div', 'task-item');
    const btn = el('button', 'task-link', task.Title || '(untitled task)');
    btn.type = 'button';
    btn.title = `${task.project} · ${task.WI}`;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      revealTask(task);
    });
    item.appendChild(btn);
    item.appendChild(el('span', 'task-item-meta', `${task.project} · ${task.WI}`));
    list.appendChild(item);
  }
  if (refs.length > shown.length) {
    list.appendChild(el('div', 'task-item-meta', `+${refs.length - shown.length} more`));
  }
  container.appendChild(list);
}

// ---------------------------------------------------------------------------
// Card meta rows — mirrors script.js isRowValueEmpty() / renderCardValue() for
// the IP-view summary columns, so a prototype IP card is indistinguishable from
// a Platform IP card (same rows, same widgets, same "no row without a value").
// ---------------------------------------------------------------------------
function isRowValueEmpty(col, row) {
  if (col === IP_CARD_COLUMN) return !(row.IP_CARD_URL || row.IP_CARD_PDF_URL);
  if (col === REPO_STATS_COLUMN) {
    const stats = getRowRepoStats(row);
    return !stats || !stats.total;
  }
  const val = row[col];
  if (Array.isArray(val)) {
    return val.filter(v => v !== null && v !== undefined && String(v).trim() !== '').length === 0;
  }
  return val === null || val === undefined || String(val).trim() === '';
}

function renderCardValue(container, col, row) {
  const val = row[col];
  const nonEmpty = Array.isArray(val) ? val.filter(Boolean) : (val ? [val] : []);

  if (col === REPO_STATS_COLUMN) { renderRepoStats(container, row); return; }
  if (col === IP_CARD_COLUMN) {
    container.className += ' card-meta-value--icons';
    renderIpCardLinks(container, row);
    return;
  }
  if (col === 'Tasks') { renderTasksBlock(container, row); return; }
  if (col === 'Status') {
    container.className += ' card-meta-value--wrap';
    nonEmpty.forEach(v => container.appendChild(statusPillEl(v)));
    return;
  }
  if (PILL_FIELDS[col]) {
    container.className += ' card-meta-value--wrap';
    nonEmpty.forEach(v => container.appendChild(el('span', `pill pill--${PILL_FIELDS[col]}`, String(v))));
    return;
  }
  container.textContent = Array.isArray(val) ? val.join(', ') : (val ?? '');
}

function renderProductionMeta(metaEl, row, columns) {
  for (const col of columns) {
    if (col === 'Name') continue;                 // "Name" is the card title
    if (isRowValueEmpty(col, row)) continue;      // "when available" rule
    const value = el('span', 'card-meta-value');
    renderCardValue(value, col, row);
    metaEl.appendChild(metaLabelledRow(columnLabels[col] || col, value));
  }
}

function metaLabelledRow(label, valueEl) {
  const rowEl = el('div', 'card-meta-row');
  rowEl.appendChild(el('span', 'card-meta-label', label));
  rowEl.appendChild(valueEl);
  return rowEl;
}

function addMetaRow(container, label, valueEl) {
  if (!valueEl) return;   // "when available": no row without a value
  const value = el('span', 'card-meta-value card-meta-value--wrap');
  value.appendChild(valueEl);
  container.appendChild(metaLabelledRow(label, value));
}

// Status pills get a state-based tint; unknown statuses stay neutral
// (mirrors script.js renderStatusPill()).
function statusPillEl(value) {
  const key = String(value ?? '').trim().toLowerCase();
  const map = {
    'released': 'ok', 'stable': 'ok', 'active': 'ok',
    'tbd': 'unknown', 'provisional': 'unknown', 'planned': 'unknown',
    'in development': 'wip', 'development': 'wip', 'wip': 'wip', 'in progress': 'wip',
    'deprecated': 'deprecated', 'archived': 'deprecated', 'retired': 'deprecated'
  };
  const mod = map[key] ? ` pill-status--${map[key]}` : '';
  return el('span', `pill pill--status${mod}`, value);
}

// ---------------------------------------------------------------------------
// Data layer — mirrors script.js (applyCatalog / normalizeTaskRow) but keeps
// only what the unified preview needs.
// ---------------------------------------------------------------------------
async function load() {
  try {
    statusEl.textContent = `Fetching ${CATALOG_URL}…`;
    // repo-stats.json is cosmetic (the Repo Stats row) — never block the preview.
    const [catResp, projResp, statsResp] = await Promise.all([
      fetch(CATALOG_URL), fetch(PROJECTS_URL), fetch(REPO_STATS_URL).catch(() => null)
    ]);
    if (!catResp.ok) throw new Error(`Failed to load catalogue: ${catResp.status}`);
    if (!projResp.ok) throw new Error(`Failed to load projects: ${projResp.status}`);
    const data = await catResp.json();
    if (!data || typeof data !== 'object' || !data.ips || !data.projects) {
      throw new Error('Malformed catalogue aggregate');
    }
    catalog = data;
    try {
      projectsData = await projResp.json();
    } catch {
      projectsData = [];    // logos are cosmetic — never block the preview on them
    }
    repoStats = null;
    repoStatsIndex = new Map();
    if (statsResp && statsResp.ok) {
      try {
        const stats = await statsResp.json();
        if (stats && typeof stats === 'object' && typeof stats.repos === 'object') {
          repoStats = stats;
          repoStatsIndex = new Map(
            Object.entries(stats.repos).map(([key, value]) => [key.toLowerCase(), value])
          );
        }
      } catch { /* stats stay unavailable */ }
    }
    buildModel();
    statusEl.textContent =
      `${projectNodes.length} projects · ${taskNodes.length} tasks · ${ipNodes.length} referenced IPs`;
    buildView();
  } catch (err) {
    statusEl.textContent = 'Error: ' + (err.message || err);
    statusEl.classList.add('error');
    console.error(err);
  }
}

// Compact "TRISTAN · WI2.4.1 · UVM env for CVA6" pair string for an IP row
// (mirrors script.js taskPairLabel).
function taskPairLabel(projectName, task) {
  const wi = task.WIList.length ? task.WIList.join('/') : (task.WI || '');
  return `${projectName} · ${wi} · ${task.Title}`;
}

function buildModel() {
  const metaByName = new Map(asArray(projectsData).map(p => [p.name, p]));
  for (const ip of Object.values(catalog.ips || {})) ipById.set(ip.Id, ip);
  refsByIp.clear();

  taskNodes = [];
  projectNodes = Object.values(catalog.projects || {}).map(doc => {
    const meta = metaByName.get(doc.Name) || {};
    const tasks = (doc.Tasks || []).map(task => {
      const ipIds = asArray(task.IPs);
      const WIList = asArray(task.WI);
      // Same task-repo fallback as script.js normalizeTaskRow(): the task's
      // own URL, else the canonical URL of the first IP it touches.
      const firstIp = ipById.get(ipIds[0]) || {};
      const node = {
        key: `t:${doc.Name}/${task.TaskId || task.Title}`,
        project: doc.Name,
        Title: task.Title || '(untitled task)',
        TaskId: task.TaskId || '',
        WI: WIList.join(', '),
        WIList,
        Partners: asArray(task.Partners).join(', '),
        PartnersList: asArray(task.Partners),
        Status: task.Status || '',
        Branch: task.Branch || '',
        Description: task.Description || '',
        Comment: task.Comment || '',
        URL: httpUrl(task.URL) || httpUrl(firstIp.URL),
        // Display names for the IPs meta row (production renderIpsCell).
        ipNames: ipIds.map(id => (ipById.get(id) || {}).Name || id),
        ipIds
      };
      for (const id of ipIds) {
        if (!refsByIp.has(id)) refsByIp.set(id, []);
        refsByIp.get(id).push(node);
      }
      return node;
    });
    tasks.sort((a, b) => collator.compare(a.Title, b.Title));
    taskNodes.push(...tasks);
    return {
      key: `p:${doc.Name}`,
      name: doc.Name,
      id: meta.id || '',
      logo: meta.logo || '',
      url: httpUrl(meta.url),
      tasks
    };
  });
  projectNodes.sort((a, b) => collator.compare(a.name, b.name));

  // De-duplicated set of only the IPs referenced by at least one task, shaped
  // like the production IP dataset rows (script.js applyCatalog) so the same
  // meta-row renderer works on both sides.
  ipNodes = [...refsByIp.entries()].map(([id, refs]) => {
    const ip = ipById.get(id) || {};
    const row = { ...ip };
    row.Id = ip.Id || id;
    row.Name = ip.Name || id;
    row.Owners = asArray(ip.Owners);
    row.Category = asArray(ip.Category);
    row.Tasks = refs.map(t => taskPairLabel(t.project, t));   // filterable labels
    row._taskDetails = refs;                                  // rendered list
    row.key = `i:${row.Id}`;
    return row;
  }).sort((a, b) => collator.compare(a.Name, b.Name));
  ipRowById.clear();
  for (const row of ipNodes) ipRowById.set(row.Id, row);
}

function ipRow(ipId) {
  return ipRowById.get(ipId) || {
    Id: ipId, Name: ipId, key: `i:${ipId}`, Owners: [], Category: [], Tasks: [], _taskDetails: []
  };
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
  projectW: 320,          // recomputed at build from the longest project name
  projectMinW: 320,       // style.css .card-grid minmax(320px, 1fr)
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
    measureEl = el('span', 'mm-measure');
    document.body.appendChild(measureEl);
  }
  measureEl.className = `mm-measure ${className}`;
  measureEl.textContent = text;
  return measureEl.offsetWidth;
}

// One uniform project-card width: wide enough for the longest project name and
// for a 20-character reservation. The head chrome is not guessed — the cards
// already exist at the minimum width, so `card box − title box + wanted title
// box` is the exact width each card needs; the widest one wins.
function computeProjectWidth() {
  const RULER = 'MMMMMMMMMMMMMMMMMMMM';   // the requested 20-character reservation
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
    // A logo that has not loaded yet occupies nothing now but up to its CSS
    // max-width later — reserve that room instead of measuring an empty box.
    const logo = card.querySelector('.mm-project-logo');
    const pendingLogo = logo && !logo.clientWidth ? 110 + 10 : 0;
    needed = Math.max(needed, card.offsetWidth - titleEl.clientWidth + pendingLogo + textW);
  }
  return clamp(Math.ceil(needed), L.projectMinW, L.projectMaxW);
}

function measureNode(key) {
  const nodeEl = viewState.els.get(key);
  if (!nodeEl) return null;
  // A hidden (table-mode) stage measures zero — never let that overwrite the
  // real geometry: the solver keeps working from the last honest size, and
  // setView('canvas') re-measures everything once the stage is laid out.
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
  // A hidden (table-mode) stage measures zero — sizing from it would collapse
  // the canvas; setView('canvas') re-derives the extent on the way back.
  if (stageEl.hidden) return;
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
  canvasEl.querySelectorAll('.mm-node, .proto-empty').forEach(n => n.remove());
  viewState.pos.clear();
  viewState.size.clear();
  viewState.els.clear();
  viewState.linesByNode.clear();

  if (!projectNodes.length) {
    canvasEl.appendChild(el('div', 'proto-empty', 'No projects with tasks in the catalogue yet.'));
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
  mmSearchLayoutSig = '\u0000';
  applySearch();
  ensureCanvasExtent();
  }

// Project card: production .entity-card chrome, title on its own head row,
// production-style meta rows for the counters, and the task list revealed
// inside the card's own DOM (so dragging/resizing moves everything together).
function renderProjectCard(project) {
  const subId = `mm-project-tasks-${projectNodes.indexOf(project)}`;
  const card = el('div', 'mm-node mm-node--project entity-card');
  card.dataset.key = project.key;

  const head = el('div', 'card-head');
  if (project.logo) {
    const img = el('img', 'mm-project-logo');
    img.src = project.logo;
    img.alt = '';
    img.loading = 'lazy';
    head.appendChild(img);
  }
  const title = el('button', 'card-title mm-project-title', project.name);
  title.type = 'button';
  title.title = project.name;   // the tooltip carries the name if width truncates
  title.setAttribute('aria-haspopup', 'dialog');   // title opens the drawer
  head.appendChild(title);
  if (project.url) head.appendChild(extLink(project.url));
  const caret = el('button', 'proto-caret');
  caret.type = 'button';
  caret.setAttribute('aria-expanded', 'false');
  caret.setAttribute('aria-controls', subId);
  caret.setAttribute('aria-label', `Show tasks of ${project.name}`);
  caret.appendChild(icon('fas fa-caret-down'));
  head.appendChild(caret);
  card.appendChild(head);

  const meta = el('div', 'card-meta');
  meta.appendChild(countMetaRow('Tasks', project.tasks.length));
  meta.appendChild(countMetaRow('IPs', distinctIpCount(project)));
  card.appendChild(meta);

  const list = el('div', 'mm-project-tasks');
  list.id = subId;
  list.hidden = true;
  if (!project.tasks.length) {
    list.appendChild(el('div', 'proto-empty', 'No tasks in this project yet.'));
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
    openProjectDrawer(project);
  };
  title.addEventListener('click', e => {
    if (movedSincePointerDown(card)) return;   // the gesture was a drag
    openProjectDrawer(project);
  });
  card.addEventListener('click', openFromCard);

  card.appendChild(resizeGrip());
  return card;
}

function countMetaRow(label, count) {
  return metaLabelledRow(label, el('span', 'card-meta-value', String(count)));
}

// Grow/shrink the card and shove whatever the new box now covers away.
function setProjectExpanded(project, open) {
  const card = viewState.els.get(project.key);
  if (!card) return;
  const list = card.querySelector('.mm-project-tasks');
  if (!list || list.hidden === !open) return;
  // Only the caret expands — the title button opens the drawer instead.
  const caret = card.querySelector('.proto-caret');
  if (caret) caret.setAttribute('aria-expanded', open ? 'true' : 'false');
  list.hidden = !open;
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

function extLink(url) {
  const a = el('a', 'card-ext');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.setAttribute('aria-label', 'Open in a new tab');
  a.appendChild(icon('fas fa-arrow-up-right-from-square'));
  return a;
}

// Bottom-right drag handle (see wireNodeResize).
function resizeGrip() {
  const grip = el('button', 'mm-resize');
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
  const row = el('div', 'mm-task-row');
  row.dataset.taskKey = task.key;
  // data-task-key + refsByIp drive the sharing lookup; data-ips documents it.
  row.dataset.ips = task.ipIds.join(' ');
  row.setAttribute('role', 'button');
  row.tabIndex = 0;
  row.title = task.ipIds.length
    ? 'Select this task and open its details; its IP chips show / hide the IP cards on the canvas'
    : 'Open this task’s details (it references no IPs)';

  const head = el('div', 'card-head mm-task-head');
  head.appendChild(el('span', 'card-title mm-task-title', task.Title));
  if (task.URL) head.appendChild(extLink(task.URL));
  row.appendChild(head);

  const meta = el('div', 'card-meta mm-task-meta');
  addMetaRow(meta, 'WI', task.WI ? wrapPillEl(task.WI, 'wi') : null);
  if (task.ipIds.length) {
    const ips = el('span', 'card-meta-value card-meta-value--wrap');
    task.ipIds.forEach((ipId, i) => ips.appendChild(taskIpChip(task, ipId, task.ipNames[i])));
    meta.append(metaLabelledRow('IPs', ips));
  }
  addMetaRow(meta, 'Partners', task.Partners ? wrapPillEl(task.Partners, 'partner') : null);
  addMetaRow(meta, 'Status', task.Status ? statusPillEl(task.Status) : null);
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

function wrapPillEl(value, kind) {
  return el('span', `pill pill--${kind}`, value);
}

// One IP of a task row as a little card: clicking the chip shows that IP card
// on the canvas, clicking the pressed chip again hides it — exactly the
// toggleIpCardForTask semantics the Task drawer's "IPs" section offers, so
// both surfaces stay in sync through ipCardLinks (a shared IP only dies once
// its last wired task toggles off; a pinned card outlives both). Pressed ==
// this task currently has a wired edge to the IP card.
function taskIpChip(task, ipId, name) {
  const on = (viewState.ipCardLinks.get(ipId) || new Set()).has(task.key);
  const chip = el('button', 'mm-task-ip' + (on ? ' is-on' : ''));
  chip.type = 'button';
  chip.dataset.ip = ipId;
  chip.setAttribute('aria-pressed', on ? 'true' : 'false');
  chip.title = `${name}: click to show / hide the IP card on the canvas`;
  chip.appendChild(icon(`mm-task-ip-icon fas ${ipChipGlyph(on)}`));
  chip.appendChild(el('span', 'mm-task-ip-name', name));
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
    openTaskDrawer(task);
  }
}

function selectTask(taskKey) {
  viewState.selected.push(taskKey);
  const rowInfo = viewState.taskRowEls.get(taskKey);
  if (rowInfo) rowInfo.el.classList.add('mm-task-selected');
  // Selection alone never spawns: IP cards are born from the task-row IP
  // chips or the Task drawer's "IPs" toggles. The repaint lets the newest
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

// Open the project of a task referenced from an IP card and select it, so the
// Task → IP connector becomes visible (the prototype's stand-in for the
// production detail drawer navigation).
function revealTask(task) {
  // Drawer rows always navigate on the canvas: leave table mode first, or
  // the expansion / selection the jump performs would happen out of sight.
  if (currentView !== 'canvas') setView('canvas');
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
// little IP chips inside the task rows and the Task drawer's "IPs" section.
// Toggling on spawns the card in the column right of the project card —
// stacked below the cards already shown there — and wires the current task's
// edge; toggling off drops the edge and lets the visibility prune remove the
// card (a pinned card, or one another task still wires, stays). A card that
// was pruned earlier keeps its position in viewState.pos and reappears
// exactly there.
function toggleIpCardForTask(task, ipId) {
  // The card this spawns lives on the canvas — from the Task drawer's "IPs"
  // section a table-mode user would toggle a card they cannot see, so the
  // canvas comes first (same reasoning as revealTask).
  if (currentView !== 'canvas') setView('canvas');
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
  if (mmSearchText && !ipMatchesSearch(row, mmSearchText)) {
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
  const node = el('div', 'mm-node mm-node--ip entity-card');
  node.dataset.key = row.key;
  node.dataset.ip = row.Id;
  node.style.width = `${L.ipW}px`;
  if (viewState.pinned.has(row.Id)) node.classList.add('mm-pinned');

  const head = el('div', 'card-head');
  const title = el('button', 'card-title', row.Name);
  title.type = 'button';
  title.setAttribute('aria-haspopup', 'dialog');   // title opens the drawer
  title.title = 'Open IP details; highlights the selected tasks sharing this IP';
  title.addEventListener('click', () => {
    if (movedSincePointerDown(node)) return;
    highlightSharingTasks(row.Id);
    openIpDrawer(row);
  });
  head.appendChild(title);
  if (isValidUrl(row.URL)) head.appendChild(extLink(row.URL));
  head.appendChild(pinControl(node, row.Id));
  node.appendChild(head);

  const meta = el('div', 'card-meta');
  renderProductionMeta(meta, row, IP_COLUMNS);
  node.appendChild(meta);

  node.appendChild(resizeGrip());

  node.addEventListener('click', e => {
    if (e.target.closest('a[href], button, label, input')) return;
    if (movedSincePointerDown(node)) return;   // the gesture was a drag
    highlightSharingTasks(row.Id);
    openIpDrawer(row);
  });
  return node;
}

// Pin checkbox inside the card head (an absolute corner box would collide with
// .card-ext): keeps the card once every task touching it is deselected.
function pinControl(node, ipId) {
  const checkbox = el('input');
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
  const pinLabel = el('label', 'mm-pin');
  pinLabel.htmlFor = checkbox.id;
  pinLabel.appendChild(checkbox);
  pinLabel.appendChild(el('span', null, 'Pin'));
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
// Search — dim, don't remove: the canvas must keep its layout stable, so
// non-matching whole cards fade to grey ghosts and only task rows (which live
// inside a card) actually leave the layout. Matching mirrors script.js
// matchesSearch(): one lower-cased needle, OR across the columns the card type
// shows, arrays hit when any element hits.
// ---------------------------------------------------------------------------
function rowMatchesText(row, text, columns) {
  if (!text) return true;
  return columns.some(col => {
    const cell = row[col];
    if (cell == null) return false;
    if (Array.isArray(cell)) return cell.some(v => v != null && String(v).toLowerCase().includes(text));
    return String(cell).toLowerCase().includes(text);
  });
}

// An IP also matches its IP Card JSON/PDF URLs — the fallback production
// matchesSearch() applies to IP-view rows.
function ipMatchesSearch(row, text) {
  if (!text) return true;
  return rowMatchesText(row, text, IP_SEARCH_COLUMNS)
    || [row.IP_CARD_URL, row.IP_CARD_PDF_URL].some(v => v && String(v).toLowerCase().includes(text));
}

let mmSearchDebounce = null;
let mmSearchLayoutSig = '';   // the hit-set the layout was last solved for

// The current search hits, shared by both views: the canvas dims the cards
// around them, the table renders exactly them (and exports them).
let mmSearchHits = { active: false, projects: new Set(), tasks: new Set(), ips: new Set() };

// Hit sets. A project matches by its own name or any of its tasks; a task
// also matches its project's name — the production Task view searches a
// Project column, so "ISOLDE" must keep those rows alive.
function computeSearchHits(text) {
  const active = text.length > 0;
  const hits = { active, projects: new Set(), tasks: new Set(), ips: new Set() };
  for (const project of projectNodes) {
    const nameHit = active && project.name.toLowerCase().includes(text);
    let projectHit = nameHit;
    for (const task of project.tasks) {
      if (!active || nameHit || rowMatchesText(task, text, TASK_SEARCH_COLUMNS)) {
        if (active) hits.tasks.add(task.key);
        projectHit = true;
      }
    }
    if (active && projectHit) hits.projects.add(project.key);
  }
  if (active) {
    for (const row of ipNodes) {
      if (ipMatchesSearch(row, text)) hits.ips.add(row.Id);
    }
  }
  return hits;
}

function applySearch() {
  const text = mmSearchText;
  const active = text.length > 0;

  mmSearchHits = computeSearchHits(text);
  const hitTasks = mmSearchHits.tasks;
  const hitProjects = mmSearchHits.projects;
  const hitIps = mmSearchHits.ips;

  // Apply: whole cards ghost out, non-matching rows leave their card's flow.
  for (const project of projectNodes) {
    const card = viewState.els.get(project.key);
    if (card) card.classList.toggle('mm-dim', active && !hitProjects.has(project.key));
    for (const task of project.tasks) {
      const info = viewState.taskRowEls.get(task.key);
      if (info) info.el.classList.toggle('mm-row-hidden', active && !hitTasks.has(task.key));
    }
  }
  for (const [key, nodeEl] of viewState.els) {
    if (key.startsWith('i:')) nodeEl.classList.toggle('mm-dim', active && !hitIps.has(key.slice(2)));
  }

  searchClearEl.hidden = !active;
  searchCountEl.hidden = !active;
  // Also empty the (aria-live) count when inactive — a hidden stale
  // announcement should not linger in the accessibility tree.
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  searchCountEl.textContent = active
    ? `${plural(hitProjects.size, 'project')} · ${plural(hitTasks.size, 'task')}`
      + ` · ${plural(hitIps.size, 'IP')} match`
    : '';

  pruneHiddenIpCards();
  repaintAllEdges();

  // Only a changed hit-set changes card heights (hidden rows leave the flow),
  // so the expensive sweep runs on that change, not on every keystroke.
  const sig = active ? [...hitTasks].sort().join('|') : '';
  if (sig !== mmSearchLayoutSig) {
    mmSearchLayoutSig = sig;
    for (const project of projectNodes) {
      if (viewState.els.get(project.key)) measureNode(project.key);
    }
    resolveCollisions([]);
  }

  // Table mode renders the same hit sets as rows instead of dimming cards.
  if (currentView === 'table') renderTable();
  }

function clearCanvasSearch() {
  clearTimeout(mmSearchDebounce);
  searchEl.value = '';
  mmSearchText = '';
  applySearch();
}

// Mirrors script.js' debounced search input: live at 150 ms — no Enter and no
// button needed.
searchEl.addEventListener('input', () => {
  clearTimeout(mmSearchDebounce);
  mmSearchDebounce = setTimeout(() => {
    mmSearchText = searchEl.value.trim().toLowerCase();
    applySearch();
  }, 150);
});

searchClearEl.addEventListener('click', () => {
  clearCanvasSearch();
  searchEl.focus();
});

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
  // degenerate paths would leave the connectors mis-anchored on the way
  // back; setView('canvas') repaints all edges once the stage is laid out.
  if (stageEl.hidden) return;
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
    if (e.target.closest('a[href], input, label, .mm-task-row, .proto-caret, .mm-resize')) return;
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
      // a hidden (table-mode) stage reports a scroll of 0 — keep the offset
      // that was live before the view switch
      scroll: stageEl.hidden
        ? { x: lastStageScroll.x, y: lastStageScroll.y }
        : { x: stageEl.scrollLeft, y: stageEl.scrollTop },
      expanded: [...viewState.expanded],
      selected: [...viewState.selected],
      pinned: [...viewState.pinned],
      view: currentView,
      tableTab: currentTableTab
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
  // View mode (Canvas | Table) and the table's tab are part of the session
  // layout too. renderTable() inside setView may still see stale hit sets —
  // buildView's final applySearch() re-renders the table for the live search.
  setTableTab(TABLE_KINDS.includes(state.tableTab) ? state.tableTab : 'project', { render: false });
  setView(state.view === 'table' ? 'table' : 'canvas', { save: false });
  }

// ---------------------------------------------------------------------------
// Detail drawers — copied mirrors of the script.js drawer machinery and field
// helpers (AGENTS.md: the prototype mirrors production helpers, it never
// imports script.js). No drawerToken guard: unlike production these drawers
// render synchronously (the prototype never fetches IP Card JSON previews),
// so there is no in-flight async render to invalidate.
// ---------------------------------------------------------------------------
let drawerEndHandler = null;
// Element focused before the drawer opened, restored when it closes.
let lastFocusedEl = null;

function sectionTitle(text) {
  return el('h3', 'drawer-section-title', text);
}

// Field block: labelled value row, values rendered with the same widgets as
// cards (pills, links) — mirrors script.js drawerField().
function drawerField(labelText, buildFn) {
  const row = el('div', 'field-row');
  row.appendChild(el('span', 'field-label', labelText));
  const value = el('span', 'field-value');
  buildFn(value);
  row.appendChild(value);
  return row;
}

function pillsInto(container, values, kind) {
  const arr = asArray(values);
  if (!arr.length) { container.textContent = 'n/a'; return; }
  arr.forEach(v => container.appendChild(el('span', `pill pill--${kind}`, String(v))));
}

function statusInto(container, values) {
  const arr = asArray(values);
  if (!arr.length) { container.textContent = 'n/a'; return; }
  arr.forEach(v => container.appendChild(statusPillEl(v)));
}

function linkInto(container, url, text) {
  if (!isValidUrl(url)) { container.textContent = text ? text : 'n/a'; return; }
  const a = el('a', null, text || url);
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  container.appendChild(a);
}

function openDrawer(kind, titleText, renderFn) {
  if (!drawerEl) return;
  // Remember the opener's focus — but only when the drawer is currently
  // closed, so re-entrant navigation (Project → IP → Used-by) keeps the
  // original trigger, same rule as production openDetailDrawer().
  if (drawerEl.hidden) lastFocusedEl = document.activeElement;
  drawerKindEl.textContent = kind;
  drawerKindEl.className = `drawer-kind drawer-kind--${kind.toLowerCase()}`;
  drawerTitleEl.textContent = titleText || '';
  drawerBodyEl.textContent = '';   // empties the body without innerHTML
  renderFn(drawerBodyEl);
  showDrawer();
}

function showDrawer() {
  // Cancel any pending slide-out cleanup from a previous close.
  if (drawerEndHandler) {
    drawerEl.removeEventListener('transitionend', drawerEndHandler);
    drawerEndHandler = null;
  }
  drawerEl.hidden = false;
  drawerEl.setAttribute('aria-hidden', 'false');
  drawerOverlayEl.hidden = false;
  void drawerEl.offsetWidth;   // force a reflow so the slide-in transition runs
  drawerEl.classList.add('open');
  const closeBtn = drawerEl.querySelector('.drawer-close');
  if (closeBtn) closeBtn.focus();
}

function closeDetailDrawer() {
  if (!drawerEl || drawerEl.hidden) return;
  drawerEl.classList.remove('open');
  // Restore focus BEFORE aria-hidden goes on: the close-trigger (a drawer
  // list row) still owns focus at this moment, and hiding an subtree that
  // contains the focused element trips Chrome's "Blocked aria-hidden"
  // warning. (Production never closes from inside the drawer, so only the
  // prototype's revealTask rows hit this path.)
  if (lastFocusedEl && typeof lastFocusedEl.focus === 'function') {
    lastFocusedEl.focus();
  } else if (drawerEl.contains(document.activeElement)) {
    // No opener to return to (or it is gone): never leave focus inside a
    // subtree about to be aria-hidden.
    document.activeElement.blur();
  }
  lastFocusedEl = null;
  drawerEl.setAttribute('aria-hidden', 'true');
  drawerOverlayEl.hidden = true;
  // Hide after the drawer's own transform transition finishes (guarded like
  // production: transitionend bubbles, reopening mid-slide must not hide).
  const onEnd = e => {
    if (e.target !== drawerEl || e.propertyName !== 'transform') return;
    drawerEl.removeEventListener('transitionend', onEnd);
    drawerEndHandler = null;
    if (!drawerEl.classList.contains('open')) drawerEl.hidden = true;
  };
  if (drawerEndHandler) drawerEl.removeEventListener('transitionend', drawerEndHandler);
  drawerEndHandler = onEnd;
  drawerEl.addEventListener('transitionend', onEnd);
  setTimeout(() => {
    if (!drawerEl.classList.contains('open')) drawerEl.hidden = true;
  }, 350);
}

// Escape is owned by the page-level keydown handler (priority chain: drawer
// → search → selection), so setupDrawer only wires the pointer close-ups.
function setupDrawer() {
  if (!drawerEl) return;
  const closeBtn = drawerEl.querySelector('.drawer-close');
  if (closeBtn) closeBtn.addEventListener('click', closeDetailDrawer);
  if (drawerOverlayEl) drawerOverlayEl.addEventListener('click', closeDetailDrawer);
}

function openTaskDrawer(task) {
  openDrawer('Task', task.Title || task.TaskId || '(task)', body => mmRenderTaskDrawer(body, task));
}

function openIpDrawer(row) {
  openDrawer('IP', row.Name || row.Id || '(IP)', body => mmRenderIpDrawer(body, row));
}

function openProjectDrawer(project) {
  openDrawer('Project', project.name || '(project)', body => mmRenderProjectDrawer(body, project));
}

// Task drawer — fields per script.js renderTaskDrawer, then the actionable
// "IPs" section: the drawer surface of the task-row IP-chip toggle — both
// call toggleIpCardForTask, so a card is born or dies through one semantics.
function mmRenderTaskDrawer(body, task) {
  const fields = el('div', 'drawer-fields');
  if (task.TaskId) fields.appendChild(drawerField('Task id', c => { c.textContent = task.TaskId; }));
  if (task.WI) fields.appendChild(drawerField('WI', c => pillsInto(c, task.WIList, 'wi')));
  fields.appendChild(drawerField('Project', c => c.appendChild(el('span', 'pill pill--project', task.project))));
  if (task.PartnersList.length) fields.appendChild(drawerField('Partners', c => pillsInto(c, task.PartnersList, 'partner')));
  if (task.Status) fields.appendChild(drawerField('Status', c => statusInto(c, task.Status)));
  if (task.Branch) fields.appendChild(drawerField('Branch', c => { c.textContent = task.Branch; }));
  if (task.URL) fields.appendChild(drawerField('URL', c => linkInto(c, task.URL)));
  fields.appendChild(drawerField('Statistics', c => renderRepoStats(c, task)));
  if (task.Description) fields.appendChild(drawerField('Description', c => { c.textContent = task.Description; }));
  if (task.Comment) fields.appendChild(drawerField('Comment', c => { c.textContent = task.Comment; }));
  body.appendChild(fields);

  body.appendChild(sectionTitle('IPs'));
  body.appendChild(el('p', 'mm-drawer-hint', 'Click to show / hide on the canvas.'));
  const list = el('div', 'mm-drawer-ips');
  body.appendChild(list);
  const buttons = new Map();
  const renderToggles = () => {
    list.textContent = '';
    buttons.clear();
    if (!task.ipIds.length) {
      list.appendChild(el('p', 'mm-drawer-hint', 'This task references no IPs.'));
      return;
    }
    for (const ipId of task.ipIds) {
      // "On" means: this task currently has a wired edge to the IP card.
      const on = (viewState.ipCardLinks.get(ipId) || new Set()).has(task.key);
      const btn = el('button', 'mm-ip-toggle' + (on ? ' is-on' : ''));
      btn.type = 'button';
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.appendChild(icon(on ? 'fas fa-check' : 'fas fa-plus'));
      btn.appendChild(el('span', null, (ipById.get(ipId) || {}).Name || ipId));
      btn.appendChild(el('span', 'mm-ip-toggle-state', on ? 'On canvas' : 'Show on canvas'));
      btn.addEventListener('click', () => {
        toggleIpCardForTask(task, ipId);
        renderToggles();   // every button re-reads the canvas state
        const again = buttons.get(ipId);
        if (again) again.focus();   // keyboard users keep their place
      });
      buttons.set(ipId, btn);
      list.appendChild(btn);
    }
  };
  renderToggles();
}

// IP drawer — fields per script.js renderIpDrawer, plus the "Used by" task
// list whose rows jump to the task on the canvas (revealTask).
function mmRenderIpDrawer(body, row) {
  const fields = el('div', 'drawer-fields');
  if (row.Id) fields.appendChild(drawerField('Id', c => { c.textContent = row.Id; }));
  fields.appendChild(drawerField('Owners', c => pillsInto(c, row.Owners, 'owner')));
  if (asArray(row.Category).length) fields.appendChild(drawerField('Category', c => pillsInto(c, row.Category, 'category')));
  if (asArray(row.License).length) fields.appendChild(drawerField('License', c => pillsInto(c, row.License, 'license')));
  if (row.Status) fields.appendChild(drawerField('Status', c => statusInto(c, row.Status)));
  if (row.DefaultBranch) fields.appendChild(drawerField('Default branch', c => { c.textContent = row.DefaultBranch; }));
  fields.appendChild(drawerField('Repository', c => linkInto(c, row.URL)));
  if (row.IP_CARD_URL || row.IP_CARD_PDF_URL) fields.appendChild(drawerField('IP Card', c => renderIpCardLinks(c, row)));
  if (row.Description) fields.appendChild(drawerField('Description', c => { c.textContent = row.Description; }));
  if (row.Comment) fields.appendChild(drawerField('Comment', c => { c.textContent = row.Comment; }));
  fields.appendChild(drawerField('Statistics', c => renderRepoStats(c, row)));
  body.appendChild(fields);

  body.appendChild(sectionTitle('Used by'));
  const refs = row._taskDetails || [];
  if (!refs.length) {
    body.appendChild(el('p', 'mm-drawer-hint', 'No project task references this IP yet.'));
    return;
  }
  const list = el('div', 'mm-drawer-list');
  for (const task of refs) {
    const btn = el('button', 'mm-drawer-item mm-drawer-item--task');
    btn.type = 'button';
    btn.title = `${task.project} · ${task.WI}`;
    btn.appendChild(el('span', 'mm-drawer-item-id', task.TaskId || task.project));
    btn.appendChild(el('span', null, task.Title));
    btn.addEventListener('click', () => {
      closeDetailDrawer();
      revealTask(task);
    });
    list.appendChild(btn);
  }
  body.appendChild(list);
}

// Project drawer — logo, website, catalogue id, aggregate partners (task-
// count badges) and clickable Tasks/IPs lists. Note: "Project Id" is the
// catalogue project id — the data model has no separate EU call number.
function mmRenderProjectDrawer(body, project) {
  const fields = el('div', 'drawer-fields');
  if (project.logo || project.url) {
    const rowEl = el('div', 'field-row field-row--logo');
    if (project.logo) {
      const img = el('img', 'project-logo');
      img.src = project.logo;
      img.alt = project.name;
      img.loading = 'lazy';
      rowEl.appendChild(img);
    }
    if (project.url) {
      const a = el('a', 'project-url', project.url);
      a.href = project.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      rowEl.appendChild(a);
    }
    fields.appendChild(rowEl);
  }
  if (project.id) {
    fields.appendChild(drawerField('Project Id', c => c.appendChild(el('code', 'mm-id-pill', project.id))));
  }
  const partnerCounts = new Map();
  for (const task of project.tasks) {
    for (const partner of task.PartnersList) partnerCounts.set(partner, (partnerCounts.get(partner) || 0) + 1);
  }
  if (partnerCounts.size) {
    fields.appendChild(drawerField('Partners', c => {
      [...partnerCounts.entries()]
        .sort((a, b) => collator.compare(a[0], b[0]))
        .forEach(([partner, count]) => {
          const pill = el('span', 'pill pill--partner', partner);
          pill.appendChild(el('span', 'mm-partner-count', ` ×${count}`));
          c.appendChild(pill);
        });
    }));
  }
  fields.appendChild(drawerField('Tasks', c => { c.textContent = String(project.tasks.length); }));
  fields.appendChild(drawerField('IPs', c => { c.textContent = String(distinctIpCount(project)); }));
  body.appendChild(fields);

  body.appendChild(sectionTitle('Tasks'));
  const tasks = el('div', 'mm-drawer-list');
  if (!project.tasks.length) {
    tasks.appendChild(el('p', 'mm-drawer-hint', 'No tasks in this project yet.'));
  }
  for (const task of project.tasks) {
    const btn = el('button', 'mm-drawer-item mm-drawer-item--task');
    btn.type = 'button';
    btn.appendChild(el('span', 'mm-drawer-item-id', task.TaskId || 'n/a'));
    btn.appendChild(el('span', null, task.Title));
    btn.addEventListener('click', () => {
      closeDetailDrawer();
      revealTask(task);
    });
    tasks.appendChild(btn);
  }
  body.appendChild(tasks);

  const ipRows = [...new Set(project.tasks.flatMap(t => t.ipIds))]
    .map(id => ipRow(id))
    .sort((a, b) => collator.compare(a.Name, b.Name));
  body.appendChild(sectionTitle(`IPs (${ipRows.length})`));
  const ips = el('div', 'mm-drawer-list');
  if (!ipRows.length) {
    ips.appendChild(el('p', 'mm-drawer-hint', 'No IP is referenced by this project yet.'));
  }
  for (const row of ipRows) {
    const btn = el('button', 'mm-drawer-item mm-drawer-item--ip');
    btn.type = 'button';
    btn.appendChild(el('span', 'mm-drawer-item-id', row.Id));
    btn.appendChild(el('span', null, row.Name));
    btn.addEventListener('click', () => openIpDrawer(row));
    ips.appendChild(btn);
  }
  body.appendChild(ips);
}

// ---------------------------------------------------------------------------
// View modes — Canvas (the floating-card stage) | Table (the same contents
// as sortable lists). The switch is a radiogroup of two buttons with a
// sliding thumb (CSS); ArrowLeft/ArrowRight move between the modes. Table
// mode hides the canvas, the legend and "Clear selection" — selection, IP
// cards and edges stay untouched on the hidden canvas, so switching back is
// seamless — while the search drives both views through the same hit sets.
// ---------------------------------------------------------------------------
function setView(view, opts = {}) {
  currentView = view === 'table' ? 'table' : 'canvas';
  const tableOn = currentView === 'table';
  // Hiding the stage destroys its scroll boxes — snapshot the offset while
  // it is still live, before the hidden attribute goes on.
  if (tableOn) lastStageScroll = { x: stageEl.scrollLeft, y: stageEl.scrollTop };
  tableRootEl.hidden = !tableOn;
  stageEl.hidden = tableOn;
  legendEl.hidden = tableOn;
  clearBtn.hidden = tableOn;            // selection lives on the canvas
  viewSwitchEl.classList.toggle('is-table', tableOn);
  for (const option of viewSwitchEl.querySelectorAll('.proto-view-option')) {
    const on = option.dataset.view === currentView;
    option.classList.toggle('is-active', on);
    option.setAttribute('aria-checked', on ? 'true' : 'false');
    option.tabIndex = on ? 0 : -1;
  }
  if (tableOn) {
    renderTable();
  } else {
    // The stage measured zero while hidden (measureNode / extent / edge
    // painting all skipped their work) — re-measure the real boxes, restore
    // the viewport offset, then let one repair sweep settle everything: a
    // search run in table mode can have re-shown hidden task rows, so cards
    // may have GROWN back since they were last sized, and growing can
    // re-admit overlaps. resolveCollisions also re-derives the extent and
    // repaints the edges; finally flush a font refresh deferred in the
    // table-mode detour.
    for (const key of viewState.els.keys()) measureNode(key);
    stageEl.scrollLeft = lastStageScroll.x;
    stageEl.scrollTop = lastStageScroll.y;
    resolveCollisions([]);
    if (pendingFontRefresh) {
      pendingFontRefresh = false;
      refreshAfterFonts();
    }
  }
  if (opts.save !== false) saveStateDebounced();
}

function setTableTab(kind, opts = {}) {
  if (!TABLE_SPECS[kind]) kind = 'project';
  currentTableTab = kind;
  for (const tab of tableTabsEl.querySelectorAll('.mm-table-tab')) {
    const on = tab.dataset.kind === kind;
    tab.classList.toggle('is-active', on);
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
    tab.tabIndex = on ? 0 : -1;
  }
  tablePanelEl.setAttribute('aria-labelledby', `mm-tab-${kind}`);
  if (opts.render !== false && currentView === 'table') renderTable();
  if (opts.save !== false) saveStateDebounced();
  }

function setupViewMode() {
  viewSwitchEl.addEventListener('click', e => {
    const option = e.target.closest('.proto-view-option');
    if (option) setView(option.dataset.view);
  });
  viewSwitchEl.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setView(currentView === 'table' ? 'canvas' : 'table');
    viewSwitchEl.querySelector('.proto-view-option.is-active').focus();
  });

  tableTabsEl.addEventListener('click', e => {
    const tab = e.target.closest('.mm-table-tab');
    if (tab) setTableTab(tab.dataset.kind);
  });
  // Manual tab-list keyboard pattern: arrows move + activate (tabs are
  // cheap to render), Home/End jump to the ends.
  tableTabsEl.addEventListener('keydown', e => {
    const tabs = [...tableTabsEl.querySelectorAll('.mm-table-tab')];
    const at = tabs.indexOf(document.activeElement);
    if (at < 0) return;
    let next = -1;
    if (e.key === 'ArrowRight') next = (at + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (at - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    e.preventDefault();
    setTableTab(tabs[next].dataset.kind);
    tabs[next].focus();
  });

  exportCsvBtn.addEventListener('click', () => {
    const spec = TABLE_SPECS[currentTableTab];
    const csv = buildCsv(currentTableTab, tableRowsFor(currentTableTab));
    downloadBlob(spec.filename, new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  });
  exportZipBtn.addEventListener('click', () => {
    const files = TABLE_KINDS.map(kind => ({
      name: TABLE_SPECS[kind].filename,
      data: buildCsv(kind, tableRowsFor(kind))
    }));
    downloadBlob('uap-projects-tables.zip',
      new Blob([zipStore(files)], { type: 'application/zip' }));
  });
}

// ---------------------------------------------------------------------------
// Table view — the canvas contents as three sortable tables. Each column
// owns one text() accessor that doubles as its CSV cell, so the export can
// never drift from what the table shows. The name column keeps the canvas
// click contract: clicking it opens the mirrored detail drawer.
// ---------------------------------------------------------------------------
function projectPartnerNames(project) {
  const names = new Set();
  for (const task of project.tasks) {
    for (const partner of task.PartnersList) names.add(partner);
  }
  return [...names].sort(collator.compare).join('; ');
}

const TABLE_SPECS = {
  project: {
    label: 'Projects',
    filename: 'uap-projects.csv',
    rows: () => projectNodes,
    isHit: (row, hits) => hits.projects.has(row.key),
    columns: [
      { label: 'Project', text: p => p.name, nameCell: true },
      { label: 'Project Id', text: p => p.id },
      { label: 'Website', text: p => p.url, linkCell: true },
      { label: 'Tasks', text: p => String(p.tasks.length), numeric: true },
      { label: 'IPs', text: p => String(distinctIpCount(p)), numeric: true },
      { label: 'Partners', text: projectPartnerNames }
    ],
    openDrawer: project => openProjectDrawer(project)
  },
  task: {
    label: 'Tasks',
    filename: 'uap-tasks.csv',
    rows: () => taskNodes,
    isHit: (row, hits) => hits.tasks.has(row.key),
    columns: [
      { label: 'Project', text: t => t.project },
      { label: 'Task Id', text: t => t.TaskId },
      { label: 'Title', text: t => t.Title, nameCell: true },
      { label: 'WI', text: t => t.WI },
      { label: 'Status', text: t => t.Status, statusCell: t => asArray(t.Status).filter(Boolean) },
      { label: 'Partners', text: t => t.Partners },
      { label: 'IPs', text: t => t.ipNames.join('; ') },
      { label: 'URL', text: t => t.URL, linkCell: true }
    ],
    openDrawer: task => openTaskDrawer(task)
  },
  ip: {
    label: 'IPs',
    filename: 'uap-ips.csv',
    rows: () => ipNodes,
    isHit: (row, hits) => hits.ips.has(row.Id),
    columns: [
      { label: 'Name', text: r => r.Name, nameCell: true },
      { label: 'Id', text: r => r.Id },
      { label: 'Category', text: r => asArray(r.Category).join('; ') },
      { label: 'Owners', text: r => asArray(r.Owners).join('; ') },
      { label: 'License', text: r => asArray(r.License).join('; ') },
      { label: 'Status', text: r => asArray(r.Status).join('; '), statusCell: r => asArray(r.Status).filter(Boolean) },
      { label: 'Tasks', text: r => String((r._taskDetails || []).length), numeric: true },
      { label: 'Repository', text: r => r.URL || '', linkCell: true },
      { label: 'IP Card JSON', text: r => r.IP_CARD_URL || '', linkCell: true, linkText: () => 'JSON', title: 'IP Card JSON URL' },
      { label: 'IP Card PDF', text: r => r.IP_CARD_PDF_URL || '', linkCell: true, linkText: () => 'PDF', title: 'IP Card PDF URL' }
    ],
    openDrawer: row => openIpDrawer(row)
  }
};

// Rows of one table: search-filtered (shared hit sets — an empty search
// means everything) and sorted by the tab's column; equal cells tie-break
// on the name column so re-renders never reshuffle equal rows.
function tableRowsFor(kind) {
  const spec = TABLE_SPECS[kind];
  const rows = spec.rows().filter(row => !mmSearchHits.active || spec.isHit(row, mmSearchHits));
  const sort = tableSortState[kind];
  const col = spec.columns[sort.col] || spec.columns[0];
  const nameCol = spec.columns.find(c => c.nameCell);
  return [...rows].sort((a, b) => {
    let cmp;
    if (col.numeric) cmp = (parseFloat(col.text(a)) || 0) - (parseFloat(col.text(b)) || 0);
    else cmp = collator.compare(col.text(a), col.text(b));
    if (cmp === 0) cmp = collator.compare(nameCol.text(a), nameCol.text(b));
    return sort.dir === 1 ? cmp : -cmp;
  });
}

function renderTable() {
  if (currentView !== 'table') return;
  const kind = currentTableTab;
  const spec = TABLE_SPECS[kind];
  const rows = tableRowsFor(kind);
  tablePanelEl.textContent = '';
  if (!rows.length) {
    tablePanelEl.appendChild(el('div', 'proto-empty', mmSearchText
      ? 'Nothing matches the current search.'
      : `No ${spec.label.toLowerCase()} in the catalogue yet.`));
    return;
  }

  const table = el('table', 'mm-data-table');
  // Visually hidden caption: accessible name of the table plus its current
  // sort (the aria-sort attributes on the th carry the per-column state).
  const sort = tableSortState[kind];
  table.appendChild(el('caption', null,
    `${spec.label} table, sorted by ${spec.columns[sort.col].label}, `
    + `${sort.dir === 1 ? 'ascending' : 'descending'}`));
  const headRow = el('tr');
  spec.columns.forEach((col, index) => {
    const th = el('th');
    th.scope = 'col';
    const sorted = tableSortState[kind].col === index;
    th.setAttribute('aria-sort', sorted
      ? (tableSortState[kind].dir === 1 ? 'ascending' : 'descending') : 'none');
    const button = el('button', 'mm-th-btn', col.label);
    button.type = 'button';
    button.title = `Sort by ${col.label}`;
    button.appendChild(icon(`fas ${sorted
      ? (tableSortState[kind].dir === 1 ? 'fa-sort-up' : 'fa-sort-down')
      : 'fa-sort'}`));
    button.addEventListener('click', () => {
      const sortState = tableSortState[kind];
      if (sortState.col === index) sortState.dir = -sortState.dir;
      else { sortState.col = index; sortState.dir = 1; }
      renderTable();
    });
    th.appendChild(button);
    headRow.appendChild(th);
  });
  const thead = el('thead');
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    for (const col of spec.columns) {
      const td = el('td');
      const value = col.text(row);
      if (col.nameCell) {
        // Same click contract as the canvas titles: open the detail drawer.
        const button = el('button', 'mm-table-name', value || 'n/a');
        button.type = 'button';
        button.setAttribute('aria-haspopup', 'dialog');
        button.title = 'Open details';
        button.addEventListener('click', () => spec.openDrawer(row));
        td.appendChild(button);
      } else if (col.statusCell) {
        for (const status of col.statusCell(row)) td.appendChild(statusPillEl(status));
      } else if (col.linkCell && isValidUrl(value)) {
        const a = el('a', 'mm-table-link', col.linkText ? col.linkText() : value);
        a.href = value;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.title = col.title || value;
        td.appendChild(a);
      } else if (col.numeric) {
        td.className = 'mm-table-num';
        td.textContent = value;
      } else {
        td.textContent = value || '';
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  tablePanelEl.appendChild(table);
}

// ---------------------------------------------------------------------------
// CSV / ZIP export — dependency-free (the prototype ships no libraries).
// The ZIP writer is store-only (method 0): no compression, no zlib, and the
// few hundred KB of CSV this page exports do not need either. Everything
// between the export markers is pure data-in / data-out.
// ---------------------------------------------------------------------------
// ==[export:begin]==
function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  // Spreadsheet formula-injection guard: a catalogue string must never
  // start an expression when the CSV is opened in Excel.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function concatBytes(parts) {
  let size = 0;
  for (const part of parts) size += part.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

let crcTableCache = null;
function getCrcTable() {
  if (!crcTableCache) {
    crcTableCache = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crcTableCache[i] = c >>> 0;
    }
  }
  return crcTableCache;
}

function crc32(bytes) {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// files: [{ name, data: string|Uint8Array }] -> Uint8Array (a valid store-only
// ZIP: local file headers + data, central directory, EOCD record).
function zipStore(files, when = new Date()) {
  const encode = new TextEncoder();
  const u16 = v => [v & 0xff, (v >>> 8) & 0xff];
  const u32 = v => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  const dosTime = ((when.getHours() & 31) << 11)
    | ((when.getMinutes() & 63) << 5) | (when.getSeconds() >> 1);
  const dosDate = (Math.max(when.getFullYear() - 1980, 0) << 9)
    | ((when.getMonth() + 1) << 5) | when.getDate();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = encode.encode(file.name);
    const data = typeof file.data === 'string' ? encode.encode(file.data) : file.data;
    const crc = crc32(data);
    const local = Uint8Array.from([
      ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0),
      ...u16(dosTime), ...u16(dosDate),
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(name.length), ...u16(0)
    ]);
    locals.push(local, name, data);
    centrals.push(Uint8Array.from([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0),
      ...u16(dosTime), ...u16(dosDate),
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(offset)
    ]), name);
    offset += local.length + name.length + data.length;
  }
  const body = concatBytes(locals);
  const central = concatBytes(centrals);
  const eocd = Uint8Array.from([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(files.length), ...u16(files.length),
    ...u32(central.length), ...u32(body.length), ...u16(0)
  ]);
  return concatBytes([body, central, eocd]);
}
// ==[export:end]==

// CSV of one table — the same column order and filter the table shows.
// UTF-8 BOM so Excel reads non-ASCII partners right; CRLF line endings per
// RFC 4180.
function buildCsv(kind, rows) {
  const spec = TABLE_SPECS[kind];
  const lines = [spec.columns.map(col => csvCell(col.label)).join(',')];
  for (const row of rows) lines.push(spec.columns.map(col => csvCell(col.text(row))).join(','));
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = filename;
  a.hidden = true;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---------------------------------------------------------------------------
// Toolbar & keyboard
// ---------------------------------------------------------------------------
resetBtn.addEventListener('click', () => {
  try {
    sessionStorage.removeItem(STATE_STORAGE_KEY);
    // Retired Tree|Map preference — cleaned up once the user resets.
    sessionStorage.removeItem('uap-proto-view');
  } catch { /* best effort */ }
  viewState.pinned.clear();
  viewState.ipCardLinks.clear();
  viewState.resized.clear();
  // A reset also leaves table mode behind — before buildView, which needs a
  // visible stage to measure the cards against.
  setTableTab('project', { render: false, save: false });
  setView('canvas', { save: false });
  buildView();
  lastStageScroll = { x: 0, y: 0 };
  stageEl.scrollLeft = 0;
  stageEl.scrollTop = 0;
  // The zeroing fires the (async) scroll listener, so the purged key is
  // re-created ~300 ms later — deliberately accepted: it stores exactly the
  // fresh default view, the same thing any later interaction would save.
  });

clearBtn.addEventListener('click', () => clearSelection());

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  // Production's priority chain (script.js setupDrawer): the topmost layer
  // closes first — drawer, then search, then the selection.
  if (drawerEl && !drawerEl.hidden) { closeDetailDrawer(); return; }
  if (searchEl.value) { clearCanvasSearch(); return; }
  clearSelection();
});

// Webfont metrics land after first paint: the uniform project width was then
// measured with fallback glyphs, so titles can end up truncated and measured
// heights slightly short (which re-admits overlaps). Once the fonts settle,
// re-derive the width — manually resized cards never contribute, a user size
// always wins — then re-measure every card and re-solve the collisions. If the
// fonts arrive before buildView() ran, the build measured with the final
// metrics anyway and this refresh is a no-op.
function refreshAfterFonts() {
  if (!projectNodes.length || !viewState.els.size) return;
  // A hidden (table-mode) stage measures zero — re-deriving the uniform
  // width then would collapse every card to the minimum. Defer it until the
  // canvas is shown again (setView flushes the pending flag).
  if (currentView !== 'canvas') { pendingFontRefresh = true; return; }
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
// Boot
// ---------------------------------------------------------------------------
let edgeRepaintFrame = 0;

function boot() {
  wireStagePan();
  setupDrawer();
  setupViewMode();
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
  // honest. The last live offset is remembered because a hidden (table-mode)
  // stage reports a scroll position of zero.
  stageEl.addEventListener('scroll', () => {
    // A hidden (table-mode) stage reports a scroll of 0 — such a spurious
    // event must not clobber the last live offset.
    if (stageEl.hidden) return;
    lastStageScroll = { x: stageEl.scrollLeft, y: stageEl.scrollTop };
    saveStateDebounced();
  }, { passive: true });
  window.addEventListener('resize', () => ensureCanvasExtent());
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(refreshAfterFonts);
  }
  load();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
