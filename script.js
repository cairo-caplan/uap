/*
 *-------------------------------------------------------------------------------
 * Copyright (C) 2025-2026 philippe / Eclipse Foundation
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 *-------------------------------------------------------------------------------
*/


// Configuration

const CATALOG_URL = 'cfg/catalog.json';
const PROJECTS_URL = 'cfg/projects.json';
const REPO_STATS_URL = 'cfg/repo-stats.json';

const REPO_STATS_COLUMN = 'Repo Stats';
const IP_CARD_COLUMN = 'IP Card';

// Columns shown per view (IP | Project). The card grid is always the Summary
// set; every other field stays reachable through the detail drawer ("Open
// Details"). The "Name" of a Task row is its Title, exposed under both keys so
// search over the legacy field name keeps working.
const COLUMN_SETS = {
  ip:      ["Name", "Category", "Owners", "License", "Status", IP_CARD_COLUMN, REPO_STATS_COLUMN, "Tasks"],
  project: ["Title", "WI", "IPs", "Partners", "Status", REPO_STATS_COLUMN, "Project"]
};
const columnLabels = { "IP_CARD_URL": "IP Card", "IP_CARD_PDF_URL": "IP Card PDF", [IP_CARD_COLUMN]: "IP Card", "Tasks": "Tasks (project · WI · title)" };

// Enumerated / limited fields rendered as pills in cards and in the drawer.
// "Status" is handled specially (state-based tint). Values map to a pill kind
// used for the `pill--{kind}` modifier class.
const PILL_FIELDS = {
  License: 'license',
  Owners: 'owner',
  Partners: 'partner',
  Project: 'project',
  Category: 'category',
  WI: 'wi'
};

// Columns that never get a filter button in the chip filter bar (free-text or
// synthetic fields whose values are not discrete filter facets).
const NON_FILTER_FIELDS = new Set([
  'Name', 'Title', 'URL', 'Description', 'Comment',
  'DefaultBranch', 'Branch', 'Tasks', REPO_STATS_COLUMN, IP_CARD_COLUMN
]);

let view = "ip";        // "ip" | "project"


// Cached DOM Elements
const statusEl   = document.getElementById('status');
const exportBtn  = document.getElementById('export-btn');
const fileInput  = document.getElementById('file-input');
const loadRadios = document.querySelectorAll('input[name="load-mode"]');
const cardGrid        = document.getElementById('card-grid');
const canvasStageEl   = document.getElementById('canvas-stage');
const canvasBarEl     = document.getElementById('canvas-bar');
const layoutSwitchEl  = document.getElementById('layout-switch');
const filterBar       = document.getElementById('filter-bar');
const activeFiltersEl = document.getElementById('active-filters');
const drawerEl        = document.getElementById('detail-drawer');
const drawerOverlay   = document.getElementById('drawer-overlay');
const drawerBody      = document.getElementById('drawer-body');
const drawerKind      = document.getElementById('drawer-kind');
const drawerTitle     = document.getElementById('drawer-title');

// Screen-reader live region for announcements (visually hidden but readable)
let srStatus = document.getElementById('sr-status');
if (!srStatus) {
  srStatus = document.createElement('div');
  srStatus.id = 'sr-status';
  srStatus.setAttribute('role', 'status');
  srStatus.setAttribute('aria-live', 'polite');
  // visually hide but keep available to assistive tech
  srStatus.style.position = 'absolute';
  srStatus.style.left = '-9999px';
  srStatus.style.width = '1px';
  srStatus.style.height = '1px';
  srStatus.style.overflow = 'hidden';
  document.body.appendChild(srStatus);
}

// State
let catalog      = null;   // the raw cfg/catalog.json aggregate
let ipDataset    = [];     // one row per IP
let taskDataset  = [];     // one row per Task (project view)
let masterData   = [];     // active dataset (ipDataset or taskDataset)
let filteredData = [];
let columns      = [];
let searchText   = '';
let filterState  = {};     // single source of truth: { column: [values] }
// Columns present (as keys) in the active dataset. Retained filters whose
// column is not in this set are kept but neither applied nor shown, so they
// are restored when switching back to the view where they belong.
let activeColumnKeys = new Set();
let projectsData = [];

// Relationship indices (built once per catalogue load) for the detail drawer:
//   ipById                : ipId       -> IP row
//   indexTasksByProject   : projectName-> [Task rows]
//   indexTasksByIp        : ipId       -> [{ projectName, taskRow }]
let ipById = new Map();
let indexTasksByProject = new Map();
let indexTasksByIp = new Map();

// Repository statistics cache: { generated_at, source, repos: {...}, errors: {...} }
// null when the cache could not be loaded at all.
let repoStats = null;
// lowercase "<host>/owner/repo" -> stats record, rebuilt whenever the cache is loaded.
let repoStatsIndex = new Map();
let visibleColumns = [];
let dataLoaded   = false;  // flag: true once loadCatalog finishes
let pendingSearch = null;  // stores search term from popstate until data is ready

async function loadProjectsData() {
  try {
    const response = await fetch(PROJECTS_URL);
    if (!response.ok) {
      throw new Error(`Failed to load projects: ${response.statusText}`);
    }
    projectsData = await response.json();
  } catch (error) {
    console.error(error);
    statusEl.textContent = 'Error: Could not load projects.';
  }
}

// Load the pre-computed repository statistics cache. Never throws: a missing
// or broken cache must not prevent the catalogue from rendering.
async function loadRepoStats() {
  try {
    const response = await fetch(REPO_STATS_URL);
    if (!response.ok) {
      throw new Error(`Failed to load repository stats: ${response.status}`);
    }
    const data = await response.json();
    if (!data || typeof data !== 'object' || typeof data.repos !== 'object') {
      throw new Error('Malformed repository stats cache');
    }
    repoStats = data;
    repoStatsIndex = new Map(
      Object.entries(data.repos).map(([key, value]) => [key.toLowerCase(), value])
    );
  } catch (error) {
    console.warn(error);
    repoStats = null;
    repoStatsIndex = new Map();
    statusEl.textContent = 'Catalogue loaded, but repository statistics are unavailable.';
  }
}

  // Compute the sorted filter-dropdown option list for a column, based on the
  // current masterData and filterState. Selected values first, then valid,
  // then invalid (grayed/disabled), each group alphabetical.
  function computeColumnFilterItems(col) {
  const allPossibleValues = [...new Set(masterData.flatMap(r => {
    const v = r[col];
    return Array.isArray(v) ? v : [v];
  }))].sort();

  const selectedValues = new Set(filterState[col] || []);

  // Only honour other-column filters that exist in the active dataset. A stray
  // query param (e.g. ?cb=… or ?utm_source=…) or a value retained from the
  // other view must not shrink this column's valid set (that would disable
  // every option). Matches the activeColumnKeys guard in applyFilters.
  const partiallyFilteredData = masterData.filter(row =>
    Object.entries(filterState).every(([filterCol, vals]) => {
      if (filterCol === col || !activeColumnKeys.has(filterCol)) return true;
      const cell = row[filterCol];
      return Array.isArray(cell)
        ? cell.some(v => vals.includes(String(v)))
        : vals.includes(String(cell));
    })
  );
  const validValues = new Set(partiallyFilteredData.flatMap(r => {
    const v = r[col];
    return Array.isArray(v) ? v : [v];
  }));

  const items = allPossibleValues.map(val => ({
    value: val,
    isSelected: selectedValues.has(val),
    isValid: validValues.has(val)
  }));

  items.sort((a, b) => {
    if (a.isSelected !== b.isSelected) return a.isSelected ? -1 : 1;
    if (a.isValid !== b.isValid) return a.isValid ? -1 : 1;
    return String(a.value ?? '').localeCompare(String(b.value ?? ''));
  });

  return items;
  }

// ---------------------------------------------------------------------------
// Search box — one funnel for every writer
//
// Typing, the clear button, the pendingSearch restore and the deep-link paths
// all go through setSearchText(), so the input, the clear button, the live hit
// count and the Projects canvas can never disagree about the needle.
// ---------------------------------------------------------------------------
const searchInputEl  = document.getElementById('search-input');
const searchClearEl  = document.getElementById('search-clear');
const searchStatusEl = document.getElementById('search-status');

let searchDebounce = null;

// Set the needle from raw (untrimmed, mixed-case) text. apply=false is for the
// callers that re-run applyFilters() themselves right afterwards.
function setSearchText(raw, { apply = true } = {}) {
  const value = String(raw ?? '');
  if (searchInputEl && searchInputEl.value !== value) searchInputEl.value = value;
  searchText = value.trim().toLowerCase();
  if (searchClearEl) searchClearEl.hidden = !searchText;
  updateSearchStatus();
  if (apply) applyFilters();
}

// The clear button cancels a pending debounce: the emptied box must win over
// the keystroke that is still on its way.
if (searchClearEl) {
  searchClearEl.addEventListener('click', () => {
    if (searchDebounce) clearTimeout(searchDebounce);
    setSearchText('');
    if (searchInputEl) searchInputEl.focus();
  });
}

// Debounced at 150 ms — rebuilding the card grid is heavier than a keystroke.
if (searchInputEl) {
  searchInputEl.addEventListener('input', () => {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => setSearchText(searchInputEl.value), 150);
  });
}

// Entry Point: Handle Load-Mode Switch
loadRadios.forEach(radio => {
  radio.addEventListener('change', async () => {
    resetTable();
    if (radio.value === 'server' && radio.checked) {
      fileInput.style.display = 'none';
      await Promise.all([loadProjectsData(), loadRepoStats()]);
      loadCatalog();
    }
    if (radio.value === 'local' && radio.checked) {
      fileInput.style.display = 'inline-block';
      statusEl.textContent = 'Select a catalogue, IP or project JSON file.';
      await Promise.all([loadProjectsData(), loadRepoStats()]);
    }
  });
});

// Local File Handling — accepts the catalogue aggregate, a single IP file, or
// a project file (useful to preview editor drafts before committing).
fileInput.addEventListener('change', async event => {
  const files = Array.from(event.target.files);
  if (!files.length) return;
  resetTable();
  try {
    await Promise.all([loadProjectsData(), loadRepoStats()]);
    statusEl.textContent = `Reading ${files.length} local file(s)…`;
    const docs = await Promise.all(files.map(file => new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          res(JSON.parse(reader.result));
        } catch (e) {
          rej(`Invalid JSON: ${file.name}`);
        }
      };
      reader.onerror = () => rej(`Read error: ${file.name}`);
      reader.readAsText(file);
    })));

    // Merge every document into one catalogue-shaped object.
    const merged = { ips: {}, projects: {} };
    for (const doc of docs) {
      if (!doc || typeof doc !== 'object') continue;
      if (doc.ips && doc.projects) {
        Object.assign(merged.ips, doc.ips);
        Object.assign(merged.projects, doc.projects);
      } else if (Array.isArray(doc.Tasks)) {
        merged.projects[doc.Id] = doc;
      } else if (doc.Id) {
        merged.ips[doc.Id] = doc;
      }
    }
    applyCatalog(merged);
    statusEl.textContent = 'Local files loaded.';
    srStatus.textContent = `${filteredData.length} items loaded from local files.`;
  } catch(err) {
    statusEl.textContent = 'Error: ' + err;
    console.error(err);
  }
});

// ---------------------------------------------------------------------------
// Catalogue loading and row building
//
// The runtime loads the single generated aggregate `cfg/catalog.json`
// (scripts/build_catalog.py regenerates it from ips/ + projects/ and CI
// commits it back — GitHub Pages runs no build). The per-file directory
// listing / repository-API discovery path is intentionally gone: one fetch
// is the only data request the page makes.
// ---------------------------------------------------------------------------
async function loadCatalog() {
  try {
    statusEl.textContent = `Fetching ${CATALOG_URL}…`;
    const response = await fetch(CATALOG_URL);
    if (!response.ok) {
      throw new Error(`Failed to load catalogue: ${response.status}`);
    }
    const data = await response.json();
    if (!data || typeof data !== 'object' || !data.ips || !data.projects) {
      throw new Error('Malformed catalogue aggregate');
    }
    applyCatalog(data);
    statusEl.textContent = 'Catalogue data loaded.';
    srStatus.textContent = `${filteredData.length} items loaded from the catalogue.`;
  } catch (err) {
    statusEl.textContent = 'Error: ' + (err.message || err);
    console.error(err);
  }
}

// Compact "TRISTAN · WI2.4.1 · UVM env for CVA6" pair string for an IP row.
function taskPairLabel(projectDoc, task) {
  const wi = Array.isArray(task.WI) ? task.WI.join('/') : (task.WI || '');
  return `${projectDoc.Name} · ${wi} · ${task.Title}`;
}

// Build the IP and Task datasets from a catalogue-shaped object.
function applyCatalog(data) {
  catalog = data;

  // --- IP rows -----------------------------------------------------------
  // Tasks touching this IP, collected across all project files.
  const tasksByIp = new Map();
  const projectDocs = Object.values(data.projects || {});
  for (const proj of projectDocs) {
    for (const task of (proj.Tasks || [])) {
      for (const ipRef of (Array.isArray(task.IPs) ? task.IPs : [task.IPs].filter(Boolean))) {
        if (!tasksByIp.has(ipRef)) tasksByIp.set(ipRef, []);
        tasksByIp.get(ipRef).push({ proj, task });
      }
    }
  }

  ipDataset = Object.values(data.ips || {}).map(ip => {
    const row = { ...ip };
    row.Owners = Array.isArray(ip.Owners) ? ip.Owners : [ip.Owners].filter(Boolean);
    row.Category = Array.isArray(ip.Category) ? ip.Category : [ip.Category].filter(Boolean);
    const refs = tasksByIp.get(ip.Id) || [];
    // Derived Tasks column: filterable list of project · WI · title pairs.
    row.Tasks = refs.map(r => taskPairLabel(r.proj, r.task));
    // Full task context, rendered in the IP detail drawer.
    row._taskDetails = refs;
    return row;
  });
  ipDataset.sort((a, b) => String(a.Name ?? '').localeCompare(String(b.Name ?? '')));

  // --- Task rows ---------------------------------------------------------
  taskDataset = [];
  for (const proj of projectDocs) {
    for (const task of (proj.Tasks || [])) {
      // Same row shape the detail drawer builds for an IP-view task reference.
      taskDataset.push(normalizeTaskRow(task, proj.Name));
    }
  }
  taskDataset.sort((a, b) => String(a.Title ?? '').localeCompare(String(b.Title ?? '')));

  buildRelationIndices();

  rebuildActiveDataset();
  dataLoaded = true;
  if (pendingSearch !== null) {
    setSearchText(pendingSearch, { apply: false });
    pendingSearch = null;
  }
  buildFilterBar();
  applyFilters();
  setInitialFilterSelections(parseFiltersFromQuery()); // Apply URL filters now
  // Hand the fresh datasets to the Projects canvas, then let the layout switch
  // decide which Projects layout is on screen (the filters above may already
  // have moved the page to the Project view).
  if (typeof window.UapCanvas?.onCatalogLoaded === 'function') window.UapCanvas.onCatalogLoaded();
  applyProjectLayout();
  exportBtn.disabled = false;
}

// Build the relationship indices used by the detail drawer. They invert the
// one-directional Task.IPs[] / Task.Partners[] references into lookups:
//   ipById                : IP id -> IP row        (drawer lookups)
//   indexTasksByProject   : project name -> [Task rows]
//   indexTasksByIp        : IP id -> [{ projectName, taskRow }]
function buildRelationIndices() {
  ipById = new Map(ipDataset.map(r => [r.Id, r]));
  indexTasksByProject = new Map();
  indexTasksByIp = new Map();
  for (const row of taskDataset) {
    const projName = row.Project;
    if (!indexTasksByProject.has(projName)) indexTasksByProject.set(projName, []);
    indexTasksByProject.get(projName).push(row);
    for (const ipId of (row.IPs || [])) {
      if (!indexTasksByIp.has(ipId)) indexTasksByIp.set(ipId, []);
      indexTasksByIp.get(ipId).push({ projectName: projName, taskRow: row });
    }
  }
}

// Swap masterData to the dataset of the active view and refresh the column
// projection. filterState is intentionally NOT pruned: filters on columns that
// belong to the other view are retained (see activeColumnKeys) so switching
// back restores them.
function rebuildActiveDataset() {
  masterData = view === 'ip' ? ipDataset : taskDataset;
  activeColumnKeys = new Set();
  for (const r of masterData) {
    for (const k of Object.keys(r)) if (!k.startsWith('_')) activeColumnKeys.add(k);
  }
  filteredData = [...masterData];
  deriveColumns();
}

// Helpers
function resetTable() {
  closePopover();
  masterData = [];
  filteredData = [];
  columns = [];
  activeColumnKeys = new Set();
  if (cardGrid) cardGrid.innerHTML = '';
  if (filterBar) filterBar.innerHTML = '';
  if (activeFiltersEl) { activeFiltersEl.hidden = true; activeFiltersEl.innerHTML = ''; }
  // The canvas mirrors the same datasets, so it empties with them.
  if (typeof window.UapCanvas?.onCatalogLoaded === 'function') window.UapCanvas.onCatalogLoaded();
  exportBtn.disabled = true;
}

// ---------------------------------------------------------------------------
// Filter state — single source of truth
//
// filterState holds { column: [values] }. Checkboxes write their column
// directly (via setFilterColumn) instead of reading the DOM of whichever
// popover happens to be open, and applyFilters() never overwrites unrelated
// columns. Intentional resets (URL / matrix deep links) go through
// setFilterState({ replace: true }).
// ---------------------------------------------------------------------------
function setFilterColumn(col, values) {
  if (Array.isArray(values) && values.length) filterState[col] = values.slice();
  else delete filterState[col];
}

function setFilterState(obj, { replace = false } = {}) {
  if (replace) filterState = {};
  for (const [col, vals] of Object.entries(obj || {})) {
    if (Array.isArray(vals) && vals.length) filterState[col] = vals.slice();
  }
}

// OR match of the free-text search box against every derived column.
function matchesSearch(row) {
  if (!searchText) return true;
  const hit = columns.some(col => {
    const cell = row[col];
    if (cell == null) return false;
    if (Array.isArray(cell)) return cell.some(v => String(v).toLowerCase().includes(searchText));
    return String(cell).toLowerCase().includes(searchText);
  });
  if (hit) return true;
  return [row['IP_CARD_URL'], row['IP_CARD_PDF_URL']].some(v => v && String(v).toLowerCase().includes(searchText));
}

// View-independent search columns for the live hit counts: matchesSearch()
// searches the ACTIVE view's `columns`, which would make the counts change when
// the dataset switch moves. These fixed lists mirror each view's own column set
// (plus the Task's referenced IP names, reachable from its IPs column).
const SEARCH_HIT_COLUMNS = {
  task: ['Title', 'TaskId', 'WI', 'Status', 'Partners', 'Description', 'URL', 'Comment', 'IPs'],
  ip:   ['Name', 'Id', 'Category', 'Owners', 'License', 'Status', 'Description', 'URL', 'Tasks']
};

function rowHitsColumn(row, text, col) {
  const cell = row[col];
  if (cell == null) return false;
  if (Array.isArray(cell)) return cell.some(v => v != null && String(v).toLowerCase().includes(text));
  return String(cell).toLowerCase().includes(text);
}

// The current needle's hits, shared by the status line and by the Projects
// canvas dimming: a Task hits on its own columns, on the names of the IPs it
// touches, or on its project's name; a Project hits on its own name or on any
// of its tasks; an IP hits like matchesSearch() does, IP Card URLs included.
// Column filters deliberately do NOT change these counts — they count the
// needle, which is what both Projects layouts apply to the cards.
function computeSearchHits(text) {
  const active = !!text;
  const hits = { active, projects: new Set(), tasks: new Set(), ips: new Set() };
  if (!active) return hits;

  for (const row of taskDataset) {
    const hit = SEARCH_HIT_COLUMNS.task.some(col => rowHitsColumn(row, text, col))
      || rowHitsColumn(row, text, 'Project')
      || (row.IPs || []).some(ipId => ipDisplayName(ipId).toLowerCase().includes(text));
    if (!hit) continue;
    hits.tasks.add(row);
    hits.projects.add(row.Project);
  }
  for (const proj of Object.values((catalog && catalog.projects) || {})) {
    const name = String((proj && proj.Name) ?? '');
    if (name.toLowerCase().includes(text)) hits.projects.add(name);
  }
  for (const row of ipDataset) {
    if (SEARCH_HIT_COLUMNS.ip.some(col => rowHitsColumn(row, text, col))
      || [row['IP_CARD_URL'], row['IP_CARD_PDF_URL']].some(v => v && String(v).toLowerCase().includes(text))) {
      hits.ips.add(row.Id);
    }
  }
  return hits;
}

// "3 projects · 26 tasks · 27 IPs match" under the search box. Hidden AND
// emptied when no needle is active, so no stale announcement lingers in the
// accessibility tree.
function updateSearchStatus() {
  if (!searchStatusEl) return;
  if (!searchText) {
    searchStatusEl.hidden = true;
    searchStatusEl.textContent = '';
    return;
  }
  const hits = computeSearchHits(searchText);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  searchStatusEl.hidden = false;
  searchStatusEl.textContent =
    `${plural(hits.projects.size, 'project')} · ${plural(hits.tasks.size, 'task')}`
    + ` · ${plural(hits.ips.size, 'IP')} match`;
}

// Recompute filteredData from filterState + searchText, render cards + chips.
// Only filters whose column exists in the active view are applied; the others
// stay in filterState for when that view is selected again.
function applyFilters() {
  const activeEntries = Object.entries(filterState).filter(
    ([col, vals]) => Array.isArray(vals) && vals.length && activeColumnKeys.has(col)
  );

  filteredData = masterData.filter(row =>
    activeEntries.every(([col, vals]) => {
      const cell = row[col];
      if (Array.isArray(cell)) return cell.some(v => vals.includes(String(v)));
      return vals.includes(String(cell));
    }) && matchesSearch(row)
  );

  // Cards are always listed alphabetically by name / task title (deterministic
  // collation). Previously the most "complete" rows came first.
  const titleKey = view === 'ip' ? 'Name' : 'Title';
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  filteredData.sort((a, b) =>
    collator.compare(String(a[titleKey] ?? ''), String(b[titleKey] ?? '')));

  // Announce filter results to assistive tech.
  try {
    const activeFilters = activeEntries.map(([c, vals]) => `${c}: ${vals.join(', ')}`).join('; ');
    srStatus.textContent = `${filteredData.length} results.` + (activeFilters ? ` Active filters: ${activeFilters}.` : '');
  } catch (e) {
    srStatus.textContent = `${filteredData.length} results.`;
  }

  renderActiveChips();
  // The grid keeps rendering even while the Projects canvas is on screen: the
  // filter chips, the announced result count and the drawer state stay honest,
  // and switching back to Grid shows the same rows without a re-filter.
  renderCards(filteredData);
  refreshFilterCounts();
  // The canvas dims its cards around the same needle (data-level semantics —
  // the column filters do not reach into the canvas, see applyProjectLayout).
  if (typeof window.UapCanvas?.applySearch === 'function') window.UapCanvas.applySearch();
  }

function isValidUrl(string) {
  if (!string) return false;
  try {
    // Parse and require an http(s) scheme: the result is used for clickable
    // hrefs built from catalogue data, so javascript:/data: must be rejected.
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Repository statistics helpers (GitHub + GitLab + Bitbucket)
// The key normalisation rules below must stay in sync with parse_repo_refs()
// (GithubProvider.parse_repos / GitlabProvider.parse_repos /
// BitbucketProvider.parse_repos) in scripts/fetch_repo_stats.py:
//   - GitHub: accepts github.com/{owner}/{repo}, optionally followed by
//     /tree/<ref>, /blob/<ref>/... (only owner/repo is kept)
//   - GitLab: any host containing "gitlab"; the first two path segments are
//     taken as group/project, everything from "/-/" onward and "#anchor" are
//     stripped. Known limitation: nested subgroups are not resolved.
//   - several URLs may be separated by ';' in one string
//   - trailing prose is tolerated: the slug stops at the first invalid character
//   - Bitbucket: accepts bitbucket.org/{workspace}/{repo} on the public host
//     only — self-hosted instances (bitbucket.sw.nxp.com, ...) need
//     authentication and stay ignored
//   - other hosts (vendor pages, ...) and empty values ignored
// Cache keys are lowercase "<host>/owner/repo".
// ---------------------------------------------------------------------------
// The lookbehind prevents matching other hosts such as
// "mirror.github.com/owner/repo"; a "www." subdomain is accepted.
const GITHUB_SLUG_RE = /(?<![A-Za-z0-9.\-])(?:www\.)?github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/g;
// GitLab project URLs: any scheme://host containing "gitlab", followed by at
// least two path segments (group/project). Requiring the scheme prevents false
// positives on paths such as github.com/gitlab-tools/foo.
const GITLAB_SLUG_RE = /https?:\/\/([A-Za-z0-9.\-]*gitlab[A-Za-z0-9.\-]*)\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/gi;
// Bitbucket project URLs on the public host only. Self-hosted instances are
// deliberately NOT resolved (their API needs authentication), so those URLs
// keep rendering "no repository statistics".
const BITBUCKET_SLUG_RE = /https?:\/\/bitbucket\.org\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/gi;

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
    // GitHub refs first, mirroring the Python provider order.
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
      // The regex character classes stop at '/' and '#', so "/-/tree/<ref>"
      // and "#anchor" never enter the captured segments. A trailing slash
      // yields an empty project segment and is skipped here.
      if (!group || !project) continue;
      push('gitlab', `${host}/${group}/${project}`);
    }
    const bbRe = new RegExp(BITBUCKET_SLUG_RE.source, 'gi');
    while ((match = bbRe.exec(chunk)) !== null) {
      const workspace = match[1].replace(/^\.+|\.+$/g, '');
      const slug = match[2].replace(/^\.+|\.+$/g, '');
      if (!workspace || !slug) continue;
      push('bitbucket', `bitbucket.org/${workspace}/${slug}`);
    }
  });
  return refs;
}

function lookupRepoStats(key) {
  if (!repoStatsIndex || !key) return null;
  const record = repoStatsIndex.get(key.toLowerCase());
  return record || null;
}

// Merge the stats of every GitHub/GitLab repo referenced by a row's URL field
// (canonical IP URL in the IP view, task URL in the Project view).
// Returns { repos: [{key, provider, record|null}], total: {...}|null } or null
// when the row references no known repository host at all.
function getRowRepoStats(row) {
  const refs = parseRepoRefs(row ? row['URL'] : '');
  if (!refs.length) return null;

  // Bitbucket's API exposes no stars/forks/commit counters, so its cache
  // record exists only as a logo source. Keeping it out of the statistics
  // path means a Bitbucket-only URL still renders exactly as it did before
  // Bitbucket was parsed at all.
  const statRefs = refs.filter(ref => ref.provider !== 'bitbucket');
  if (!statRefs.length) return null;

  const repos = statRefs.map(ref => ({ ...ref, record: lookupRepoStats(ref.key) }));
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

// Logo of the first repository a row references, for the IP-view card and
// the Projects canvas IP card. Uses every parsed ref — Bitbucket included —
// and returns '' when no cache record carries a logo (the card then renders
// no logo at all). The cache is written by scripts/fetch_repo_stats.py; the
// runtime never calls a repository API.
function getRepoLogoForIp(row) {
  for (const ref of parseRepoRefs(row ? row['URL'] : '')) {
    const record = lookupRepoStats(ref.key);
    const logo = record && record.logo;
    if (typeof logo === 'string' && logo.trim()) return logo.trim();
  }
  return '';
}

// The <img> widget shared by both production IP-card heads — the IP-view
// grid card (renderCards) and the Projects canvas card (projects-canvas.js
// renderIpCard): no logo means no element at all, and a logo that 404s
// removes itself instead of showing a broken-image icon. (The third
// IP-card renderer, the preview prototype script, is deliberately left
// without logos and awaits deletion.)
function buildRepoLogoImg(row, className) {
  const logoUrl = getRepoLogoForIp(row);
  if (!logoUrl) return null;
  const img = document.createElement('img');
  img.className = className;
  img.src = logoUrl;
  img.alt = '';
  // Avatars are square and sized 28 px by CSS — the attribute pair reserves
  // that box so the lazy load raises no layout-shift hint.
  img.width = 28;
  img.height = 28;
  img.loading = 'lazy';
  img.addEventListener('error', () => img.remove(), { once: true });
  return img;
}

// Compact "12d ago" / "3mo ago" style formatting for cache and push dates.
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

// Thousands separator for chip values (keeps cells narrow).
function formatStatNumber(value) {
  if (value === null || value === undefined) return '?';
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (value >= 10000) return `${Math.round(value / 1000)}k`;
  return value.toLocaleString('en-US');
}

// Provider/host prefix for the tooltip, e.g. "GitLab · gitlab.com".
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

// Build the content of the Repo Stats block for one row (into `container`).
function renderRepoStats(container, row) {
  const stats = getRowRepoStats(row);
  if (!stats) {
    const na = document.createElement('span');
    na.className = 'gh-stats-na';
    na.textContent = 'n/a';
    na.title = 'No GitHub or GitLab repository referenced for this entry (empty URL or a non-repository source).';
    container.appendChild(na);
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'gh-stats';

  if (!stats.total) {
    // Repositories are known but the cache has no (fresh) entry for them.
    const missing = document.createElement('span');
    missing.className = 'gh-stats-na';
    missing.textContent = 'n/a';
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
      const line = document.createElement('a');
      line.className = 'gh-stats-repo';
      line.textContent = entry.key;
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
    const chip = document.createElement('span');
    chip.className = 'gh-stat';
    const icon = document.createElement('i');
    icon.className = `fas ${iconClass}`;
    icon.setAttribute('aria-hidden', 'true');
    chip.appendChild(icon);
    chip.appendChild(document.createTextNode(formatStatNumber(value)));
    chip.title = `${label}: ${value === null ? 'unknown' : value}`;
    wrapper.appendChild(chip);
  };

  addChip('fa-star', t.stars, 'Stars');
  addChip('fa-code-fork', t.forks, 'Forks');
  addChip('fa-code-commit', t.commits, 'Commits');

  // GitLab's public API exposes no watchers/subscribers count: show n/a for
  // rows whose records have no watcher data at all.
  if (t.watchers === null && stats.repos.some(r => r.record)) {
    const chip = document.createElement('span');
    chip.className = 'gh-stat';
    const icon = document.createElement('i');
    icon.className = 'fas fa-eye';
    icon.setAttribute('aria-hidden', 'true');
    chip.appendChild(icon);
    chip.appendChild(document.createTextNode('n/a'));
    chip.title = 'Watchers: not exposed by the GitLab API.';
    wrapper.appendChild(chip);
  }

  if (t.archived) {
    const archived = document.createElement('span');
    archived.className = 'gh-stat gh-stat--archived';
    archived.textContent = 'archived';
    archived.title = 'The repository is marked as archived.';
    wrapper.appendChild(archived);
  }

  if (stats.repos.length === 1) {
    const record = stats.repos[0].record;
    if (record && record.html_url) {
      const line = document.createElement('a');
      line.className = 'gh-stats-repo';
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

// Human-readable label for an IP id referenced by a task.
function ipDisplayName(ipId) {
  const ip = catalog && catalog.ips && catalog.ips[ipId];
  return ip ? (ip.Name || ipId) : ipId;
}

// IP Card link icons (JSON / PDF) for a row, appended to `container`.
function renderIpCardLinks(container, row) {
  const iconSpecs = [
    { key: 'IP_CARD_URL',     cls: 'fas fa-file-code', title: 'Open IP Card (JSON)', aria: 'IP Card JSON' },
    { key: 'IP_CARD_PDF_URL', cls: 'fas fa-file-pdf',  title: 'Open IP Card (PDF)',  aria: 'IP Card PDF'  }
  ];
  iconSpecs.forEach(spec => {
    if (row[spec.key]) {
      const a = document.createElement('a');
      a.href = row[spec.key];
      a.className = 'ip-card-link';
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = spec.title;
      a.setAttribute('aria-label', spec.aria);
      const icon = document.createElement('i');
      icon.className = spec.cls;
      icon.setAttribute('aria-hidden', 'true');
      a.appendChild(icon);
      container.appendChild(a);
      }
      });
      }

      // ---------------------------------------------------------------------------
      // IP Card preview — lazily fetch and render the ip_cards/*.json(|jsonc)
  // document an IP row points at, inside the detail drawer.
  //
  // The migrated cards are messy: two different top-level shapes coexist under
  // schemaVersion "0.9", one is served as .jsonc (with // comments), several are
  // full of null / "NA" / "-" placeholders, and one carries LaTeX table debris
  // copied out of the source PDF. The renderer is therefore deliberately generic:
  // a small curated "hero" strip for the fields that matter, plus an
  // auto-generated, collapsible section per remaining top-level key, so a future
  // card shape still renders. isValidUrl() must stay http(s)-only (it guards many
  // hrefs), so the scheme-less hosts that appear *inside* card JSON are promoted
  // by httpUrl() on top of it — never by loosening isValidUrl itself.
  //
  // Fetches are lazy (only when a drawer needs them), cached per session, and
  // every async render is guarded by `drawerToken` so a stale fetch can never
  // paint over a different entity (see openDetailDrawer).
  // ---------------------------------------------------------------------------

  // Normalised reference to a card document for fetch(). ip_cards values are
  // relative (ip_cards/x.json) but cfg/schema-ip.json also allows full http(s)
  // URLs; both are fetched as-is (the drawer lives at the site root, so relative
  // resolution is correct). null for an empty value.
  function normaliseCardUrl(raw) {
  const value = String(raw ?? '').trim();
  return value || null;
  }

  // Promote a card-internal value to a clickable http(s) URL. Card JSON holds
  // scheme-less hosts ("www.nxp.com", "www.fentiss.com"); prepend https:// for
  // those, otherwise reject. Returns null for anything that is not a web URL.
  const SCHEMELESS_HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.\-]*\.)+[A-Za-z]{2,}(\/\S*)?$/;
  function httpUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (isValidUrl(trimmed)) return trimmed;
  if (SCHEMELESS_HOST_RE.test(trimmed)) {
    const candidate = 'https://' + trimmed;
    if (isValidUrl(candidate)) return candidate;
  }
  return null;
  }

  // camelCase / PascalCase key -> "Title Case" label for unknown sections.
  function humanizeKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^[a-z]/, c => c.toUpperCase())
    .trim();
  }

  // Human titles for the top-level keys both card shapes use. Unknown keys fall
  // back to humanizeKey() so a future schema still renders sensibly.
  const IP_CARD_SECTIONS = {
  basicInfo: 'Basic information',
  systemLevelInfo: 'System-level information',
  systemLevelFeatures: 'System-level features',
  interfaces: 'Interfaces',
  architecture: 'Architecture',
  microarchitecture: 'Micro-architecture',
  software: 'Software',
  integration: 'Integration',
  physicalImplementation: 'Physical implementation',
  deployment: 'Deployment & distribution'
  };

  // Placeholders the migrated PDF cards are full of — treated as "no value".
  // "Yes" / "No" stay meaningful and are not listed.
  const CARD_BLANK_VALUES = new Set(['', '-', 'NA', 'N/A', 'None', 'TBD']);

  function isBlankCardValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return CARD_BLANK_VALUES.has(value.trim());
  if (Array.isArray(value)) {
    return value.length === 0 || value.every(isBlankCardValue);
  }
  if (typeof value === 'object') {
    const vals = Object.values(value);
    return vals.length === 0 || vals.every(isBlankCardValue);
  }
  return false; // numbers and booleans (including 0 / false) are meaningful
  }

  // Remove // line and /* */ block comments from a .jsonc document. Single pass,
  // string-aware so URLs containing "//" survive. Harmless for plain .json.
  function stripJsonComments(text) {
  let out = '';
  let inString = false, inLine = false, inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === '\n') { inLine = false; out += ch; }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i++; }
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && next === '/') { inLine = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlock = true; i++; continue; }
    out += ch;
  }
  return out;
  }

  // Migrated cards carry LaTeX table debris copied out of the source PDF, e.g.
  // "\begin{tabular}[c]{@{}l@{}}https://github.com/…/tree/". Peel those command
  // wrappers (and a stray trailing backslash) off so the real payload — usually
  // a URL — survives and stays linkable. Never drops the payload itself.
  function cleanCardText(value) {
  if (typeof value !== 'string') return value;
  let text = value.replace(/\\(?:begin|end)\{tabular\}[^{]*\{(?:@\{\}|[^{}])*\}/g, '');
  text = text.replace(/^[\s\\]+/, '').replace(/\\+$/, '').trim();
  return text;
  }

  // In-memory cache of fetched card documents: URL -> settled result promise. A
  // rejected fetch is cached as an {ok:false} result too, so re-opening a drawer
  // never retries in a loop. The promise never rejects (rendering owns errors).
  const ipCardCache = new Map();

  function loadIpCard(url) {
  if (!ipCardCache.has(url)) ipCardCache.set(url, fetchIpCard(url));
  return ipCardCache.get(url);
  }

  async function fetchIpCard(url) {
  try {
    const response = await fetch(url, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    // .jsonc files are served as octet-stream, so read text and parse here
    // instead of response.json().
    let text = await response.text();
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // strip a UTF-8 BOM
    const data = JSON.parse(stripJsonComments(text));
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: (error && error.message) || String(error) };
  }
  }

  // Count non-blank leaf values, shown as a section badge.
  function countCardFields(value) {
  if (isBlankCardValue(value)) return 0;
  if (Array.isArray(value)) {
    return value.reduce((n, v) => n + (v && typeof v === 'object' ? countCardFields(v) : 1), 0);
  }
  if (value && typeof value === 'object') {
    return Object.values(value).reduce((n, v) => n + countCardFields(v), 0);
  }
  return 1;
  }

  // A single "label: value" line inside the preview (mirrors the drawer rows).
  function renderCardRow(key, value) {
  if (isBlankCardValue(value)) return null;
  const node = renderCardValueNode(value);
  if (!node) return null;
  const row = el('div', 'ipcard-row');
  const label = el('span', 'field-label');
  label.textContent = humanizeKey(key);
  const val = el('span', 'ipcard-row-value');
  val.appendChild(node);
  row.appendChild(label);
  row.appendChild(val);
  return row;
  }

  // The value half of a row: table / chips / nested group / scalar. Never
  // injects data via innerHTML — text always goes through textContent.
  function renderCardValueNode(value) {
  if (Array.isArray(value)) {
    const items = value.filter(v => !isBlankCardValue(v));
    if (!items.length) return null;
    const allObjects = items.every(v => v && typeof v === 'object' && !Array.isArray(v));
    if (allObjects) return renderCardTable(items);
    const allScalars = items.every(v => v == null || typeof v !== 'object');
    if (allScalars) {
      const chips = el('div', 'ipcard-chips');
      items.forEach(v => {
        const t = cleanCardText(v);
        if (isBlankCardValue(t)) return;
        chips.appendChild(renderPill(String(t), 'category'));
      });
      return chips.children.length ? chips : null;
    }
    // Mixed array: render each entry as its own block.
    const wrap = el('div', 'ipcard-group');
    items.forEach(v => {
      const node = renderCardValueNode(v);
      if (node) wrap.appendChild(node);
    });
    return wrap.children.length ? wrap : null;
  }
  if (value && typeof value === 'object') return renderCardGroup(value);
  return renderCardScalar(value);
  }

  // Nested plain object -> a labelled sub-group of rows.
  function renderCardGroup(obj) {
  const group = el('div', 'ipcard-group');
  for (const [k, v] of Object.entries(obj)) {
    const node = renderCardRow(k, v);
    if (node) group.appendChild(node);
  }
  return group.children.length ? group : null;
  }

  // Array of objects -> a table whose columns are the union of keys (first-seen
  // order), e.g. interfaces.inputArtifacts.
  function renderCardTable(items) {
  const keys = [];
  items.forEach(item => Object.keys(item).forEach(k => { if (!keys.includes(k)) keys.push(k); }));
  if (!keys.length) return null;
  const table = el('table', 'ipcard-table');
  const headRow = el('tr');
  keys.forEach(k => { const th = el('th'); th.textContent = humanizeKey(k); headRow.appendChild(th); });
  const thead = el('thead');
  thead.appendChild(headRow);
  const tbody = el('tbody');
  items.forEach(item => {
    const tr = el('tr');
    keys.forEach(k => {
      const td = el('td');
      const node = renderCardValueNode(item[k]);
      if (node) td.appendChild(node);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(thead);
  table.appendChild(tbody);
  return table;
  }

  // Scalar leaf: boolean -> Yes/No, web URL -> link, everything else -> text.
  function renderCardScalar(value) {
  if (typeof value === 'boolean') {
    const s = el('span', 'ipcard-text');
    s.textContent = value ? 'Yes' : 'No';
    return s;
  }
  const text = cleanCardText(value);
  if (isBlankCardValue(text)) return null;
  if (typeof value === 'number') {
    const s = el('span', 'ipcard-text');
    s.textContent = String(value);
    return s;
  }
  const url = httpUrl(String(text));
  if (url) {
    const a = el('a', 'ipcard-link');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = String(text);
    return a;
  }
  const s = el('span', 'ipcard-text');
  s.textContent = String(text);
  return s;
  }

  // Curated highlight strip from basicInfo (with top-level fallbacks), reusing
  // the existing pill widgets so the visual language matches the entity cards.
  // Returns a document fragment (hero row + provider line + ipType note).
  function renderIpCardHero(card) {
  const info = (card && typeof card === 'object' && card.basicInfo) || {};
  const pick = (...vals) => vals.find(v => !isBlankCardValue(v));
  const frag = document.createDocumentFragment();
  const hero = el('div', 'ipcard-hero');

  const addBadge = (label, value) => {
    if (isBlankCardValue(value)) return;
    const badge = el('span', 'ipcard-badge');
    const l = el('span', 'ipcard-badge-label');
    l.textContent = label;
    badge.appendChild(l);
    badge.appendChild(document.createTextNode(String(cleanCardText(value))));
    hero.appendChild(badge);
  };

  addBadge('Version', pick(info.version, card.version));
  const trl = pick(info.trl, card.trl);
  if (!isBlankCardValue(trl)) hero.appendChild(renderPill(String(trl), 'status'));
  const status = pick(info.status, card.status);
  if (!isBlankCardValue(status)) hero.appendChild(renderStatusPill(status));
  const license = pick(info.license, info.licensing, card.license);
  if (!isBlankCardValue(license)) hero.appendChild(renderPill(String(cleanCardText(license)), 'license'));
  const project = pick(info.project, card.project);
  const workItem = pick(info.workItem, card.workItem);
  const projWi = [project, workItem].filter(v => !isBlankCardValue(v)).map(v => String(v)).join(' · ');
  if (projWi) hero.appendChild(renderPill(projWi, 'project'));
  if (!isBlankCardValue(card && card.schemaVersion)) {
    const s = el('span', 'ipcard-badge ipcard-badge--schema');
    s.textContent = `schema v${card.schemaVersion}`;
    hero.appendChild(s);
  }
  const repoUrl = httpUrl(pick(info.repositoryURL, card.repositoryURL));
  if (repoUrl) {
    const a = el('a', 'ipcard-link ipcard-hero-link');
    a.href = repoUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'Repository';
    a.title = String(pick(info.repositoryURL, card.repositoryURL));
    hero.appendChild(a);
  }
  (Array.isArray(info.provider) ? info.provider : []).forEach(p => {
    if (!p || typeof p !== 'object') return;
    const name = pick(p.organizationName, Array.isArray(p.organizationAlias) && p.organizationAlias[0]);
    const shown = cleanCardText(name);
    if (!isBlankCardValue(shown)) hero.appendChild(renderPill(String(shown), 'owner'));
    (Array.isArray(p.organizationAlias) ? p.organizationAlias : []).forEach(al => {
      if (!isBlankCardValue(al)) hero.appendChild(renderPill(String(cleanCardText(al)), 'category'));
    });
  });

  if (hero.children.length) frag.appendChild(hero);

  const comment = info.ipType && info.ipType.comment;
  const note = cleanCardText(comment ? String(comment) : '');
  if (!isBlankCardValue(note)) {
    const p = el('p', 'ipcard-note');
    p.textContent = String(note);
    frag.appendChild(p);
  }
  return frag;
  }

  // One collapsible section per top-level key that is not consumed by the hero.
  function renderIpCardSection(key, value, open) {
  const content = renderCardValueNode(value);
  if (!content) return null;
  const section = el('details', 'ipcard-section');
  if (open) section.open = true;
  const summary = el('summary');
  const caret = el('span', 'ipcard-caret');
  caret.setAttribute('aria-hidden', 'true');
  summary.appendChild(caret);
  const label = el('span', 'ipcard-section-label');
  label.textContent = IP_CARD_SECTIONS[key] || humanizeKey(key);
  summary.appendChild(label);
  const count = countCardFields(value);
  if (count) {
    const c = el('span', 'ipcard-count');
    c.textContent = String(count);
    summary.appendChild(c);
  }
  section.appendChild(summary);
  const bodyWrap = el('div', 'ipcard-section-body');
  bodyWrap.appendChild(content);
  section.appendChild(bodyWrap);
  return section;
  }

  function ipcardLoading() {
  const d = el('div', 'ipcard-loading');
  d.textContent = 'Loading the IP Card…';
  return d;
  }

  function ipcardError(cardUrl) {
  const box = el('div', 'ipcard-error');
  box.textContent = 'The IP Card could not be loaded.';
  if (cardUrl) {
    box.appendChild(document.createTextNode(' Open it directly: '));
    const a = el('a', 'ipcard-link');
    a.href = cardUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = cardUrl.split('/').pop();
    box.appendChild(a);
  }
  return box;
  }

  function renderIpCardBody(body, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    body.appendChild(ipcardError(''));
    return;
  }
  const hero = renderIpCardHero(data);
  if (hero.childElementCount) body.appendChild(hero);

  // Everything except the schema marker and the fields the hero already shows.
  const entries = Object.entries(data)
    .filter(([key, value]) => key !== 'schemaVersion' && key !== 'basicInfo' && !isBlankCardValue(value));
  entries.forEach(([key, value], idx) => {
    const section = renderIpCardSection(key, value, idx < 2);
    if (section) body.appendChild(section);
  });

  const raw = el('details', 'ipcard-raw');
  const rawSummary = el('summary');
  rawSummary.textContent = 'Raw JSON';
  raw.appendChild(rawSummary);
  const pre = el('pre');
  pre.textContent = JSON.stringify(data, null, 2);
  raw.appendChild(pre);
  body.appendChild(raw);
  }

  function ipCardActionLink(text, href, isDownload) {
  const a = el('a', 'ipcard-action');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  if (isDownload) a.setAttribute('download', '');
  a.textContent = text;
  return a;
  }

  // Build the IP Card preview section into `mountEl`. `open` (default true)
  // renders and loads immediately; when false the whole panel is wrapped in a
  // collapsed <details> and the fetch is deferred to the first expand (used by
  // the Task drawer, which lists every related IP's card).
  function mountIpCardPreview(mountEl, ipRow, options = {}) {
  const open = options.open !== false;
  const cardUrl = normaliseCardUrl(ipRow && ipRow.IP_CARD_URL);
  if (!cardUrl) return;
  const token = drawerToken;

  const panel = el('div', 'ipcard');
  const head = el('div', 'ipcard-head');
  const icon = el('i', 'fas fa-id-card');
  icon.setAttribute('aria-hidden', 'true');
  head.appendChild(icon);
  const name = el('span', 'ipcard-name');
  name.textContent = 'IP Card';
  head.appendChild(name);
  const file = el('code', 'ipcard-file');
  file.textContent = cardUrl.split('/').pop();
  head.appendChild(file);
  const actions = el('div', 'ipcard-actions');
  actions.appendChild(ipCardActionLink('Open JSON', cardUrl, false));
  if (ipRow.IP_CARD_PDF_URL) actions.appendChild(ipCardActionLink('PDF card', ipRow.IP_CARD_PDF_URL, false));
  actions.appendChild(ipCardActionLink('Download JSON', cardUrl, true));
  head.appendChild(actions);
  panel.appendChild(head);

  const body = el('div', 'ipcard-body');
  body.appendChild(ipcardLoading());
  panel.appendChild(body);

  let container = panel;
  if (!open) {
    const details = el('details', 'ipcard-details');
    const summary = el('summary', 'ipcard-summary');
    const sIcon = el('i', 'fas fa-id-card');
    sIcon.setAttribute('aria-hidden', 'true');
    summary.appendChild(sIcon);
    const sLabel = el('span');
    sLabel.textContent = 'IP Card';
    summary.appendChild(sLabel);
    const sFile = el('code', 'ipcard-file');
    sFile.textContent = cardUrl.split('/').pop();
    summary.appendChild(sFile);
    details.appendChild(summary);
    details.appendChild(panel);
    container = details;
  }
  mountEl.appendChild(container);

  let loaded = false;
  const load = () => {
    if (loaded) return;
    loaded = true;
    body.innerHTML = '';
    body.appendChild(ipcardLoading());
    loadIpCard(cardUrl).then(result => {
      if (token !== drawerToken) return; // a different entity is open now
      body.innerHTML = '';
      if (result.ok) renderIpCardBody(body, result.data);
      else body.appendChild(ipcardError(cardUrl));
    });
  };

  if (open) {
    load();
  } else {
    container.addEventListener('toggle', () => { if (container.open) load(); });
  }
  }

  // IP view Tasks block (into `container`): compact clickable titles that open
  // each task in the detail drawer.
function renderTasksBlock(container, row) {
  const refs = row._taskDetails || [];
  const list = document.createElement('div');
  list.className = 'task-list';
  refs.forEach(({ proj, task }) => {
    const item = document.createElement('div');
    item.className = 'task-item';
    const wi = Array.isArray(task.WI) ? task.WI.join(', ') : (task.WI || '');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'task-link';
    btn.textContent = task.Title || '(untitled task)';
    btn.title = `${proj.Name} · ${wi}`;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openDetailDrawer('task', normalizeTaskRow(task, proj.Name));
    });
    item.appendChild(btn);
    const meta = document.createElement('span');
    meta.className = 'task-item-meta';
    meta.textContent = `${proj.Name} · ${wi}`;
    item.appendChild(meta);
    list.appendChild(item);
  });
  container.appendChild(list);
}

// Build a task-row-shaped object from a raw task + its project name. Used both
// for the Project-view dataset and for the detail drawer of an IP-view task
// reference, so the two never drift apart.
function normalizeTaskRow(task, projectName) {
  const ipIds = Array.isArray(task.IPs) ? task.IPs : [task.IPs].filter(Boolean);
  const firstIp = (catalog && catalog.ips && catalog.ips[ipIds[0]]) || {};
  const row = { ...task };
  row.Title = task.Title ?? '';
  // Legacy alias so search over "Name" keeps matching task titles.
  row.Name = row.Title;
  row.Project = projectName;
  // A task's repository is its own URL when it has one, otherwise the
  // canonical URL of the first IP it touches.
  row.URL = task.URL || firstIp.URL || '';
  row.IPs = ipIds;
  row.Partners = Array.isArray(task.Partners) ? task.Partners : [task.Partners].filter(Boolean);
  return row;
}

// ---------------------------------------------------------------------------
// Pills — compact rendering for enumerated fields.
// ---------------------------------------------------------------------------
function renderPill(value, kind, extraClass) {
  const span = document.createElement('span');
  span.className = `pill pill--${kind}` + (extraClass ? ` ${extraClass}` : '');
  span.textContent = value;
  return span;
}

// Status pills get a state-based tint; unknown statuses keep the neutral tone.
function renderStatusPill(value) {
  const key = String(value ?? '').trim().toLowerCase();
  const map = {
    'released': 'ok', 'stable': 'ok', 'active': 'ok',
    'tbd': 'unknown', 'provisional': 'unknown', 'planned': 'unknown',
    'in development': 'wip', 'development': 'wip', 'wip': 'wip', 'in progress': 'wip',
    'deprecated': 'deprecated', 'archived': 'deprecated', 'retired': 'deprecated'
  };
  const mod = map[key] ? ` pill-status--${map[key]}` : '';
  return renderPill(value, 'status', mod.trim());
}

// Project pill: small logo + name, opens the project drawer on click.
function renderProjectPill(container, projectName) {
  if (!projectName) { container.textContent = 'n/a'; return; }
  const proj = projectsData.find(p => p.name === projectName);
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'pill pill--project project-card';
  if (proj && proj.logo) {
    const img = document.createElement('img');
    img.className = 'project-card-logo';
    img.src = proj.logo;
    img.alt = '';
    img.loading = 'lazy';
    card.appendChild(img);
  }
  const label = document.createElement('span');
  label.textContent = projectName;
  card.appendChild(label);
  card.addEventListener('click', e => {
    e.stopPropagation();
    openDetailDrawer('project', projectName);
  });
  container.appendChild(card);
}

// IP names linked to their canonical URL when known (Project view).
function renderIpsCell(container, ipIds) {
  ipIds.forEach((ipId, idx) => {
    if (idx > 0) container.appendChild(document.createTextNode(', '));
    const ip = catalog && catalog.ips && catalog.ips[ipId];
    const label = ip ? (ip.Name || ipId) : ipId;
    if (ip && isValidUrl(ip.URL)) {
      const a = document.createElement('a');
      a.href = ip.URL;
      a.textContent = label;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      container.appendChild(a);
    } else {
      container.appendChild(document.createTextNode(label));
    }
  });
}

// ---------------------------------------------------------------------------
// Card rendering (replaces the old table for the platform page).
// ---------------------------------------------------------------------------

// A column is worth a card row only when the row actually carries a value:
// cards omit the row entirely instead of rendering an "—" / "n/a" placeholder.
function isRowValueEmpty(col, row) {
  if (col === IP_CARD_COLUMN) return !(row.IP_CARD_URL || row.IP_CARD_PDF_URL);
  if (col === REPO_STATS_COLUMN) {
    // Falsy when the row references no repository host, and total is null when
    // the cache holds no entry for the referenced repositories.
    const stats = getRowRepoStats(row);
    return !stats || !stats.total;
  }
  // A URL nobody can click is no value either.
  if (col === 'URL') return !isValidUrl(row.URL);
  const val = row[col];
  if (Array.isArray(val)) {
    return val.filter(v => v !== null && v !== undefined && String(v).trim() !== '').length === 0;
  }
  return val === null || val === undefined || String(val).trim() === '';
}

// Render the value for one column into a container, choosing the right widget:
// pills, repo stats, IP card icons, task list, links, or plain text.
function renderCardValue(container, col, row) {
  const val = row[col];
  const nonEmpty = Array.isArray(val) ? val.filter(Boolean) : (val ? [val] : []);

  if (col === REPO_STATS_COLUMN) { renderRepoStats(container, row); return; }
  if (col === IP_CARD_COLUMN) { container.className += ' card-meta-value--icons'; renderIpCardLinks(container, row); return; }
  if (col === 'Tasks') { renderTasksBlock(container, row); return; }
  if (col === 'IPs') {
    renderIpsCell(container, Array.isArray(val) ? val : [val].filter(Boolean));
    return;
  }
  if (col === 'Project') { renderProjectPill(container, row[col]); return; }
  if (col === 'Status') {
    container.className += ' card-meta-value--wrap';
    nonEmpty.forEach(v => container.appendChild(renderStatusPill(v)));
    return;
  }
  if (PILL_FIELDS[col]) {
    container.className += ' card-meta-value--wrap';
    nonEmpty.forEach(v => container.appendChild(renderPill(String(v), PILL_FIELDS[col])));
    return;
  }
  if (col === 'URL') {
    const a = document.createElement('a');
    a.href = row[col];
    a.textContent = row[col];
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    container.appendChild(a);
    return;
  }
  container.textContent = Array.isArray(val) ? val.join(', ') : (val ?? '');
}

// Emit one labelled meta row per column that carries a value ("no row without
// a value" — never a "—" placeholder). Shared by the grid cards and the
// Projects canvas cards so the two layouts cannot drift apart.
function renderCardMetaRows(metaEl, row, cols, titleKey) {
  for (const col of cols) {
    if (col === titleKey) continue;
    // In the Project view, "Name" is a legacy alias of the Title; skip it.
    if (view === 'project' && col === 'Name') continue;
    // Missing or empty value: no row at all (no "—" placeholder).
    if (isRowValueEmpty(col, row)) continue;
    const rowEl = document.createElement('div');
    rowEl.className = 'card-meta-row';
    const label = document.createElement('span');
    label.className = 'card-meta-label';
    label.textContent = columnLabels[col] || col;
    const value = document.createElement('span');
    value.className = 'card-meta-value';
    renderCardValue(value, col, row);
    rowEl.appendChild(label);
    rowEl.appendChild(value);
    metaEl.appendChild(rowEl);
  }
}

// Render the filtered rows as cards.
function renderCards(rows) {
  if (!cardGrid) return;
  cardGrid.innerHTML = '';

  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'card-empty';
    // Valid child of the #card-grid[role=list]; the #sr-status live region
    // already announces the result count to assistive tech.
    empty.setAttribute('role', 'listitem');
    empty.textContent = 'No results found.';
    cardGrid.appendChild(empty);
    return;
  }

  const titleKey = view === 'ip' ? 'Name' : 'Title';
  const frag = document.createDocumentFragment();

  rows.forEach(row => {
    const card = document.createElement('article');
    card.className = 'entity-card';
    card.setAttribute('role', 'listitem');

    // --- Header: repo logo + title (opens drawer) + external link ---
    const head = document.createElement('div');
    head.className = 'card-head';
    // Logo of the repository this IP points at (cfg/repo-stats.json),
    // through the same shared widget as the Projects canvas IP card.
    if (view === 'ip') {
      const logo = buildRepoLogoImg(row, 'card-logo');
      if (logo) head.appendChild(logo);
    }
    const title = document.createElement('button');
    title.type = 'button';
    title.className = 'card-title';
    const titleVal = row[titleKey] ?? '(untitled)';
    title.textContent = Array.isArray(titleVal) ? titleVal.join(', ') : titleVal;
    title.title = 'Open details';
    // The card title always opens the entity the row represents: an IP in the
    // IP view, a Task in the Project view (never "project", whose drawer takes
    // a project-name string, not a row object).
    title.addEventListener('click', () => openDetailDrawer(view === 'ip' ? 'ip' : 'task', row));
    head.appendChild(title);
    if (isValidUrl(row.URL)) {
      const ext = document.createElement('a');
      ext.className = 'card-ext';
      ext.href = row.URL;
      ext.target = '_blank';
      ext.rel = 'noopener noreferrer';
      ext.title = 'Open source / project repository';
      ext.setAttribute('aria-label', 'Open external link in a new tab');
      ext.innerHTML = '<i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i>';
      head.appendChild(ext);
    }
    card.appendChild(head);

    // --- Meta rows for the remaining columns ---
    const meta = document.createElement('div');
    meta.className = 'card-meta';
    renderCardMetaRows(meta, row, visibleColumns, titleKey);
    card.appendChild(meta);

    // Clicking anywhere on the card opens the drawer, like the title button
    // does. Interactive children (title, external link, project pills, task
    // links) handle their own clicks and the guard below keeps this handler
    // from firing for them as well.
    const openCardDrawer = () => openDetailDrawer(view === 'ip' ? 'ip' : 'task', row);
    card.addEventListener('click', e => {
      // Anchors and buttons do their own work; an <a> without href is inert and
      // still belongs to the card.
      if (e.target.closest('a[href], button')) return;
      // Dragging to select text inside a card must not summon the drawer.
      if (window.getSelection && String(window.getSelection())) return;
      openCardDrawer();
    });
    card.tabIndex = 0;
    card.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target !== card) return; // inner controls keep their own keys
      e.preventDefault();           // Space would scroll the page
      openCardDrawer();
    });

    frag.appendChild(card);
  });

  cardGrid.appendChild(frag);
}

// ---------------------------------------------------------------------------
// Filter bar — one popover button per filterable column + a chip strip.
// ---------------------------------------------------------------------------
let openPopover = null; // { el, col, btn, searchInput, listEl }

function cssEscape(v) {
  return String(v).replace(/["\\]/g, '\\$&');
}

function buildFilterBar() {
  if (!filterBar) return;
  closePopover();
  filterBar.innerHTML = '';
  const cols = visibleColumns.filter(c => !NON_FILTER_FIELDS.has(c));
  for (const col of cols) {
    const item = document.createElement('div');
    item.className = 'filter-item';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'filter-chip-btn';
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');

    const name = document.createElement('span');
    name.className = 'filter-chip-btn-label';
    name.textContent = columnLabels[col] || col;
    const count = document.createElement('span');
    count.className = 'filter-chip-btn-count';
    const caret = document.createElement('i');
    caret.className = 'fas fa-caret-down';
    caret.setAttribute('aria-hidden', 'true');

    btn.appendChild(name);
    btn.appendChild(count);
    btn.appendChild(caret);
    btn.addEventListener('click', e => { e.stopPropagation(); togglePopover(col, btn); });

    item.dataset.column = col;
    item.appendChild(btn);
    filterBar.appendChild(item);
    updateFilterCount(col);
  }
}

function filterItem(col) {
  return filterBar ? filterBar.querySelector(`.filter-item[data-column="${cssEscape(col)}"]`) : null;
}

function updateFilterCount(col) {
  const item = filterItem(col);
  if (!item) return;
  const n = (filterState[col] || []).length;
  const count = item.querySelector('.filter-chip-btn-count');
  if (count) count.textContent = n ? String(n) : '';
  item.querySelector('.filter-chip-btn')?.classList.toggle('is-active', n > 0);
}

// Re-sync every filter button's count badge + active state with filterState.
// Called from applyFilters so "Clear all", chip removal, and deep-link presets
// (which don't rebuild the bar) never leave stale badges behind.
function refreshFilterCounts() {
  if (!filterBar) return;
  filterBar.querySelectorAll('.filter-item[data-column]').forEach(item => {
    const col = item.dataset.column;
    const n = (filterState[col] || []).length;
    const count = item.querySelector('.filter-chip-btn-count');
    if (count) count.textContent = n ? String(n) : '';
    item.querySelector('.filter-chip-btn')?.classList.toggle('is-active', n > 0);
  });
}

function togglePopover(col, btn) {
  if (openPopover && openPopover.col === col) { closePopover(); return; }
  closePopover();
  openPopoverFor(col, btn);
}

function openPopoverFor(col, btn) {
  const pop = document.createElement('div');
  pop.className = 'filter-popover';
  // role="group" (not "menu"): the options are native checkboxes, not menu
  // items, and we do not implement menu arrow-key semantics.
  pop.setAttribute('role', 'group');
  pop.setAttribute('aria-label', `Filter ${columnLabels[col] || col}`);

  const search = document.createElement('input');
  search.type = 'text';
  search.placeholder = 'Search…';
  search.className = 'filter-popover-search';
  search.setAttribute('aria-label', 'Filter options');
  pop.appendChild(search);

  const list = document.createElement('div');
  list.className = 'filter-popover-list';
  pop.appendChild(list);

  document.body.appendChild(pop);

  // Position near the trigger button (fixed, so it is independent of scroll).
  const rect = btn.getBoundingClientRect();
  const popW = 260;
  let left = rect.left;
  if (left + popW > window.innerWidth - 8) left = window.innerWidth - popW - 8;
  pop.style.left = `${Math.max(8, left)}px`;
  pop.style.top = `${rect.bottom + 6}px`;

  const popover = { el: pop, col, btn, searchInput: search, listEl: list };
  openPopover = popover;
  btn.setAttribute('aria-expanded', 'true');

  renderPopoverList(popover, '');
  search.addEventListener('input', () => renderPopoverList(popover, search.value.trim().toLowerCase()));

  // Close on outside click.
  const outside = ev => {
    if (!pop.contains(ev.target) && ev.target !== btn) closePopover();
  };
  popover.outsideHandler = outside;
  setTimeout(() => document.addEventListener('click', outside), 0);
  search.focus();
}

// Rebuild (or filter) the checkbox list of a popover from filterState.
function renderPopoverList(popover, searchTerm) {
  const { col, listEl, searchInput } = popover;
  listEl.innerHTML = '';
  const items = computeColumnFilterItems(col);
  const filter = searchTerm ?? (searchInput ? searchInput.value.trim().toLowerCase() : '');
  if (!items.length) {
    const none = document.createElement('div');
    none.className = 'filter-popover-empty';
    none.textContent = 'No options.';
    listEl.appendChild(none);
    return;
  }
  for (const item of items) {
    const label = document.createElement('label');
    label.className = 'filter-option';
    if (!item.isValid && !item.isSelected) label.classList.add('is-invalid');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = item.value;
    cb.name = String(col);
    cb.checked = item.isSelected;
    cb.disabled = !item.isValid && !item.isSelected;
    cb.addEventListener('change', () => onPopoverCheck());

    const txt = document.createElement('span');
    txt.textContent = item.value;

    label.appendChild(cb);
    label.appendChild(txt);
    if (filter && !String(item.value).toLowerCase().includes(filter)) label.style.display = 'none';
    listEl.appendChild(label);
  }
}

// A checkbox toggled: write this column into filterState, re-run filters, then
// refresh the counts + re-sorted option list. Other columns are untouched.
function onPopoverCheck() {
  if (!openPopover) return;
  const { col, listEl } = openPopover;
  const checked = Array.from(listEl.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
  setFilterColumn(col, checked);
  applyFilters();
  updateFilterCount(col);
  renderPopoverList(openPopover); // re-sort/dim in place; search preserved
}

function closePopover() {
  if (!openPopover) return;
  const { el, btn } = openPopover;
  if (openPopover.outsideHandler) document.removeEventListener('click', openPopover.outsideHandler);
  if (el.parentNode) el.parentNode.removeChild(el);
  if (btn) btn.setAttribute('aria-expanded', 'false');
  openPopover = null;
}

// Active-filters chip strip: one removable chip per selected value + Clear all.
function renderActiveChips() {
  if (!activeFiltersEl) return;
  activeFiltersEl.innerHTML = '';
  const entries = Object.entries(filterState).filter(
    ([col, vals]) => Array.isArray(vals) && vals.length && activeColumnKeys.has(col)
  );
  if (!entries.length) { activeFiltersEl.hidden = true; return; }
  activeFiltersEl.hidden = false;

  const label = document.createElement('span');
  label.className = 'active-filters-label';
  label.textContent = 'Filters:';
  activeFiltersEl.appendChild(label);

  for (const [col, vals] of entries) {
    for (const val of vals) {
      const chip = document.createElement('span');
      chip.className = 'active-chip';
      const text = document.createElement('span');
      text.className = 'active-chip-text';
      text.textContent = val;
      text.title = `${columnLabels[col] || col}: ${val}`;
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'active-chip-x';
      x.setAttribute('aria-label', `Remove filter ${columnLabels[col] || col}: ${val}`);
      x.textContent = '×';
      x.addEventListener('click', () => removeFilterValue(col, val));
      chip.appendChild(text);
      chip.appendChild(x);
      activeFiltersEl.appendChild(chip);
    }
  }

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'active-filters-clear';
  clear.textContent = 'Clear all';
  clear.addEventListener('click', () => { filterState = {}; applyFilters(); if (openPopover) renderPopoverList(openPopover); });
  activeFiltersEl.appendChild(clear);
}

function removeFilterValue(col, val) {
  const cur = (filterState[col] || []).filter(v => v !== val);
  setFilterColumn(col, cur);
  applyFilters();
  updateFilterCount(col);
  if (openPopover && openPopover.col === col) renderPopoverList(openPopover);
}

// Human-readable CSV value for a cell. Needed for the Repo Stats column,
// whose data is not part of the row object.
function cellToCsv(col, row) {
  if (col === REPO_STATS_COLUMN) {
    const stats = getRowRepoStats(row);
    if (!stats) return 'n/a';
    if (!stats.total) {
      return `repos: ${stats.repos.map(r => r.key).join(' ')} (stats not refreshed yet)`;
    }
    const t = stats.total;
    const parts = [
      `stars=${t.stars ?? ''}`,
      `forks=${t.forks ?? ''}`,
      `commits=${t.commits ?? ''}`,
      `watchers=${t.watchers ?? ''}`,
      `open_issues=${t.open_issues ?? ''}`,
      `contributors=${t.contributors ?? ''}`,
      `last_push=${t.pushed_at ? t.pushed_at.slice(0, 10) : ''}`
    ];
    if (stats.repos.length > 1) {
      parts.unshift(`repos=${stats.repos.map(r => r.key).join(' ')}`);
    }
    return parts.join('; ');
    }
    if (col === IP_CARD_COLUMN) {
    return [row['IP_CARD_URL'], row['IP_CARD_PDF_URL']].filter(Boolean).join('; ');
    }
    if (col === 'Tasks') {
    return (row.Tasks || []).join(' | ');
    }
    if (col === 'IPs') {
    return (Array.isArray(row[col]) ? row[col] : [row[col]].filter(Boolean)).map(ipDisplayName).join('; ');
    }
    return (row[col] || '').toString();
    }

// CSV export
exportBtn.addEventListener('click', () => {
  if (!filteredData.length) return;
  const lines = [visibleColumns.join(',')];
  filteredData.forEach(r => {
    lines.push(visibleColumns.map(c => `"${cellToCsv(c, r).replace(/"/g,'""')}"`).join(','));
  });
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'table.csv'; a.click();
  URL.revokeObjectURL(url);
});

// Auto‐start server mode on first load
document.addEventListener('DOMContentLoaded', async () => {
  // trigger the default “server” radio
  document.querySelector('input[name="load-mode"][value="server"]')
          .dispatchEvent(new Event('change'));

  // Wire the new top-bar controls (view switcher, Projects layout switch)
  // + settings gear.
  setupViewSwitcher();
  setupLayoutSwitch();
  setupSettingsPanel();
  setupDrawer();
  // Restore the saved Projects layout. The canvas module owns the payload, so
  // the choice is read back from it (Canvas is the default with no state).
  projectLayout = typeof window.UapCanvas?.getLayout === 'function'
    ? window.UapCanvas.getLayout()
    : 'canvas';

  // Setup tab navigation and load compatibility matrix
  setupTabNavigation();
  await loadCompatibilityMatrixData();
  renderCompatibilityMatrix();
});

// ---------------------------------------------------------------------------
// Top-bar controls: dataset switcher (IPs / Projects).
// ---------------------------------------------------------------------------
function setViewButtons() {
  document.querySelectorAll('.view-switch-btn').forEach(btn => {
    const active = btn.dataset.view === view;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function setView(newView) {
  if (view === newView) { setViewButtons(); applyProjectLayout(); return; }
  view = newView;
  setViewButtons();
  onViewChanged();
}

// ---------------------------------------------------------------------------
// Projects layout — Canvas (floating cards, projects-canvas.js) | Grid (the
// card grid). Only the Projects dataset offers the choice; the IPs dataset is
// always the grid. The choice is stored inside the canvas module's session
// payload (sessionStorage['uap-canvas-state'].layout) so one key holds the
// whole Projects view state; a fresh browser session starts on Canvas.
// ---------------------------------------------------------------------------
let projectLayout = 'canvas';

function setProjectLayout(layout) {
  projectLayout = layout === 'grid' ? 'grid' : 'canvas';
  if (typeof window.UapCanvas?.saveLayout === 'function') window.UapCanvas.saveLayout(projectLayout);
  applyProjectLayout();
}

// Push (projectLayout, view) onto the DOM. Idempotent: called by the dataset
// switch, the layout switch, the tab switch and the catalogue load.
function applyProjectLayout() {
  const canvasOn = view === 'project' && projectLayout === 'canvas';
  if (layoutSwitchEl) layoutSwitchEl.hidden = view !== 'project';
  if (cardGrid) cardGrid.hidden = canvasOn;
  if (canvasBarEl) canvasBarEl.hidden = !canvasOn;
  if (canvasStageEl) canvasStageEl.hidden = !canvasOn;
  // Attribute filters cannot be shown on the canvas: the canvas search dims
  // the cards around the needle, while a column filter would have to REMOVE
  // cards, moving everything and invalidating the saved positions. The
  // #active-filters chips stay visible, so an active filter is never invisible,
  // and the grid keeps filtering underneath, so Grid re-applies on the spot.
  if (filterBar) filterBar.hidden = canvasOn;
  // The canvas needs a wider column than the 1100px reading width can give
  // its card grid; projects-canvas.css keys its max-width on this class.
  document.body.classList.toggle('uap-canvas-on', canvasOn);
  if (layoutSwitchEl) {
    layoutSwitchEl.classList.toggle('is-grid', projectLayout === 'grid');
    layoutSwitchEl.querySelectorAll('.uap-layout-option').forEach(option => {
      const on = option.dataset.layout === projectLayout;
      option.classList.toggle('is-active', on);
      option.setAttribute('aria-checked', on ? 'true' : 'false');
      option.tabIndex = on ? 0 : -1;
    });
  }
  if (typeof window.UapCanvas?.setActive === 'function') window.UapCanvas.setActive(canvasOn);
}

function setupLayoutSwitch() {
  if (!layoutSwitchEl) return;
  layoutSwitchEl.addEventListener('click', e => {
    const option = e.target.closest('.uap-layout-option');
    if (option) setProjectLayout(option.dataset.layout);
  });
  // Radiogroup semantics: the two options are radios in a group, so the arrow
  // keys move the selection — and activate it, both layouts are cheap to show.
  layoutSwitchEl.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setProjectLayout(projectLayout === 'canvas' ? 'grid' : 'canvas');
    layoutSwitchEl.querySelector('.uap-layout-option.is-active')?.focus();
  });
}

function setupViewSwitcher() {
  document.querySelectorAll('.view-switch-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setView(btn.dataset.view);
      // Returning to the catalogue view if we were on the matrix tab.
      switchTab('catalogue');
    });
  });
  setViewButtons();
}

// Gear button toggles the floating settings panel (data source + Export CSV +
// Edit link). Clicking the button toggles it; a click outside it, or Escape,
// closes it.
function setupSettingsPanel() {
  const btn = document.getElementById('settings-toggle-btn');
  const panel = document.getElementById('settings-panel');
  if (!btn || !panel) return;
  const setOpen = open => {
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  setOpen(false);
  btn.addEventListener('click', e => {
    e.stopPropagation();
    setOpen(panel.hidden);
  });
  document.addEventListener('click', e => {
    if (!panel.hidden && !panel.contains(e.target)) setOpen(false);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !panel.hidden) setOpen(false);
  });
  }

// Re-derive columns and re-render the cards for the new view. filterState is
// retained; only its visibility changes.
function onViewChanged() {
  rebuildActiveDataset();
  buildFilterBar();
  applyFilters();
  applyProjectLayout();
}

// Update visibleColumns for the active view.
function updateVisibleColumns() {
  const wanted = COLUMN_SETS[view] || COLUMN_SETS.ip;
  visibleColumns = columns.filter(col => wanted.includes(col));
  // If both Name and URL exist in the dataset, hide the URL column
  // from the visible columns because Name will be rendered as a
  // hyperlink using the URL value.
  if (columns.includes('Name') && columns.includes('URL')) {
    visibleColumns = visibleColumns.filter(c => c !== 'URL');
  }
  // Always move Project to the end of visibleColumns
	if (visibleColumns.includes('Project')) {
	  visibleColumns = visibleColumns.filter(c => c !== 'Project');
	  visibleColumns.push('Project');
	}
}

// When columns are derived, update visibleColumns for current view
function deriveColumns() {
  let raw = [...new Set(masterData.flatMap(r => Object.keys(r)))].filter(k => !k.startsWith('_'));
  // The task rows expose Title also under the legacy "Name" alias for search;
  // do not offer it as a second, duplicate column in the Project view.
  if (view === 'project' && raw.includes('Title')) {
    raw = raw.filter(k => k !== 'Name');
  }
  const ordered = [];
  const push = name => { if (raw.includes(name) && !ordered.includes(name)) ordered.push(name); };
  // Preferred leading order for both views.
  ['Id', 'Name', 'Title', 'Category', 'Owners', 'License', 'Status'].forEach(push);
  // Synthetic IP Card column: rendered from IP_CARD_URL/IP_CARD_PDF_URL raw
  // fields, which are otherwise not shown directly.
  if (raw.includes('IP_CARD_URL') || raw.includes('IP_CARD_PDF_URL')) ordered.push(IP_CARD_COLUMN);
  ['URL', 'DefaultBranch', 'Branch', 'IPs', 'Partners', 'Tasks', 'WI', 'TaskId', 'Description'].forEach(push);
  // Synthetic column: not a key of the data objects, rendered from the
  // pre-computed repository statistics cache.
  if (!ordered.includes(REPO_STATS_COLUMN)) ordered.push(REPO_STATS_COLUMN);
  raw.forEach(c => {
    if (ordered.includes(c) || c === 'Project' || c === 'IP_CARD_URL' || c === 'IP_CARD_PDF_URL') return;
    ordered.push(c);
  });
  if (raw.includes('Project'))  ordered.push('Project'); // ALWAYS LAST
  columns = ordered;
  updateVisibleColumns();
  }


  // ---------------------------------------------------------------------------
  // Detail drawer — relationship tree + card-style field pills for one entity.
  // ---------------------------------------------------------------------------
function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function sectionTitle(text) {
  const h = el('h3', 'drawer-section-title');
  h.textContent = text;
  return h;
}

function nodeButton(kind, arg, label, nodeClass) {
  const btn = el('button', `tree-node-link${nodeClass ? ' ' + nodeClass : ''}`);
  btn.type = 'button';
  btn.textContent = label;
  btn.addEventListener('click', () => openDetailDrawer(kind, arg));
  return btn;
}

function extLink(url) {
  const a = el('a', 'tree-ext');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.setAttribute('aria-label', 'Open in a new tab');
  a.innerHTML = '<i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i>';
  return a;
}

function countBadge(n) {
  const s = el('span', 'tree-count');
  s.textContent = String(n);
  return s;
}

function emptyNote(text) {
  const p = el('p', 'tree-empty');
  p.textContent = text;
  return p;
}

function sortRowsByTitle(rows) {
  return [...rows].sort((a, b) => String(a.Title ?? '').localeCompare(String(b.Title ?? '')));
}

// Field block: labelled value rows, values rendered with the same widgets as
// cards (pills, project logo, links).
function drawerField(labelText, buildFn) {
  const row = el('div', 'field-row');
  const label = el('span', 'field-label');
  label.textContent = labelText;
  const value = el('span', 'field-value');
  buildFn(value);
  row.appendChild(label);
  row.appendChild(value);
  return row;
}

function pillsInto(container, values, kind) {
  const arr = (Array.isArray(values) ? values : [values]).filter(Boolean);
  if (!arr.length) { container.textContent = 'n/a'; return; }
  arr.forEach(v => container.appendChild(renderPill(String(v), kind)));
}

function statusInto(container, values) {
  const arr = (Array.isArray(values) ? values : [values]).filter(Boolean);
  if (!arr.length) { container.textContent = 'n/a'; return; }
  arr.forEach(v => container.appendChild(renderStatusPill(v)));
}

function linkInto(container, url, text) {
  if (!isValidUrl(url)) { container.textContent = text ? text : 'n/a'; return; }
  const a = document.createElement('a');
  a.href = url;
  a.textContent = text || url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  container.appendChild(a);
}

function openDetailDrawer(type, arg) {
  if (!drawerEl) return;
  drawerToken++; // invalidate any in-flight IP Card render for a prior entity
  closePopover();
  // Remember what had focus (the card title / tree node) so closing the drawer
  // can restore it — but only when the drawer is currently closed, so
  // re-entrant navigation keeps the original trigger.
  if (drawerEl.hidden) lastFocusedEl = document.activeElement;
  if (type === 'project') renderProjectDrawer(arg);
  else if (type === 'ip') renderIpDrawer(arg);
  else if (type === 'task') renderTaskDrawer(arg);
  showDrawer();
  // Let the Projects canvas decorate the fresh drawer (IP show/hide toggles,
  // "Show on canvas"). The canvas module is optional: without it this event
  // simply has no listener.
  document.dispatchEvent(new CustomEvent('uap:drawer-render', { detail: { kind: type, row: arg } }));
}

function renderIpDrawer(row) {
  drawerKind.textContent = 'IP';
  drawerTitle.textContent = row.Name || row.Id || '(IP)';
  drawerBody.innerHTML = '';

  const fields = el('div', 'drawer-fields');
  if (row.Id) fields.appendChild(drawerField('Id', c => { c.textContent = row.Id; }));
  fields.appendChild(drawerField('Owners', c => pillsInto(c, row.Owners, 'owner')));
  if (row.Category) fields.appendChild(drawerField('Category', c => pillsInto(c, row.Category, 'category')));
  if (row.License) fields.appendChild(drawerField('License', c => pillsInto(c, row.License, 'license')));
  if (row.Status) fields.appendChild(drawerField('Status', c => statusInto(c, row.Status)));
  if (row.DefaultBranch) fields.appendChild(drawerField('Default branch', c => { c.textContent = row.DefaultBranch; }));
  fields.appendChild(drawerField('Repository', c => linkInto(c, row.URL)));
  if (row.IP_CARD_URL || row.IP_CARD_PDF_URL) fields.appendChild(drawerField('IP Card', c => renderIpCardLinks(c, row)));
  if (row.Description) fields.appendChild(drawerField('Description', c => { c.textContent = row.Description; }));
  if (row.Comment) fields.appendChild(drawerField('Comment', c => { c.textContent = row.Comment; }));
  fields.appendChild(drawerField('Statistics', c => renderRepoStats(c, row)));
  drawerBody.appendChild(fields);

  if (row.IP_CARD_URL) {
    drawerBody.appendChild(sectionTitle('IP Card'));
    const cardMount = el('div');
    drawerBody.appendChild(cardMount);
    mountIpCardPreview(cardMount, row, { open: true });
  }

  drawerBody.appendChild(sectionTitle('Used by'));
  drawerBody.appendChild(ipTree(row.Id));
}

function renderTaskDrawer(row) {
  drawerKind.textContent = 'Task';
  drawerTitle.textContent = row.Title || row.TaskId || '(task)';
  drawerBody.innerHTML = '';

  const fields = el('div', 'drawer-fields');
  if (row.TaskId) fields.appendChild(drawerField('Task id', c => { c.textContent = row.TaskId; }));
  if (row.WI) fields.appendChild(drawerField('WI', c => pillsInto(c, row.WI, 'wi')));
  fields.appendChild(drawerField('Project', c => renderProjectPill(c, row.Project)));
  if (row.Partners && row.Partners.length) fields.appendChild(drawerField('Partners', c => pillsInto(c, row.Partners, 'partner')));
  if (row.Status) fields.appendChild(drawerField('Status', c => statusInto(c, row.Status)));
  if (row.Branch) fields.appendChild(drawerField('Branch', c => { c.textContent = row.Branch; }));
  if (row.URL) fields.appendChild(drawerField('URL', c => linkInto(c, row.URL)));
  fields.appendChild(drawerField('Statistics', c => renderRepoStats(c, row)));
  if (row.Description) fields.appendChild(drawerField('Description', c => { c.textContent = row.Description; }));
  if (row.Comment) fields.appendChild(drawerField('Comment', c => { c.textContent = row.Comment; }));
  drawerBody.appendChild(fields);

  // Tasks inherit IP Cards from the IPs they touch — show each collapsed and
  // load on demand. ipById.get() is guarded (unknown ids fall back elsewhere).
  const cardIps = (row.IPs || []).map(id => ipById.get(id)).filter(ip => ip && ip.IP_CARD_URL);
  if (cardIps.length) {
    drawerBody.appendChild(sectionTitle('IP cards'));
    cardIps.forEach(ip => {
      const cardMount = el('div');
      drawerBody.appendChild(cardMount);
      mountIpCardPreview(cardMount, ip, { open: false });
    });
  }

  drawerBody.appendChild(sectionTitle('Related IPs & partners'));
  drawerBody.appendChild(taskTree(row));
}

function renderProjectDrawer(projectName) {
  drawerKind.textContent = 'Project';
  drawerTitle.textContent = projectName || '(project)';
  drawerBody.innerHTML = '';

  const proj = projectsData.find(p => p.name === projectName);
  const fields = el('div', 'drawer-fields');
  if (proj && proj.logo) {
    const row = el('div', 'field-row field-row--logo');
    const img = el('img', 'project-logo');
    img.src = proj.logo;
    img.alt = projectName;
    img.loading = 'lazy';
    row.appendChild(img);
    if (isValidUrl(proj.url)) {
      const a = el('a', 'project-url');
      a.href = proj.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = proj.url;
      row.appendChild(a);
    }
    fields.appendChild(row);
  }
  drawerBody.appendChild(fields);

  drawerBody.appendChild(sectionTitle('Tasks'));
  drawerBody.appendChild(projectTree(projectName));
}

// IP -> each Project that has >=1 task referencing this IP -> those Tasks.
function ipTree(ipId) {
  const entries = indexTasksByIp.get(ipId) || [];
  if (!entries.length) return emptyNote('No project tasks reference this IP yet.');
  const byProject = new Map();
  for (const e of entries) {
    if (!byProject.has(e.projectName)) byProject.set(e.projectName, []);
    byProject.get(e.projectName).push(e.taskRow);
  }
  const root = el('ul', 'tree tree-root');
  const projects = [...byProject.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  for (const [projName, rows] of projects) {
    const li = el('li', 'tree-group');
    // Header row: collapse toggle + project navigation button + count, kept as
    // siblings (a <button> nested in <summary> would be invalid HTML).
    const head = el('div', 'tree-group-head');
    const toggle = el('button', 'tree-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', `Toggle tasks for ${projName}`);
    toggle.innerHTML = '<i class="fas fa-caret-down" aria-hidden="true"></i>';
    head.appendChild(toggle);
    head.appendChild(nodeButton('project', projName, projName, 'tree-node--project'));
    head.appendChild(countBadge(rows.length));
    li.appendChild(head);

    const sub = el('ul', 'tree-sub');
    for (const r of sortRowsByTitle(rows)) {
      const li2 = el('li');
      li2.appendChild(nodeButton('task', r, r.Title || r.TaskId || '(task)', 'tree-node--task'));
      if (isValidUrl(r.URL)) li2.appendChild(extLink(r.URL));
      sub.appendChild(li2);
    }
    li.appendChild(sub);
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
      sub.hidden = open;
    });
    root.appendChild(li);
  }
  return root;
  }

// Task -> its IP(s) (via ipById) and its Partners.
function taskTree(row) {
  const root = el('ul', 'tree tree-root');
  for (const ipId of (row.IPs || [])) {
    const ip = ipById.get(ipId);
    const li = el('li');
    const label = ip ? (ip.Name || ipId) : ipDisplayName(ipId);
    li.appendChild(nodeButton('ip', ip || { Id: ipId, Name: label }, label, 'tree-node--ip'));
    if (ip && isValidUrl(ip.URL)) li.appendChild(extLink(ip.URL));
    root.appendChild(li);
  }
  for (const partner of (row.Partners || [])) {
    const li = el('li');
    const s = el('span', 'tree-node tree-node--partner');
    s.textContent = partner;
    li.appendChild(s);
    root.appendChild(li);
  }
  if (!root.children.length) return emptyNote('No related IPs or partners.');
  return root;
}

// Project -> its Tasks.
function projectTree(projectName) {
  const rows = (indexTasksByProject.get(projectName) || []);
  if (!rows.length) return emptyNote('No tasks in this project yet.');
  const root = el('ul', 'tree tree-root');
  for (const r of sortRowsByTitle(rows)) {
    const li = el('li');
    li.appendChild(nodeButton('task', r, r.Title || r.TaskId || '(task)', 'tree-node--task'));
    if (isValidUrl(r.URL)) li.appendChild(extLink(r.URL));
    root.appendChild(li);
  }
  return root;
}

let drawerEndHandler = null;
// Monotonic id bumped on every drawer open. Async IP Card renders capture it
// and bail out if it changed, so a stale fetch can never paint over a different
// entity (or fight closeDetailDrawer()).
let drawerToken = 0;
// Element focused before the drawer opened, restored when it closes.
let lastFocusedEl = null;

function showDrawer() {
  // Cancel any pending slide-out cleanup from a previous close.
  if (drawerEndHandler) {
    drawerEl.removeEventListener('transitionend', drawerEndHandler);
    drawerEndHandler = null;
  }
  drawerEl.hidden = false;
  drawerEl.setAttribute('aria-hidden', 'false');
  drawerOverlay.hidden = false;
  // Force a reflow so the slide-in transition runs.
  void drawerEl.offsetWidth;
  drawerEl.classList.add('open');
  const closeBtn = drawerEl.querySelector('.drawer-close');
  if (closeBtn) closeBtn.focus();
}

function closeDetailDrawer() {
  if (!drawerEl || drawerEl.hidden) return;
  drawerEl.classList.remove('open');
  // Restore focus BEFORE aria-hidden goes on. A control inside the drawer can
  // be the one closing it (the canvas "Show on canvas" button, or Escape while
  // the drawer's own close button has focus), and hiding a subtree that still
  // holds the focus trips Chrome's "Blocked aria-hidden" warning.
  if (lastFocusedEl && typeof lastFocusedEl.focus === 'function') {
    lastFocusedEl.focus();
  }
  // Restoring can be a no-op (the opener was document.body, or a canvas
  // re-render dropped it): the focus has to be out before aria-hidden lands.
  if (drawerEl.contains(document.activeElement)) {
    document.activeElement.blur();
  }
  lastFocusedEl = null;
  drawerEl.setAttribute('aria-hidden', 'true');
  drawerOverlay.hidden = true;
  // Hide after the drawer's own transform transition finishes. Guard on the
  // target + property: transitionend bubbles, so child transitions must not
  // trigger this, and reopening mid-slide must not hide an open drawer.
  const onEnd = e => {
    if (e.target !== drawerEl || e.propertyName !== 'transform') return;
    drawerEl.removeEventListener('transitionend', onEnd);
    drawerEndHandler = null;
    if (!drawerEl.classList.contains('open')) drawerEl.hidden = true;
  };
  if (drawerEndHandler) drawerEl.removeEventListener('transitionend', drawerEndHandler);
  drawerEndHandler = onEnd;
  drawerEl.addEventListener('transitionend', onEnd);
  // Fallback in case transitionend never fires (reduced motion, etc.).
  setTimeout(() => {
    if (!drawerEl.classList.contains('open')) drawerEl.hidden = true;
  }, 350);
}

function setupDrawer() {
  const closeBtn = drawerEl.querySelector('.drawer-close');
  if (closeBtn) closeBtn.addEventListener('click', closeDetailDrawer);
  if (drawerOverlay) drawerOverlay.addEventListener('click', closeDetailDrawer);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    // The topmost layer closes first: popover, drawer, search, and only then
    // the Projects canvas selection.
    if (openPopover) { closePopover(); return; }
    if (drawerEl && !drawerEl.hidden) { closeDetailDrawer(); return; }
    if (searchText) { setSearchText(''); return; }
    if (typeof window.UapCanvas?.clearSelection === 'function') window.UapCanvas.clearSelection();
  });
}

// Preselect filters
// 1) Through GET method, which is embedded on the URL
//    Ex: ?filter_Project=TRISTAN or ?filter_Project=TRISTAN,ISOLDE
// 2) POST method, through postMessage from a parent frame:
//    Ex: window.postMessage({ type: 'setFilters', filters: { Project: ['TRISTAN'] } }, '*')

function parseFiltersFromQuery() {
  const params = new URLSearchParams(window.location.search || '');
  const filters = {};
  // Only accept params that name a real dataset column. This keeps documented
  // deep links (?Project=TRISTAN, ?filter_License=…X) working while ignoring
  // stray params (cache-busters, ?utm_source=…, analytics) that would otherwise
  // pollute filterState. Union of both views' columns so cross-view deep links
  // resolve regardless of the currently active view.
  const known = new Set([
    ...new Set([...ipDataset, ...taskDataset].flatMap(r => Object.keys(r)))
  ]);
  for (const [k,v] of params.entries()) {
    // Accept either filter_<Column>=v or plain column param like Project=TRISTAN
    const col = k.startsWith('filter_') ? k.replace(/^filter_/, '') : k;
    if (!known.has(col)) continue;
    filters[col] = v.split(',').map(s=>decodeURIComponent(s).trim()).filter(Boolean);
  }
  return filters;
  }

// Apply preset filters (URL / postMessage). Deep links targeting a column of
// the other view switch to that view first so the link keeps working. These
// are the intentional "reset" points: the preset replaces filterState.
function setInitialFilterSelections(filters) {
  if (!filters || Object.keys(filters).length === 0) return;
  const keys = Object.keys(filters);
  const wantsProject = keys.includes('Project') || keys.includes('WI') || keys.includes('TaskId');
  const wantsIp = keys.some(k => ['Id', 'Owners', 'Name', 'Category'].includes(k));
  const targetView = wantsProject && !wantsIp ? 'project' : (wantsIp ? 'ip' : null);
  if (targetView && targetView !== view) {
    view = targetView;
    setViewButtons();
    rebuildActiveDataset();
    buildFilterBar();
  }
  setFilterState(filters, { replace: true });
  applyFilters();
}

// Accept filters via postMessage for cross-document embedding
window.addEventListener('message', (ev) => {
  try {
    const msg = ev.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'setFilters' && msg.filters) {
      // If the table is already built, apply immediately; otherwise store and apply after build
      setInitialFilterSelections(msg.filters);
    }
  } catch (e) {
    console.debug('Ignored message', e);
  }
});


// Compatibility Matrix section
let cfgMatrixData = null;

async function loadCompatibilityMatrixData() {
  try {
    const response = await fetch('cfg/compatibility-matrix.json');
    if (!response.ok) {
      throw new Error(`Failed to load compatibility matrix: ${response.statusText}`);
    }
    cfgMatrixData = await response.json();
  } catch (error) {
    console.error(error);
  }
}

function renderCompatibilityMatrix() {
  const table = document.getElementById('compatibility-table');
  if (!table || !cfgMatrixData) return;

  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');

  thead.innerHTML = '';
  tbody.innerHTML = '';

  function addMatrixHover(cell) {
    const colIndex = cell.cellIndex;
    const row = cell.parentElement;
    row.querySelectorAll('td, th').forEach(c => c.classList.add('matrix-row-highlight'));
    const headerCell = thead.querySelectorAll('tr')[0]?.children[colIndex];
    if (headerCell) headerCell.classList.add('matrix-col-highlight');
    tbody.querySelectorAll('tr').forEach(tr => {
      const cellInCol = tr.children[colIndex];
      if (cellInCol) cellInCol.classList.add('matrix-col-highlight');
    });
  }

  function clearMatrixHover() {
    table.querySelectorAll('.matrix-row-highlight, .matrix-col-highlight').forEach(el => {
      el.classList.remove('matrix-row-highlight', 'matrix-col-highlight');
    });
  }

  // Create Header Row
  const headerRow = document.createElement('tr');
  const thEmpty = document.createElement('th');
  thEmpty.textContent = 'Technical contribution per Processor family';
  headerRow.appendChild(thEmpty);

  cfgMatrixData.columns.forEach(col => {
    const th = document.createElement('th');
    const link = document.createElement('a');
    link.href = '#';
    link.textContent = col.name;
    link.style.cursor = 'pointer';
    link.style.textDecoration = 'underline';
    link.style.color = 'inherit';
    link.addEventListener('click', (e) => {
      e.preventDefault();
      switchToCatalogue(col.ipName, col.project);
    });
    th.appendChild(link);
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);

  // Create Data Rows
  cfgMatrixData.rows.forEach(row => {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    const displayName = row.officialName || row.name;
    const ipName = row.ipName || row.name;
    const link = document.createElement('a');
    link.href = '#';
    link.textContent = displayName;
    link.style.cursor = 'pointer';
    link.style.textDecoration = 'underline';
    link.style.color = '#0056b3';
    link.addEventListener('click', (e) => {
      e.preventDefault();
      switchToCatalogue(ipName, row.project);
    });
    tdName.appendChild(link);
    tr.appendChild(tdName);

    row.values.forEach(val => {
      const td = document.createElement('td');
      if (val === 'CT') td.className = 'cell-ct';
      else if (val === 'CNT') td.className = 'cell-cnt';
      else if (val === 'NC') td.className = 'cell-nc';
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  table.querySelectorAll('th, td').forEach(cell => {
    cell.addEventListener('mouseenter', () => addMatrixHover(cell));
    cell.addEventListener('mouseleave', () => clearMatrixHover());
  });
  }

// Navigate from a compatibility-matrix click into the catalogue. An ipName
// that is a real IP Id lands on that IP in the IP view (Decision 5); an
// entry that was a task label with no single IP lands on the Project view
// filtered by its project, with the old label kept as a search term.
function switchToCatalogue(ipName, projectName) {
  history.pushState({ tab: 'catalogue', search: ipName }, '', '#catalogue');

  const isIpId = !!(catalog && catalog.ips && catalog.ips[ipName]);

  // Sync the view selector with where we land.
  const targetView = isIpId ? 'ip' : 'project';
  if (targetView !== view) {
    view = targetView;
    setViewButtons();
    rebuildActiveDataset();
    buildFilterBar();
  }

  if (isIpId) {
    setSearchText('', { apply: false });
    setFilterState({ Id: [ipName] }, { replace: true });
  } else {
    // Project view filtered by project, searching for the old label.
    setSearchText(ipName, { apply: false });
    const project = projectName || 'TRISTAN';
    setFilterState({ Project: [project] }, { replace: true });
  }

  applyFilters();
  applyProjectLayout();
  // A matrix click landing on the Projects canvas should land ON the task and
  // not merely beside it.
  if (!isIpId && view === 'project' && projectLayout === 'canvas') revealUniqueSearchHit();
  switchTab('catalogue');
}

// Reveal the task an incoming needle isolates (compatibility-matrix deep
// links). With zero or several hits there is nothing sensible to single out —
// the dimmed canvas already shows where the needle lands.
function revealUniqueSearchHit() {
  if (!searchText) return;
  const hits = computeSearchHits(searchText);
  if (hits.tasks.size !== 1) return;
  const [row] = hits.tasks;
  if (typeof window.UapCanvas?.revealTask === 'function') window.UapCanvas.revealTask(row);
}

function switchTab(tab) {
  const tabBtns = document.querySelectorAll('.tab-btn[data-tab]');
  const catalogueView = document.getElementById('catalogue-view');
  const compatibilityView = document.getElementById('compatibility-view');
  const isolaView = document.getElementById('isola-view');

  tabBtns.forEach(b => b.classList.remove('active'));
  tabBtns.forEach(b => {
    if (b.dataset.tab === tab) b.classList.add('active');
  });

  catalogueView.hidden = tab !== 'catalogue';
  compatibilityView.hidden = tab !== 'compatibility';
  if (isolaView) isolaView.hidden = tab !== 'isola';
  if (tab === 'isola') activateIsolaFrame();

  // The canvas stage measured nothing while the matrix or the ISOLA preview was
  // on screen, so hand it back when the catalogue returns: it re-measures,
  // restores its scroll offset and repaints edges.
  if (typeof window.UapCanvas?.setActive === 'function') {
    window.UapCanvas.setActive(tab === 'catalogue' && view === 'project' && projectLayout === 'canvas');
  }
}

// The ISOLA preview iframe holds its URL in data-src until the tab is first
// opened, so a plain catalogue page view never contacts the assistant.
function activateIsolaFrame() {
  const frame = document.getElementById('isola-frame');
  if (frame && !frame.getAttribute('src') && frame.dataset.src) {
    frame.src = frame.dataset.src;
  }
}

function setupTabNavigation() {
  // Only the real tab controls ([data-tab]) — the theme switch also borrows the
  // .tab-btn pill styling and must not push a (undefined) hash of its own.
  const tabBtns = document.querySelectorAll('.tab-btn[data-tab]');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      history.pushState({ tab }, '', '#' + tab);
      switchTab(tab);
    });
  });

  // Handle browser Back/Forward buttons
  window.addEventListener('popstate', (event) => {
    if (event.state && event.state.tab) {
      switchTab(event.state.tab);
      // Restore search if going back to catalogue with a search term
      if (event.state.search) {
        if (dataLoaded) {
          setSearchText(event.state.search);
          if (view === 'project' && projectLayout === 'canvas') revealUniqueSearchHit();
        } else {
          // Defer filtering until data finishes loading
          pendingSearch = event.state.search;
        }
      }
    } else {
      // No state (e.g., direct navigation) — default to catalogue
      switchTab('catalogue');
    }
  });

  // Hash-based tab initialization on page load
  const hash = window.location.hash.replace('#', '');
  if (hash === 'compatibility') {
    switchTab('compatibility');
  } else if (hash === 'catalogue') {
    switchTab('catalogue');
  } else if (hash === 'isola') {
    switchTab('isola');
  }
  }
