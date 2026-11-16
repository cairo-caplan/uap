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

// Checker for the CSV / ZIP export helpers of the Projects view preview.
// scripts/prototype-mindmap.js keeps its pure export helpers (csvCell,
// crc32, zipStore, ...) between the '==[export:begin]==' /
// '==[export:end]==' markers; this script slices them out (the page script
// needs a DOM, the helpers do not), runs known-answer and structural checks
// and, when Python is available, validates the produced archive end-to-end
// with the stdlib zipfile module. Run via the 'js: export helper test' task.

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const src = readFileSync(new URL('./prototype-mindmap.js', import.meta.url), 'utf8');
const start = src.indexOf('// ==[export:begin]==');
const end = src.indexOf('// ==[export:end]==');
if (start < 0 || end < 0) throw new Error('export markers not found in prototype-mindmap.js');
const { csvCell, zipStore, crc32 } = new Function(
  `${src.slice(start, end)}; return { csvCell, zipStore, crc32 };`
)();

// CRC-32 known answer: crc32("123456789") === 0xCBF43926.
const crc = crc32(new TextEncoder().encode('123456789'));
if (crc !== 0xcbf43926) throw new Error(`crc32 mismatch: ${crc.toString(16)}`);

// CSV escaping (RFC 4180) and the spreadsheet formula-injection guard.
const checks = [
  [csvCell('plain'), 'plain'],
  [csvCell('a,b'), '"a,b"'],
  [csvCell('say "hi"'), '"say ""hi"""'],
  [csvCell('line1\nline2'), '"line1\nline2"'],
  [csvCell('=SUM(A1)'), "'=SUM(A1)"],
  [csvCell('@evil'), "'@evil"],
  [csvCell('+x'), "'+x"],
  [csvCell('-x'), "'-x"],
  [csvCell(null), ''],
  [csvCell(42), '42']
];
checks.forEach(([got, want], i) => {
  if (got !== want) throw new Error(`csvCell check ${i}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
});

// A two-file archive with BOM/CRLF/UTF-8 content, checked structurally…
const files = [
  { name: 'uap-projects.csv', data: '\ufeffProject,Tasks\r\nCVA6,103\r\n"Quoted, name",2\r\n' },
  { name: 'uap-tasks.csv', data: '\ufeffTitle\r\n=not-a-formula\r\ncafé ✓\r\n' }
];
const bytes = zipStore(files, new Date(2026, 10, 12, 13, 14, 15));
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
if (view.getUint32(0, true) !== 0x04034b50) throw new Error('bad local header signature');
if (view.getUint16(10, true) !== ((13 << 11) | (14 << 5) | 7)) throw new Error('bad DOS time');
let eocd = -1;
for (let i = bytes.length - 22; i >= 0; i--) {
  if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
}
if (eocd !== bytes.length - 22) throw new Error('EOCD not at end of file');
if (view.getUint16(eocd + 10, true) !== files.length) throw new Error('EOCD entry count wrong');

// …and end-to-end with the Python stdlib (skipped, not failed, without
// Python). The expected contents travel as temp files, never through argv:
// a BOM or non-ASCII literal on the python command line breaks argv decoding.
const zipPath = join(tmpdir(), 'uap-export-check.zip');
const expectedPaths = files.map((file, i) => {
  const path = join(tmpdir(), `uap-export-check-${i}.csv`);
  writeFileSync(path, Buffer.from(file.data, 'utf8'));
  return path;
});
try {
  writeFileSync(zipPath, bytes);
  const out = execFileSync('python3', ['-c', `
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None, 'CRC check failed'
assert z.namelist() == ['uap-projects.csv', 'uap-tasks.csv'], z.namelist()
for entry, expected in zip(z.namelist(), sys.argv[2:]):
    with open(expected, 'rb') as handle:
        assert z.read(entry) == handle.read(), entry
print('python zipfile round-trip OK')
`, zipPath, ...expectedPaths], { encoding: 'utf8' });
  process.stdout.write(out);
} catch (err) {
  if (err.code === 'ENOENT') console.warn('python3 not found — skipped the zipfile round-trip check');
  else throw err;
} finally {
  rmSync(zipPath, { force: true });
  for (const path of expectedPaths) rmSync(path, { force: true });
}

console.log('EXPORT_HELPER_CHECK_OK');
