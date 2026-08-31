/**
 * Catalog validator — the danger rules.
 *
 * These rules are the security gate: a finding REFUSES an entry rather than
 * labelling it, so their behaviour is worth pinning. The file had no tests at
 * all until the inbox_webhook rule arrived; these are the first, and they cover
 * the pre-existing rules too so the gate as a whole is now guarded.
 *
 * Run: npm test   (node's built-in runner — no dependency added)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readFileSync, mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INBOX_WEBHOOK_WHERE,
  dangerFindings,
  resolveRiglaneEntry,
  validateEntryShape,
} from './validate-entries.mjs';

const lockWith = (...flags) => ({ capabilities: { flags } });

describe('dangerFindings — inbox_webhook egress', () => {
  it('refuses an entry whose lock carries the webhook network flag', () => {
    const found = dangerFindings(
      lockWith({
        flag: 'network',
        where: INBOX_WEBHOOK_WHERE,
        match: 'https://collector.example/hook',
      }),
    );
    assert.equal(found.length, 1);
    assert.match(found[0], /inbox_webhook egress/);
    assert.match(found[0], /https:\/\/collector\.example\/hook/);
    assert.match(found[0], /per-run override/); // the message must name the alternative
  });

  it('leaves ordinary network capability alone — an API call is legitimate', () => {
    assert.deepEqual(
      dangerFindings(lockWith({ flag: 'network', where: 'tools[fetch_data].command', match: 'curl' })),
      [],
    );
    assert.deepEqual(
      dangerFindings(lockWith({ flag: 'network', where: 'file scripts/pull.py', match: 'requests.' })),
      [],
    );
  });

  it('pins the cross-repository `where` contract', () => {
    // riglane's src/catalog/inventory.ts exports INBOX_WEBHOOK_WHERE with this
    // value and pins the literal in pack.test.ts. The two repositories cannot
    // share the constant, so both sides assert it and either failure points at
    // the other.
    assert.equal(INBOX_WEBHOOK_WHERE, 'workflow.inbox_webhook');
  });
});

describe('dangerFindings — the pre-existing rules still hold', () => {
  it('refuses shell indirection outright', () => {
    const found = dangerFindings(lockWith({ flag: 'shell-indirection', where: 'tools[x].command', match: 'eval' }));
    assert.equal(found.length, 1);
    assert.match(found[0], /shell-indirection/);
  });

  it('refuses writes to the listed sensitive targets only', () => {
    assert.equal(
      dangerFindings(lockWith({ flag: 'writes-outside-project', where: 'file scripts/s.sh', match: '~/.ssh' })).length,
      1,
    );
    assert.deepEqual(
      dangerFindings(lockWith({ flag: 'writes-outside-project', where: 'file scripts/s.sh', match: '/tmp/x' })),
      [],
    );
  });

  it('reports every finding when a lock trips several rules', () => {
    const found = dangerFindings(
      lockWith(
        { flag: 'shell-indirection', where: 'tools[a].command', match: 'eval' },
        { flag: 'network', where: INBOX_WEBHOOK_WHERE, match: 'https://collector.example/hook' },
      ),
    );
    assert.equal(found.length, 2);
  });

  it('tolerates a lock with no capabilities block', () => {
    assert.deepEqual(dangerFindings({}), []);
    assert.deepEqual(dangerFindings({ capabilities: {} }), []);
  });
});

describe('validateEntryShape — source.path is a boundary, not a hint', () => {
  const entry = (path) => ({
    id: 'demo',
    summary: 'A demo entry.',
    license: 'MIT',
    source: {
      repo: 'https://github.com/someone/repo',
      sha: '0'.repeat(40),
      path,
    },
  });
  const errorsFor = (path) => validateEntryShape('demo', entry(path));

  it('accepts a plain nested directory', () => {
    assert.deepEqual(errorsFor('workflows/demo-thing'), []);
  });

  it('accepts an empty path (the workflow sits at the repository root)', () => {
    assert.deepEqual(errorsFor(''), []);
  });

  it('still refuses upward traversal', () => {
    assert.match(errorsFor('a/../../etc').join(' '), /traverse upward/);
  });

  // The resolved path becomes an argument to the engine CLI. On the Windows
  // .cmd-shim branch that argument reaches a shell, where `&` starts a second
  // command — so a metacharacter in a segment is refused at the boundary.
  const NEWLINE = String.fromCharCode(10);
  for (const hostile of ['wf & calc.exe &', 'wf;calc', 'wf|calc', 'wf$(calc)', 'wf`calc`', 'wf' + NEWLINE + 'calc']) {
    it(`refuses a shell metacharacter: ${JSON.stringify(hostile)}`, () => {
      assert.match(errorsFor(hostile).join(' '), /only letters, digits, dot, underscore and hyphen/);
    });
  }

  it('refuses an empty segment', () => {
    assert.match(errorsFor('a//b').join(' '), /only letters, digits/);
  });
});

describe('resolveRiglaneEntry — one spawn shape on every platform', () => {
  const scratch = () => mkdtempSync(join(tmpdir(), 'rgl-resolve-'));

  it('honours an explicit RIGLANE_CLI override', () => {
    const dir = scratch();
    const entry = join(dir, 'cli.js');
    writeFileSync(entry, '', 'utf-8');
    assert.equal(resolveRiglaneEntry(dir, { RIGLANE_CLI: entry }), entry);
  });

  it('refuses an override that does not exist rather than falling back', () => {
    const dir = scratch();
    assert.throws(
      () => resolveRiglaneEntry(dir, { RIGLANE_CLI: join(dir, 'nope.js') }),
      /RIGLANE_CLI is set to .* does not exist/,
    );
  });

  it('walks up to a node_modules install (the path CI takes)', () => {
    const root = scratch();
    const nested = join(root, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    const cli = join(root, 'node_modules', 'riglane', 'dist', 'cli', 'index.js');
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(cli, '', 'utf-8');
    assert.equal(resolveRiglaneEntry(nested, {}), cli);
  });

  // A global `riglane` on PATH is deliberately NOT a fallback: on Windows it is
  // a .cmd shim spawnable only through a shell, and author-controlled data ends
  // up on that command line. Refusing loudly is the sanctioned terminal state.
  it('fails loudly, and actionably, when nothing is resolvable', () => {
    const dir = scratch();
    assert.throws(() => resolveRiglaneEntry(dir, {}), (err) => {
      assert.match(err.message, /cannot resolve the riglane CLI/);
      assert.match(err.message, /npm ci/);
      assert.match(err.message, /RIGLANE_CLI=/);
      assert.match(err.message, /never hands/);
      return true;
    });
  });
});

describe('the validator never spawns through a shell', () => {
  // An invariant on the source, not on one code path: `shell: true` is what
  // makes Node concatenate arguments instead of escaping them, and one of those
  // arguments derives from author-controlled entry.source.path.
  it('passes no shell option to any spawn', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'validate-entries.mjs'),
      'utf-8',
    );
    const offenders = src
      .split(String.fromCharCode(10))
      .map((line, i) => [i + 1, line.trim()])
      .filter(([, line]) => !line.startsWith('*') && !line.startsWith('//'))
      .filter(([, line]) => /\bshell\s*:/.test(line));
    assert.deepEqual(offenders, [], 'shell option found: ' + JSON.stringify(offenders));
  });
});
