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

// Optional site theme switcher ("OpenHW Foundation" style).
//
// Loaded as a plain <script> in every page <head> (after the stylesheets) so
// the stored choice is applied before the first paint — no flash of the
// default style. The stylesheet itself (theme-openhw.css) is always linked and
// every rule is scoped under html[data-theme="openhw"], so an absent attribute
// means "default style" and nothing else has to be unloaded.
//
// The visible switch is the #theme-toggle button on the Platform page; pages
// without it still honour (and keep) the choice made there.

const THEME_STORAGE_KEY = 'uap-theme';
const THEME_OPENHW = 'openhw';

function currentTheme() {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === THEME_OPENHW ? THEME_OPENHW : 'default';
  } catch {
    return 'default';        // storage blocked (private mode): default only
  }
}

function applyTheme(theme) {
  if (theme === THEME_OPENHW) {
    document.documentElement.dataset.theme = THEME_OPENHW;
  } else {
    delete document.documentElement.dataset.theme;
  }
}

function storeTheme(theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Persisting is best effort; the theme still applies for this page view.
  }
}

// Keep the switch's pressed state and tooltip in sync with the theme. The
// label stays "OpenHW style" so it always names the option aria-pressed refers
// to; while the theme is on, theme-openhw.css paints the button green.
function syncThemeToggle(theme) {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  const on = theme === THEME_OPENHW;
  btn.setAttribute('aria-pressed', String(on));
  btn.title = on
    ? 'OpenHW Foundation style is active. Click to use the default style'
    : 'Switch to the OpenHW Foundation style';
}

// Wire the Platform-page switch (other pages have none, and just inherit).
function wireThemeToggle() {
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.addEventListener('click', () => {
      const next = currentTheme() === THEME_OPENHW ? 'default' : THEME_OPENHW;
      applyTheme(next);
      storeTheme(next);
      syncThemeToggle(next);
    });
  }
  syncThemeToggle(currentTheme());
}

applyTheme(currentTheme());

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireThemeToggle);
} else {
  wireThemeToggle();
}
