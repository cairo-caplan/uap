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
document.addEventListener('DOMContentLoaded', () => {
  document.body.classList.add('editor-page');

  const CATEGORIES_URL = 'cfg/categories.json';
  const LICENSES_URL = 'cfg/licenses.json';
  const PARTNERS_URL = 'cfg/partners.json';
  const PROJECTS_URL = 'cfg/projects.json';
  const CATALOG_URL = 'cfg/catalog.json';
  const SCHEMA_IP_URL = 'cfg/schema-ip.json';
  const SCHEMA_PROJECT_URL = 'cfg/schema-project.json';

  const fileSelector = document.getElementById('file-selector');
  const loadBtn = document.getElementById('load-file-btn');
  const createNewBtn = document.getElementById('create-new-btn');
  const loadLocalBtn = document.getElementById('load-local-btn');
  const localFileInput = document.getElementById('local-file-input');
  const saveBtn = document.getElementById('save-json-btn');
  const projectSelect = document.getElementById('project-select');
  const kindRadios = document.querySelectorAll('input[name="doc-kind"]');
  const projectRow = document.getElementById('project-row');
  const idHint = document.getElementById('id-hint');
  const table = document.getElementById('data-table');
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');

  // Document kind: "ip" (single object under ips/) or "project" (Tasks table).
  let kind = 'ip';
  // Project document root, kept separate from the Tasks rows.
  let projectDoc = { Id: '', Name: '' };
  // IP document (single record) and Task rows share the table rendering:
  // currentData is [ipDoc] in IP mode and doc.Tasks in project mode.
  let currentData = [];
  let allowedCategories = [];
  let allowedLicenses = [];
  let allLicensesData = []; // Full license objects with both name and licenseId
  let partnersData = [];    // cfg/partners.json entries (id/name/aliases)
  let projectsRegistry = [];// cfg/projects.json entries (id/name/logo/url)
  let catalog = null;       // cfg/catalog.json, for IP id validation + selectors
  let schemaIp = null;      // cfg/schema-ip.json properties drive the IP columns
  let schemaTask = null;    // cfg/schema-project.json Tasks items drive the columns
  // IP ids created in this editing session, valid even before the catalogue
  // is regenerated.
  const sessionIpIds = new Set();

  const columnLabels = { "IP_CARD_URL": "IP Card", "IP_CARD_PDF_URL": "IP Card PDF" };
  // Preferred leading order per document kind; trailing fields come from the
  // schema property list so a schema addition is never silently dropped.
  const IP_FIELD_ORDER = ["Id", "Name", "Owners", "Category", "URL", "DefaultBranch", "License", "Status", "Description", "IP_CARD_URL", "IP_CARD_PDF_URL", "Comment"];
  const TASK_FIELD_ORDER = ["TaskId", "WI", "Title", "IPs", "Partners", "ForkURL", "Branch", "Status", "Description", "Comment"];
  // Fields whose value is a list of organisation / IP / category references.
  const ORG_FIELDS = ['Owners', 'Partners'];
  const IP_FIELDS = ['IPs'];
  const CATEGORY_FIELDS = ['Category'];
  const LICENSE_FIELDS = ['License'];
  const WI_FIELDS = ['WI'];

  // --- INITIALIZATION ---

  async function initialize() {
    await Promise.all([
      loadCategories(),
      loadLicenses(),
      loadPartners(),
      loadProjects(),
      loadCatalog(),
      loadSchemas()
    ]);
    populateFileSelector();
    populateProjectSelect();
    applyKindToUI();
  }

  async function loadCategories() {
    try {
      const response = await fetch(CATEGORIES_URL);
      allowedCategories = await response.json();
    } catch (error) {
      console.error('Failed to load categories:', error);
      alert('Error: Could not load categories configuration.');
    }
  }

  async function loadLicenses() {
    try {
      const response = await fetch(LICENSES_URL);
      allLicensesData = await response.json();
      // Extract licenseId values from the licenses array
      allowedLicenses = allLicensesData.map(license => license.licenseId);
    } catch (error) {
      console.error('Failed to load licenses:', error);
      alert('Error: Could not load licenses configuration.');
    }
  }

  async function loadPartners() {
    try {
      const response = await fetch(PARTNERS_URL);
      partnersData = await response.json();
    } catch (error) {
      console.error('Failed to load partners:', error);
      alert('Error: Could not load partners configuration.');
    }
  }

  async function loadProjects() {
    try {
      const response = await fetch(PROJECTS_URL);
      projectsRegistry = await response.json();
    } catch (error) {
      console.error('Failed to load projects:', error);
      alert('Error: Could not load projects configuration.');
    }
  }

  // The catalogue aggregate is the file list source for the editor: per-file
  // directory listings do not exist on static hosts like GitHub Pages, but
  // every committed ips/<id>.json / projects/<id>.json IS served. So the
  // selector lists ids from cfg/catalog.json and loads the individual file.
  async function loadCatalog() {
    try {
      const response = await fetch(CATALOG_URL);
      catalog = await response.json();
    } catch (error) {
      console.error('Failed to load catalogue:', error);
      alert('Error: Could not load the catalogue (cfg/catalog.json).');
    }
  }

  async function loadSchemas() {
    try {
      const [ipSchema, projSchema] = await Promise.all([
        fetch(SCHEMA_IP_URL).then(r => r.json()),
        fetch(SCHEMA_PROJECT_URL).then(r => r.json())
      ]);
      schemaIp = ipSchema;
      schemaTask = projSchema.properties.Tasks.items;
    } catch (error) {
      console.error('Failed to load schemas:', error);
      alert('Error: Could not load schemas (cfg/schema-ip.json / cfg/schema-project.json).');
    }
  }

  // Field whitelist for the active kind, derived from the schema properties so
  // new schema fields show up automatically (ordered by the preferred order).
  function fieldsForKind(k) {
    const schemaProps = k === 'ip'
      ? (schemaIp && schemaIp.properties) || {}
      : (schemaTask && schemaTask.properties) || {};
    const preferred = k === 'ip' ? IP_FIELD_ORDER : TASK_FIELD_ORDER;
    const ordered = preferred.filter(f => f in schemaProps);
    // Schema fields not in the preferred order are appended, never dropped.
    Object.keys(schemaProps).forEach(f => {
      if (!ordered.includes(f)) ordered.push(f);
    });
    return ordered;
  }

  // --- SELECTORS ---

  function populateFileSelector() {
    fileSelector.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select file from repository';
    fileSelector.appendChild(placeholder);

    if (!catalog) return;

    const ipGroup = document.createElement('optgroup');
    ipGroup.label = 'IP files (ips/)';
    Object.keys(catalog.ips || {}).sort().forEach(id => {
      const option = document.createElement('option');
      option.value = `ips/${id}.json`;
      option.textContent = `${id}.json — ${catalog.ips[id].Name || ''}`;
      option.dataset.kind = 'ip';
      ipGroup.appendChild(option);
    });
    fileSelector.appendChild(ipGroup);

    const projGroup = document.createElement('optgroup');
    projGroup.label = 'Project files (projects/)';
    Object.keys(catalog.projects || {}).sort().forEach(id => {
      const option = document.createElement('option');
      option.value = `projects/${id}.json`;
      option.textContent = `${id}.json — ${catalog.projects[id].Name || ''}`;
      option.dataset.kind = 'project';
      projGroup.appendChild(option);
    });
    fileSelector.appendChild(projGroup);
  }

  // Project selector sets the document root Id/Name (replacing the old
  // free-text Project Name input).
  function populateProjectSelect() {
    projectSelect.innerHTML = '';
    projectsRegistry.forEach(p => {
      const option = document.createElement('option');
      option.value = p.id;
      option.textContent = p.name;
      projectSelect.appendChild(option);
    });
  }

  function applyKindToUI() {
    kind = document.querySelector('input[name="doc-kind"]:checked').value;
    projectRow.style.display = kind === 'project' ? '' : 'none';
    idHint.textContent = kind === 'ip'
      ? 'IP file — saves as ips/<Id>.json (Id is the file name).'
      : 'Project file — saves as projects/<Id>.json; pick the project.';
    }

  // --- DATA HANDLING ---

  // Detect a document's kind from its shape.
  function detectKind(doc) {
    if (doc && Array.isArray(doc.Tasks)) return 'project';
    if (doc && doc.Id !== undefined && doc.Tasks === undefined && !doc.ips) return 'ip';
    return null;
  }

  function setKindRadio(k) {
    const radio = document.querySelector(`input[name="doc-kind"][value="${k}"]`);
    if (radio) radio.checked = true;
    kind = k;
    applyKindToUI();
  }

  async function loadFileData(url) {
    try {
      const response = await fetch(url);
      const doc = await response.json();
      const k = detectKind(doc);
      if (!k) {
        alert('This file is neither an IP document (single object) nor a project document (with Tasks).');
        return;
      }
      setKindRadio(k);
      if (k === 'ip') {
        currentData = [doc];
      } else {
        projectDoc = { Id: doc.Id || '', Name: doc.Name || '' };
        currentData = doc.Tasks || [];
        if (!currentData.length) currentData = [{}];
        // Select the project in the registry, or add it if not registered.
        if (!projectsRegistry.some(p => p.id === projectDoc.Id)) {
          const option = document.createElement('option');
          option.value = projectDoc.Id;
          option.textContent = projectDoc.Name || projectDoc.Id;
          projectSelect.appendChild(option);
        }
        projectSelect.value = projectDoc.Id;
      }
      renderTable();
      saveBtn.disabled = false;
    } catch (error) {
      console.error('Failed to load or parse JSON file:', error);
      alert('Error loading file. Please check the console for details.');
    }
  }

  function createNewFile() {
    if (kind === 'ip') {
      currentData = [{ Id: '', Name: '', Owners: [], Category: [] }];
    } else {
      const id = projectSelect.value || (projectsRegistry[0] && projectsRegistry[0].id) || '';
      const entry = projectsRegistry.find(p => p.id === id);
      projectDoc = { Id: id, Name: entry ? entry.name : id };
      currentData = [{}]; // Start with one empty task row
    }
    renderTable();
    saveBtn.disabled = false;
  }

  function addRow() {
    currentData.push({});
    renderTable();
  }

  function insertRowBelow(index) {
    currentData.splice(index + 1, 0, {});
    renderTable();
  }

  function deleteRow(index) {
    if (currentData.length === 1) {
      // If it's the last row, just clear its data instead of deleting it.
      currentData[index] = {};
    } else {
      // Otherwise, delete the row.
      currentData.splice(index, 1);
    }
    renderTable();
  }

  function isListField(key) {
    return ORG_FIELDS.includes(key) || IP_FIELDS.includes(key) ||
           CATEGORY_FIELDS.includes(key) || LICENSE_FIELDS.includes(key) ||
           WI_FIELDS.includes(key);
  }

  function updateData(index, key, value) {
    // For keys that should be arrays, split by comma
    if (isListField(key)) {
      currentData[index][key] = value.split(',').map(s => s.trim()).filter(Boolean);
    } else {
      currentData[index][key] = value;
    }
  }

  // --- REFERENCE RESOLUTION ---

  // Organisation resolution (Owners/Partners): name or alias, case-insensitive.
  function resolvePartner(value) {
    const v = String(value).trim().toLowerCase();
    return partnersData.find(p =>
      (p.name || '').toLowerCase() === v ||
      (p.aliases || []).some(a => a.toLowerCase() === v)
    ) || null;
  }

  function resolveCategory(value) {
    const v = String(value).trim().toLowerCase();
    return allowedCategories.find(c =>
      (c.name || '').toLowerCase() === v ||
      (c.aliases || []).some(a => a.toLowerCase() === v)
    ) || null;
  }

  function ipExists(value) {
    const v = String(value).trim();
    return !!(catalog && catalog.ips && catalog.ips[v]) || sessionIpIds.has(v);
  }

  function toList(value) {
    if (value === null || value === undefined || value === '') return [];
    return Array.isArray(value) ? value : [value];
  }

  // --- VALIDATION ---

  function validate() {
    if (kind === 'ip') {
      const row = currentData[0] || {};
      const id = (row.Id || '').trim();
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
        alert(`Error: "Id" "${id}" is not a valid slug (lowercase letters, digits, dot, dash, underscore; must start with letter or digit).`);
        return null;
      }
      if (!(row.Name || '').trim()) {
        alert('Error: The "Name" field cannot be empty.');
        return null;
      }
      const owners = toList(row.Owners);
      if (!owners.length) {
        alert('Error: An IP needs at least one Owner (use "TBD" while unassigned).');
        return null;
      }
      for (const owner of owners) {
        if (!resolvePartner(owner)) {
          alert(`Error: Owner "${owner}" is not in cfg/partners.json (name or alias).`);
          return null;
        }
      }
      const categories = toList(row.Category);
      if (!categories.length) {
        alert('Error: The "Category" field needs at least one category.');
        return null;
      }
      for (const cat of categories) {
        if (!resolveCategory(cat)) {
          alert(`Error: Category "${cat}" is not in cfg/categories.json (name or alias).`);
          return null;
        }
      }
      for (const license of toList(row.License)) {
        if (!allowedLicenses.includes(license)) {
          alert(`Error: Invalid license value "${license}". Pick a valid SPDX license id.`);
          return null;
        }
      }
      sessionIpIds.add(id);
      return { doc: cleanDoc(row, 'ip'), fileName: `ips/${id}.json` };
    }

    // Project document
    const projectId = projectSelect.value;
    const registryEntry = projectsRegistry.find(p => p.id === projectId);
    if (!projectId) {
      alert('Error: Please pick the project this file belongs to.');
      return null;
    }
    const doc = {
      Id: projectId,
      Name: registryEntry ? registryEntry.name : (projectDoc.Name || projectId),
      Tasks: []
    };
    const seenTaskIds = new Set();
    for (let i = 0; i < currentData.length; i++) {
      const row = currentData[i];
      const taskId = (row.TaskId || '').trim();
      if (!/^[a-z0-9][a-zA-Z0-9._-]*$/.test(taskId)) {
        alert(`Error: "TaskId" "${taskId}" in row ${i + 1} is not a valid identifier (must start with letter or digit; no spaces).`);
        return null;
      }
      if (seenTaskIds.has(taskId)) {
        alert(`Error: Duplicate "TaskId" "${taskId}" in row ${i + 1}. Task ids must be unique within the project.`);
        return null;
      }
      seenTaskIds.add(taskId);
      if (!toList(row.WI).length) {
        alert(`Error: The "WI" field in row ${i + 1} cannot be empty (use "TBD" while unknown).`);
        return null;
      }
      if (!(row.Title || '').trim()) {
        alert(`Error: The "Title" field in row ${i + 1} cannot be empty.`);
        return null;
      }
      const ips = toList(row.IPs);
      if (!ips.length) {
        alert(`Error: Task "${taskId}" must reference at least one IP.`);
        return null;
      }
      for (const ipRef of ips) {
        if (!ipExists(ipRef)) {
          alert(`Error: Task "${taskId}" references IP "${ipRef}" which has no ips/${ipRef}.json in the catalogue. Create the IP first.`);
          return null;
        }
      }
      const partners = toList(row.Partners);
      if (!partners.length) {
        alert(`Error: Task "${taskId}" must have at least one Partner.`);
        return null;
      }
      for (const partner of partners) {
        if (!resolvePartner(partner)) {
          alert(`Error: Partner "${partner}" of task "${taskId}" is not in cfg/partners.json (name or alias).`);
          return null;
        }
      }
      doc.Tasks.push(cleanDoc(row, 'task'));
    }
    return { doc, fileName: `projects/${projectId}.json` };
  }

  // Build the saved document: schema-ordered keys, optional empties omitted.
  function cleanDoc(row, k) {
    const out = {};
    fieldsForKind(k).forEach(key => {
      const value = isListField(key) ? toList(row[key]) : (row[key] ?? '');
      if (Array.isArray(value) ? !value.length : !String(value).trim()) return;
      out[key] = value;
    });
    return out;
  }

  function saveFile() {
    const result = validate();
    if (!result) return;
    const jsonString = JSON.stringify(result.doc, null, 2) + '\n';
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = result.fileName.split('/').pop();
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    alert(`Saved as ${result.fileName} (downloaded — place it in the repository and commit).`);
  }

  // --- RENDERING ---

  // Multi-select combobox shared by Owners/Partners/IPs/Category/License:
  // a free-text input with a filtered option list from a registry.
  function makeCombobox(rowIndex, key, value, options, optionClass) {
    const container = document.createElement('div');
    container.className = 'category-combobox-container';

    const input = document.createElement('input');
    input.type = 'text';
    input.value = Array.isArray(value) ? value.join(', ') : value;
    input.dataset.index = rowIndex;
    input.dataset.key = key;
    container.appendChild(input);

    const dropdown = document.createElement('div');
    dropdown.className = 'category-dropdown';

    options.forEach(optionText => {
      const option = document.createElement('div');
      option.textContent = optionText;
      option.className = optionClass;
      option.addEventListener('mousedown', (e) => {
        e.preventDefault(); // Prevent input from losing focus
        const currentValues = input.value.split(',').map(s => s.trim()).filter(Boolean);
        if (!currentValues.includes(optionText)) {
          currentValues.push(optionText);
          input.value = currentValues.join(', ') + ', '; // Add comma for next entry
          // Manually trigger the input event to update the data model
          input.dispatchEvent(new Event('input', { bubbles: true }));
          // Set focus and move cursor to the end of the input
          input.focus();
          const end = input.value.length;
          input.setSelectionRange(end, end);
        }
      });
      dropdown.appendChild(option);
    });

    container.appendChild(dropdown);

    input.addEventListener('focus', () => {
      dropdown.style.display = 'block';
    });

    input.addEventListener('blur', () => {
      // Delay hiding to allow click on dropdown options
      setTimeout(() => {
        dropdown.style.display = 'none';
      }, 150);
    });

    input.addEventListener('input', () => {
      const filterText = input.value.split(',').pop().trim().toLowerCase();
      dropdown.querySelectorAll(`.${optionClass}`).forEach(opt => {
        opt.style.display = opt.textContent.toLowerCase().includes(filterText) ? 'block' : 'none';
      });
    });

    return { container, input };
  }

  // Registry-backed option lists for the comboboxes.
  function comboboxOptions(key) {
    if (ORG_FIELDS.includes(key)) return partnersData.map(p => p.name);
    if (IP_FIELDS.includes(key)) {
      return [...new Set([
        ...Object.keys((catalog && catalog.ips) || {}),
        ...sessionIpIds
      ])];
    }
    if (CATEGORY_FIELDS.includes(key)) return allowedCategories.map(c => c.name);
    if (LICENSE_FIELDS.includes(key)) return allowedLicenses;
    return null; // plain text input
  }

  function renderTable() {
    // Clear existing content
    thead.innerHTML = '';
    tbody.innerHTML = '';

    const schemaColumns = fieldsForKind(kind);

    // Render Header
    const headerRow = document.createElement('tr');
    const actionsHeader = document.createElement('th');
    actionsHeader.className = 'row-actions-cell';
    headerRow.appendChild(actionsHeader);

    schemaColumns.forEach(col => {
      const th = document.createElement('th');
      th.textContent = columnLabels[col] || col;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    makeResizable(headerRow);

    // Render Body Rows
    currentData.forEach((row, rowIndex) => {
      const tr = document.createElement('tr');

      // Add cell for hover actions
      const actionTd = document.createElement('td');
      actionTd.className = 'row-actions-cell';
      actionTd.innerHTML = `<div class="row-actions-container"><button class="row-action-btn add" title="Insert row below" onclick="window.insertRowBelow(${rowIndex})">+</button><button class="row-action-btn delete" title="Delete this row" onclick="window.deleteRow(${rowIndex})">-</button></div>`;
      tr.appendChild(actionTd);

      schemaColumns.forEach(key => {
        const td = document.createElement('td');
        const value = row[key] || '';

        const options = comboboxOptions(key);
        if (options) {
          const optionClass = key === 'License' ? 'license-option' : 'category-option';
          const { container } = makeCombobox(rowIndex, key, value, options, optionClass);
          td.appendChild(container);
        } else {
          const input = document.createElement('input');
          input.type = 'text';
          input.value = Array.isArray(value) ? value.join(', ') : value;
          input.dataset.index = rowIndex;
          input.dataset.key = key;
          td.appendChild(input);
        }
        tr.appendChild(td);
      });

      tbody.appendChild(tr);
    });
  }

  // Expose functions to global scope so inline onclick handlers can find them
  window.insertRowBelow = insertRowBelow;
  window.deleteRow = deleteRow;

  // --- EVENT LISTENERS ---

  loadBtn.addEventListener('click', () => {
    const selectedUrl = fileSelector.value;
    if (selectedUrl) {
      loadFileData(selectedUrl);
    } else {
      alert('Please select a file to load.');
    }
  });

  createNewBtn.addEventListener('click', createNewFile);
  saveBtn.addEventListener('click', saveFile);
  loadLocalBtn.addEventListener('click', () => localFileInput.click());

  kindRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      setKindRadio(radio.value);
      // The table shows a different document kind now; require an explicit
      // load/create before saving.
      currentData = [];
      thead.innerHTML = '';
      tbody.innerHTML = '';
      saveBtn.disabled = true;
    });
  });

  projectSelect.addEventListener('change', () => {
    const entry = projectsRegistry.find(p => p.id === projectSelect.value);
    projectDoc = {
      Id: projectSelect.value,
      Name: entry ? entry.name : projectSelect.value
    };
  });

  localFileInput.addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const doc = JSON.parse(e.target.result);
        const k = detectKind(doc);
        if (!k) {
          alert('Uploaded file is neither an IP document (single object) nor a project document (with Tasks).');
          return;
        }
        setKindRadio(k);
        if (k === 'ip') {
          currentData = [doc];
        } else {
          projectDoc = { Id: doc.Id || '', Name: doc.Name || '' };
          currentData = doc.Tasks || [{}];
          if (!projectsRegistry.some(p => p.id === projectDoc.Id)) {
            const option = document.createElement('option');
            option.value = projectDoc.Id;
            option.textContent = projectDoc.Name || projectDoc.Id;
            projectSelect.appendChild(option);
          }
          projectSelect.value = projectDoc.Id;
        }
        renderTable();
        saveBtn.disabled = false;
      } catch (err) {
        alert(`Error parsing JSON file: ${err.message}`);
      }
    };
    reader.readAsText(file);
  });

  // Use 'input' for text fields to update data instantly on every keystroke.
  // Use 'change' for select dropdowns.
  tbody.addEventListener('input', (e) => {
    const target = e.target;
    if (target.tagName === 'INPUT') {
      const { index, key } = target.dataset;
      updateData(parseInt(index, 10), key, target.value);
    }
  });

  tbody.addEventListener('change', (e) => {
    const target = e.target;
    if (target.tagName === 'SELECT') {
      const { index, key } = target.dataset;
      updateData(parseInt(index, 10), key, target.value);
    }
  });

  // --- START ---
  initialize();
});

function makeResizable(headerRow) {
  const table = headerRow.closest('table');
  let cg = table.querySelector('colgroup');
  if (!cg) {
    cg = document.createElement('colgroup');
    table.insertBefore(cg, headerRow.parentElement);
  }
  cg.innerHTML = ''; // Clear existing colgroup

  const ths = Array.from(headerRow.children);
  ths.forEach(() => cg.appendChild(document.createElement('col')));
  const cols = Array.from(cg.children);

  ths.forEach((th, i) => {
    if (i === ths.length - 1) return; // No resizer on the last column

    const resizer = document.createElement('div');
    resizer.className = 'resizer';
    th.appendChild(resizer);

    resizer.tabIndex = 0;
    resizer.setAttribute('role', 'separator');
    resizer.setAttribute('aria-label', `Resize ${th.textContent}`);

    let startX, startWidth;
    const onPointerMove = e => {
      const x = e.pageX ?? (e.touches && e.touches[0] && e.touches[0].pageX) ?? e.clientX;
      const delta = x - startX;
      cols[i].style.width = startWidth + delta + 'px';
    };
    const onPointerUp = e => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      try { resizer.releasePointerCapture && resizer.releasePointerCapture(e.pointerId); } catch(_) {}
    };

    resizer.addEventListener('pointerdown', e => {
      e.preventDefault();
      startX = e.pageX || e.clientX;
      startWidth = th.offsetWidth;
      try { resizer.setPointerCapture && resizer.setPointerCapture(e.pointerId); } catch(_) {}
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
    });

    resizer.addEventListener('keydown', e => {
      const cur = parseInt(getComputedStyle(cols[i]).width, 10) || th.offsetWidth;
      if (e.key === 'ArrowLeft') {
        cols[i].style.width = Math.max(20, cur - 10) + 'px';
        e.preventDefault();
      } else if (e.key === 'ArrowRight') {
        cols[i].style.width = (cur + 10) + 'px';
        e.preventDefault();
      }
    });
  });
}
