// build-index — the derived listing must match what the CLI validates.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildEntry } from './build-index.mjs';

const LOCK_NO_SHELL = ['lock_version: 1', 'workflow: tiny', 'script_tools: []', 'deciders: []', 'bundled_files: []', ''].join('\n');

function makeEntry(dir, id, lockText) {
  const d = join(dir, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, 'entry.yaml'),
    [
      `id: ${id}`,
      'summary: One line.',
      'author: someone',
      'license: MIT',
      'tags: [a, b]',
      'source:',
      '  repo: https://example.com/x.git',
      '  path: tiny',
      `  sha: ${'a'.repeat(40)}`,
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(join(d, 'entry.lock.yaml'), lockText, 'utf-8');
  return d;
}

test('buildEntry derives the row and wraps the doc the CLI validates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bidx-'));
  try {
    const d = makeEntry(dir, 'tiny', LOCK_NO_SHELL);
    const { row, doc } = buildEntry('tiny', d);
    assert.equal(row.level, 'verified');
    assert.equal(row.script_tools, 0);
    assert.deepEqual(row.tags, ['a', 'b']);
    assert.equal(doc.catalog_entry_version, 1);
    assert.equal(doc.entry.id, 'tiny');
    assert.equal(doc.entry.source.sha, 'a'.repeat(40));
    assert.equal(doc.lock, LOCK_NO_SHELL, 'the lock rides VERBATIM');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildEntry: any shell surface makes the level community', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bidx-'));
  try {
    const lock = LOCK_NO_SHELL.replace('script_tools: []', 'script_tools:\n  - name: x\n    command: node x.mjs');
    const d = makeEntry(dir, 'tiny', lock);
    const { row } = buildEntry('tiny', d);
    assert.equal(row.level, 'community');
    assert.equal(row.script_tools, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildEntry refuses an id/directory mismatch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bidx-'));
  try {
    const d = makeEntry(dir, 'tiny', LOCK_NO_SHELL);
    assert.throws(() => buildEntry('other', d), /!= directory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
