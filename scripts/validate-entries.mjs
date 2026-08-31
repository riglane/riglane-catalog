/**
 * Catalog entry validation — exactly what CI runs on every pull request.
 *
 * For each catalog/<id>/ entry:
 *   1. Both files present; entry.yaml shape (id pattern, id == dirname,
 *      FULL 40-char sha, summary <= 140, license present, source.repo,
 *      and source.path restricted to plain path segments).
 *   2. Fetch the author's repository AT THE PINNED SHA (git, array args, no
 *      shell; core.autocrlf=false so committed bytes are materialized
 *      verbatim — a smudged checkout would shift every hash).
 *   3. Regenerate the lock from the fetched tree with `riglane catalog pack`
 *      and BYTE-COMPARE it against the submitted entry.lock.yaml. The
 *      description can lie; the lock cannot.
 *   4. Run the engine's own validator (`riglane validate-workflow`).
 *   5. DANGER LINTER over the regenerated lock's capability flags:
 *      shell-indirection (pipe-to-shell, eval, base64 …) and writes into
 *      ~/.ssh / shell profiles are rejected outright, not merely labelled.
 *   6. Derive the level: verified = zero shell surface (no script tools, no
 *      deciders, no bundled script/mcp-server files). Printed, consumed by
 *      the site build.
 *
 * READS ONLY — nothing fetched is ever executed. `riglane catalog pack` and
 * `riglane validate-workflow` are static analysis by construction.
 *
 * Usage: node scripts/validate-entries.mjs [id ...]   (default: all entries)
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_DIR = join(ROOT, 'catalog');

const ID_RE = /^[a-z][a-z0-9_-]*$/;
/**
 * One segment of `source.path` — the workflow directory inside the author's
 * repository. Deliberately narrow: the resolved path becomes an ARGUMENT to the
 * engine CLI, so a segment carrying a shell metacharacter would ride into a
 * command line on any code path that spawns through a shell. A workflow
 * directory has no legitimate need for one, so the boundary refuses it instead
 * of relying on every downstream spawn to escape it.
 */
const PATH_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const SUMMARY_MAX = 140;

/** Capability flags that fail the entry outright (not just label it). */
const REJECTED_FLAGS = new Set(['shell-indirection']);
const REJECTED_WRITE_MATCHES = new Set(['~/.ssh', '.bashrc', '.zshrc', '$PROFILE']);

/**
 * The `where` the engine's capability scan stamps on a top-level
 * `inbox_webhook` (INBOX_WEBHOOK_WHERE in riglane's src/catalog/inventory.ts).
 *
 * This is a cross-repository contract. The engine cannot be imported for a
 * constant here and this repository cannot be imported there, so the literal is
 * duplicated on purpose — and pinned by a test on the engine side, which fails
 * if the string ever changes and says that this validator must change with it.
 *
 * Keyed on `where` rather than on the `network` flag as a whole: a networked
 * workflow is perfectly legitimate (an API call in a script tool). What is not
 * legitimate in a PUBLISHED entry is the author's own address baked into the
 * shared file.
 */
export const INBOX_WEBHOOK_WHERE = 'workflow.inbox_webhook';

// ─── riglane CLI resolution: local node_modules first, then PATH ─────────────

/**
 * Resolve the engine CLI to a JavaScript ENTRY FILE, so every invocation is the
 * same one shape on every platform: `spawnSync(process.execPath, [entry, ...args])`.
 *
 * Why an entry file rather than the `riglane` command on PATH: on Windows the
 * global CLI is a `.cmd` shim, and Node refuses to spawn a `.cmd` unless the
 * caller opts into `shell: true` — at which point Node stops escaping the
 * arguments and merely concatenates them into a command line (DEP0190). One of
 * those arguments is derived from `entry.source.path`, which the submitting
 * author controls, so that path put author data on a command line. Manual
 * quoting is not a fix: `cmd.exe` expands `%VAR%` even inside double quotes,
 * and its quoting rules differ from the argv parser the program itself uses.
 *
 * So there is no shell here, on any OS, and nothing to escape. `process.execPath`
 * is an absolute path to the running interpreter — no PATH lookup, no shim, no
 * `.cmd`. Every argument reaches the CLI as a real argv element.
 *
 * The consequence is deliberate: the engine must be RESOLVABLE, not merely
 * installed. CI installs it as a dependency and hits the walk below; a
 * contributor runs `npm ci` once. A global-only install is refused with an
 * actionable message rather than quietly taking a shell path — failing loud is
 * the right terminal state when the safe route is unavailable.
 */
export function resolveRiglaneEntry(
  root = ROOT,
  env = process.env,
  platform = process.platform,
) {
  const override = env.RIGLANE_CLI;
  if (override) {
    if (existsSync(override)) return override;
    throw new Error(`RIGLANE_CLI is set to '${override}', which does not exist.`);
  }

  // Walk up: covers a plain install, a hoisted workspace, and being run from a
  // subdirectory of the repository.
  let dir = resolve(root);
  for (;;) {
    const candidate = join(dir, 'node_modules', 'riglane', 'dist', 'cli', 'index.js');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const globalHint =
    platform === 'win32'
      ? '%APPDATA%/npm/node_modules/riglane/dist/cli/index.js'
      : '$(npm root -g)/riglane/dist/cli/index.js';
  throw new Error(
    [
      'cannot resolve the riglane CLI.',
      '  Install it as a dependency of this repository:  npm ci',
      '  or point the validator at an existing install:  RIGLANE_CLI=' + globalHint,
      '',
      '  A globally installed `riglane` on PATH is deliberately not used: on Windows it is a',
      '  .cmd shim that can only be spawned through a shell, and this validator never hands',
      '  author-controlled data to a shell.',
    ].join(String.fromCharCode(10)),
  );
}

/** Resolved lazily so importing this module for its rules never needs the CLI. */
let riglaneEntry = null;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf-8', timeout: 300_000, ...opts });
  if (r.error) throw new Error(`${cmd} ${args[0] ?? ''}: ${r.error.message}`);
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
// One shape, every platform: node + a resolved entry file + a real argv array.
// No `shell` option is passed anywhere in this file, by design.
const riglane = (args, opts) => {
  riglaneEntry ??= resolveRiglaneEntry();
  return run(process.execPath, [riglaneEntry, ...args], opts);
};
const git = (args, cwd) => run('git', args, { cwd });

// ─── Per-entry validation ─────────────────────────────────────────────────────

export function validateEntryShape(id, entry) {
  const errors = [];
  if (entry === null || typeof entry !== 'object') return ['entry.yaml is not a mapping'];
  if (entry.id !== id) errors.push(`entry.id '${entry.id}' must equal the directory name '${id}'`);
  if (typeof entry.id !== 'string' || !ID_RE.test(entry.id)) errors.push(`entry.id must match ${ID_RE}`);
  if (typeof entry.summary !== 'string' || entry.summary.trim() === '') errors.push('summary is required');
  else if (entry.summary.length > SUMMARY_MAX) errors.push(`summary exceeds ${SUMMARY_MAX} characters`);
  if (typeof entry.license !== 'string' || entry.license.trim() === '') errors.push('license is required');
  const src = entry.source;
  if (src === null || typeof src !== 'object') errors.push('source (repo/path/sha) is required');
  else {
    if (typeof src.repo !== 'string' || src.repo.trim() === '') errors.push('source.repo is required');
    if (typeof src.sha !== 'string' || !SHA_RE.test(src.sha)) errors.push('source.sha must be a FULL 40-char lowercase commit SHA');
    const path = typeof src.path === 'string' ? src.path : '';
    if (path !== '') {
      const segments = path.split('/');
      if (segments.includes('..')) errors.push('source.path must not traverse upward');
      else if (!segments.every((seg) => PATH_SEGMENT_RE.test(seg))) {
        errors.push(
          'source.path segments may contain only letters, digits, dot, underscore and hyphen',
        );
      }
    }
  }
  return errors;
}

function fetchPinnedTree(source, scratch) {
  const cloneDir = mkdtempSync(join(scratch, 'fetch-'));
  let r = git(['init', '--quiet'], cloneDir);
  if (r.status !== 0) throw new Error(`git init failed: ${r.stderr.trim()}`);
  r = git(['remote', 'add', 'origin', source.repo], cloneDir);
  if (r.status !== 0) throw new Error(`git remote add failed: ${r.stderr.trim()}`);
  r = git(['fetch', '--quiet', '--depth', '1', 'origin', source.sha], cloneDir);
  if (r.status !== 0) {
    r = git(['fetch', '--quiet', 'origin'], cloneDir);
    if (r.status !== 0) throw new Error(`cannot fetch ${source.repo}: ${r.stderr.trim()}`);
  }
  r = git(['-c', 'core.autocrlf=false', '-c', 'advice.detachedHead=false', 'checkout', '--quiet', source.sha], cloneDir);
  if (r.status !== 0) throw new Error(`commit ${source.sha} not reachable in ${source.repo}: ${r.stderr.trim()}`);
  const path = (source.path ?? '').replace(/^\/+|\/+$/g, '');
  const workflowDir = path === '' ? cloneDir : join(cloneDir, path);
  if (!existsSync(join(workflowDir, 'workflow.yaml'))) {
    throw new Error(`no workflow.yaml at '${path || '.'}' in the pinned tree`);
  }
  return { cloneDir, workflowDir };
}

function deriveLevel(lock) {
  const hasBundledExec = (lock.bundled_files ?? []).some((b) => b.role === 'script' || b.role === 'mcp-server');
  const zeroShell =
    (lock.script_tools ?? []).length === 0 && (lock.deciders ?? []).length === 0 && !hasBundledExec;
  return zeroShell ? 'verified' : 'community';
}

export function dangerFindings(lock) {
  const findings = [];
  for (const f of lock.capabilities?.flags ?? []) {
    if (REJECTED_FLAGS.has(f.flag)) {
      findings.push(`${f.flag}: '${f.match}' in ${f.where}`);
    }
    if (f.flag === 'writes-outside-project' && REJECTED_WRITE_MATCHES.has(f.match)) {
      findings.push(`writes-outside-project: '${f.match}' in ${f.where}`);
    }
    // Author-controlled egress baked into a shared file. The engine POSTs every
    // inbox message — the question, run_id/workflow/step, and the one-shot
    // respond token — to this address, so a published entry carrying one means
    // "every stranger who runs me calls home". That is telemetry by default, not
    // configuration. The legitimate case (a fixed team bot) has the per-run
    // override, which belongs to the environment rather than to the author.
    //
    // The engine raises this flag ONLY for non-localhost URLs, so presence is
    // the whole test — re-deciding "is this local" here would be a second
    // definition of loopback, which is exactly how the two drift apart.
    if (f.flag === 'network' && f.where === INBOX_WEBHOOK_WHERE) {
      findings.push(
        `inbox_webhook egress: '${f.match}' — a catalog entry may not ship a non-localhost ` +
          `webhook; use the per-run override (--inbox-webhook / the /api/run field) instead`,
      );
    }
  }
  return findings;
}

function validateEntry(id, scratch) {
  const errors = [];
  const dir = join(CATALOG_DIR, id);
  const entryPath = join(dir, 'entry.yaml');
  const lockPath = join(dir, 'entry.lock.yaml');
  if (!existsSync(entryPath)) return { errors: ['entry.yaml is missing'], level: null };
  if (!existsSync(lockPath)) return { errors: ['entry.lock.yaml is missing — generate it with `riglane catalog pack`'], level: null };

  let entry;
  try {
    entry = parseYaml(readFileSync(entryPath, 'utf-8'));
  } catch (e) {
    return { errors: [`entry.yaml does not parse: ${e.message}`], level: null };
  }
  errors.push(...validateEntryShape(id, entry));
  if (errors.length > 0) return { errors, level: null };

  let cloneDir = null;
  try {
    let workflowDir;
    try {
      ({ cloneDir, workflowDir } = fetchPinnedTree(entry.source, scratch));
    } catch (e) {
      return { errors: [e.message], level: null };
    }

    // The engine's own validator, verbatim.
    const v = riglane(['validate-workflow', join(workflowDir, 'workflow.yaml')]);
    if (v.status !== 0) {
      return { errors: [`riglane validate-workflow failed:\n${(v.stderr || v.stdout).trim()}`], level: null };
    }

    // Regenerate the lock and byte-compare. Mismatch = the submitted inventory
    // does not describe the pinned tree — tampered, stale, or packed by a
    // different riglane version (regenerate and resubmit).
    const p = riglane(['catalog', 'pack', workflowDir, '--stdout']);
    if (p.status !== 0) {
      return { errors: [`riglane catalog pack failed:\n${(p.stderr || p.stdout).trim()}`], level: null };
    }
    // EOL-normalized on BOTH sides (BUG-243): the submitted lock may be
    // CRLF-smudged by a Windows checkout, and `pack --stdout` may pass through
    // a shell that rewrites line endings. Line endings are a checkout
    // artifact, not content — a CRLF-only difference attests nothing.
    const submitted = readFileSync(lockPath, 'utf-8').replace(/\r\n/g, '\n');
    if (p.stdout.replace(/\r\n/g, '\n') !== submitted) {
      return {
        errors: [
          'entry.lock.yaml does NOT match the lock regenerated from the pinned commit. ' +
            'Regenerate it with `riglane catalog pack` at the pinned tree and resubmit. ' +
            '(If your working tree uses CRLF line endings, pack from a clean checkout — ' +
            'the pinned COMMIT is the canonical content.)',
        ],
        level: null,
      };
    }

    const lock = parseYaml(p.stdout);
    const danger = dangerFindings(lock);
    if (danger.length > 0) {
      return {
        errors: [
          'rejected command shapes found (the catalog refuses these outright):',
          ...danger.map((d) => `  - ${d}`),
        ],
        level: null,
      };
    }
    return { errors: [], level: deriveLevel(lock) };
  } finally {
    if (cloneDir !== null) rmSync(cloneDir, { recursive: true, force: true });
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * True when this file is the process entry point rather than an import.
 *
 * realpath on BOTH sides deliberately: an install can reach the script through
 * a junction or a differently-cased drive letter, in which case the raw argv
 * path and import.meta.url disagree and the guard silently never fires — the
 * trap the engine repository hit twice in its own CLI bootstrap.
 */
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function main() {
  const requested = process.argv.slice(2);
  const all = existsSync(CATALOG_DIR)
    ? readdirSync(CATALOG_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : [];
  const ids = requested.length > 0 ? requested : all;

  if (ids.length === 0) {
    console.log('No catalog entries to validate.');
    process.exit(0);
  }

  const scratch = mkdtempSync(join(tmpdir(), 'riglane-catalog-ci-'));
  let failed = 0;
  try {
    for (const id of ids) {
      const { errors, level } = validateEntry(id, scratch);
      if (errors.length > 0) {
        failed += 1;
        console.error(`✗ ${id}`);
        for (const e of errors) console.error(`    ${e}`);
      } else {
        console.log(`✓ ${id}  [${level}]`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  if (failed > 0) {
    console.error(`\n${failed} of ${ids.length} entr${ids.length === 1 ? 'y' : 'ies'} failed.`);
    process.exit(1);
  }
  console.log(`\nAll ${ids.length} entr${ids.length === 1 ? 'y' : 'ies'} valid.`);
}

if (isMainModule()) main();
