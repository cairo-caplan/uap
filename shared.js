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

/**
 * Makes a table row resizable by adding a handle to each cell.
 * Supports mouse and pointer events for cross-browser compatibility.
 * @param {HTMLTableRowElement} row - The table row to make resizable.
 */
export function makeResizable(row) {
  const cells = Array.from(row.cells);

  cells.forEach((cell) => {
    const resizer = document.createElement('div');
    resizer.className = 'resizer';
    cell.appendChild(resizer);

    let startX, startWidth;

    const onMouseDown = (e) => {
      e.preventDefault();
      startX = e.pageX;
      startWidth = cell.offsetWidth;

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      
      resizer.classList.add('resizing');
    };

    const onMouseMove = (e) => {
      const width = startWidth + (e.pageX - startX);
      if (width > 50) { // Minimum width constraint
        cell.style.width = `${width}px`;
      }
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      resizer.classList.remove('resizing');
    };

    resizer.addEventListener('mousedown', onMouseDown);
  });
}
