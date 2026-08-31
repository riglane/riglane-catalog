/**
 * Static site build — the machine surface `riglane search`, `riglane add <id>`
 * and the TUI's Community tab consume.
 *
 * From every catalog/<id>/ entry it emits, under the output directory:
 *
 *   catalog/v1/index.json     the listing: id, summary, author, level,
 *                             script_tools / deciders counts, categories, tags
 *                             (CatalogIndexRow — risk visible in the row)
 *   catalog/v1/<id>.json      the per-entry document: the entry (id, source,
 *                             free meta) + the lock text VERBATIM
 *   revoked.json              copied through — the emergency brake ships even
 *                             when (especially when) it is empty
 *
 * The level and the counts are derived from entry.lock.yaml with the SAME rule
 * validate-entries.mjs uses (verified = zero shell surface, established
 * mechanically). This script trusts the checkout — run the validator first; CI
 * runs both, in that order.
 *
 * Usage: node scripts/build-index.mjs [--out <dir>]     (default: site/)
 * Exit codes: 0 built · 1 a broken entry (fix or remove it) · 2 usage.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_DIR = join(ROOT, 'catalog');

const out = (s = '') => process.stdout.write(`${s}\n`);
const err = (s = '') => process.stderr.write(`${s}\n`);

/** Same rule as validate-entries.mjs — the two must never disagree. */
function deriveLevel(lock) {
  const hasBundledExec = (lock.bundled_files ?? []).some((b) => b.role === 'script' || b.role === 'mcp-server');
  const zeroShell =
    (lock.script_tools ?? []).length === 0 && (lock.deciders ?? []).length === 0 && !hasBundledExec;
  return zeroShell ? 'verified' : 'community';
}

/** One catalog/<id>/ directory → { row, doc } or a thrown Error. */
export function buildEntry(id, entryDir) {
  const entryPath = join(entryDir, 'entry.yaml');
  const lockPath = join(entryDir, 'entry.lock.yaml');
  if (!existsSync(entryPath)) throw new Error('no entry.yaml');
  if (!existsSync(lockPath)) throw new Error('no entry.lock.yaml');

  const entry = parseYaml(readFileSync(entryPath, 'utf-8'));
  if (entry?.id !== id) throw new Error(`entry.id '${entry?.id}' != directory '${id}'`);
  const lockText = readFileSync(lockPath, 'utf-8');
  const lock = parseYaml(lockText);

  const row = {
    id,
    summary: String(entry.summary ?? '').trim(),
    ...(typeof entry.author === 'string' ? { author: entry.author } : {}),
    level: deriveLevel(lock),
    script_tools: (lock.script_tools ?? []).length,
    deciders: (lock.deciders ?? []).length,
    ...(Array.isArray(entry.categories) ? { categories: entry.categories.map(String) } : {}),
    ...(Array.isArray(entry.tags) ? { tags: entry.tags.map(String) } : {}),
  };

  // The per-entry document mirrors what `riglane add <id>` validates:
  // { catalog_entry_version: 1, entry: {...}, lock: "<verbatim>" }.
  const { id: _id, source, ...meta } = entry;
  const doc = {
    catalog_entry_version: 1,
    entry: { id, source, ...meta },
    lock: lockText,
  };
  return { row, doc };
}

function main(argv) {
  let outDir = join(ROOT, 'site');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      const v = argv[++i];
      if (v === undefined) {
        err('build-index: --out requires a directory');
        return 2;
      }
      outDir = resolve(v);
    } else {
      err(`build-index: unknown option '${argv[i]}'`);
      return 2;
    }
  }

  const ids = existsSync(CATALOG_DIR)
    ? readdirSync(CATALOG_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    : [];

  const v1 = join(outDir, 'catalog', 'v1');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(v1, { recursive: true });

  const rows = [];
  let failed = 0;
  for (const id of ids) {
    try {
      const { row, doc } = buildEntry(id, join(CATALOG_DIR, id));
      rows.push(row);
      writeFileSync(join(v1, `${id}.json`), `${JSON.stringify(doc, null, 2)}\n`, 'utf-8');
      out(`  ${id}  [${row.level}]  tools:${row.script_tools} deciders:${row.deciders}`);
    } catch (e) {
      failed++;
      err(`  ✗ ${id}: ${e.message}`);
    }
  }

  writeFileSync(
    join(v1, 'index.json'),
    `${JSON.stringify({ catalog_index_version: 1, entries: rows }, null, 2)}\n`,
    'utf-8',
  );
  const revoked = join(ROOT, 'revoked.json');
  if (existsSync(revoked)) cpSync(revoked, join(outDir, 'revoked.json'));

  out('');
  out(`build-index: ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} → ${outDir}${failed > 0 ? ` (${failed} FAILED)` : ''}`);
  out('Serve the output directory as the catalog base URL (riglane config: catalog.base_url).');
  return failed > 0 ? 1 : 0;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));
