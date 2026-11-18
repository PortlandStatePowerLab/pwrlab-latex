// LaTeX compilation with latexmk. Each project gets a persistent build directory so
// incremental builds (aux, bbl) are fast. Only restricted shell escape is allowed.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { db, DATA_DIR, LAB_PROJECT_ID } from './db.js';
import { getFileText, flushProject } from './collab.js';

const LATEXMKRC = path.join(path.dirname(new URL(import.meta.url).pathname), 'latexmkrc');
const BUILD_ROOT = path.resolve(process.env.BUILD_DIR || path.join(DATA_DIR, 'builds'));
// When set (the Docker image does this), TeX runs as this separate unprivileged user via sudo,
// so documents cannot read the database or other server files.
const COMPILE_USER = process.env.COMPILE_USER || '';
fs.mkdirSync(BUILD_ROOT, { recursive: true });
// Directories TeX writes into must be writable by the compile user.
const mkdirShared = (dir) => {
  if (fs.existsSync(dir)) return;
  mkdirShared(path.dirname(dir));
  fs.mkdirSync(dir);
  if (COMPILE_USER) fs.chmodSync(dir, 0o777);
};
const TIMEOUT_MS = Number(process.env.COMPILE_TIMEOUT_SECONDS || 120) * 1000;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_COMPILES || 3);
const ENGINES = { pdflatex: '-pdf', xelatex: '-pdfxe', lualatex: '-pdflua' };
export const ENGINE_NAMES = Object.keys(ENGINES);

const inFlight = new Map(); // projectId -> Promise
let running = 0;
const queue = [];
const acquire = () => new Promise((r) => (running < MAX_CONCURRENT ? (running++, r()) : queue.push(r)));
const release = () => { const next = queue.shift(); if (next) next(); else running--; };

export const buildDir = (projectId) => path.join(BUILD_ROOT, projectId);
export const pdfPath = (projectId) => {
  const p = db.prepare('SELECT main_file FROM projects WHERE id=?').get(projectId);
  if (!p) return null;
  return path.join(buildDir(projectId), p.main_file.replace(/\.tex$/i, '') + '.pdf');
};

/** Reject absolute paths, traversal, and odd characters. Returns a normalized relative path or null. */
export function safePath(p) {
  if (typeof p !== 'string') return null;
  const s = p.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').replace(/\/$/, '');
  if (!s || s.length > 300) return null;
  const parts = s.split('/');
  if (parts.some((x) => !x || x === '.' || x === '..' || /[\x00-\x1f:*?"<>|]/.test(x))) return null;
  return s;
}

export function compile(projectId) {
  if (inFlight.has(projectId)) return inFlight.get(projectId);
  const p = (async () => {
    await acquire();
    try { return await runCompile(projectId); } finally { release(); inFlight.delete(projectId); }
  })();
  inFlight.set(projectId, p);
  return p;
}

async function runCompile(projectId) {
  flushProject(projectId);
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
  const dir = buildDir(projectId);
  mkdirShared(dir);

  // Sync project files into the build dir.
  const files = db.prepare('SELECT id,path,is_binary,data FROM files WHERE project_id=?').all(projectId);
  const want = new Set();
  for (const f of files) {
    const rel = safePath(f.path);
    if (!rel) continue;
    want.add(rel);
    const dest = path.join(dir, rel);
    mkdirShared(path.dirname(dest));
    const buf = f.is_binary ? f.data : Buffer.from(getFileText(f.id), 'utf8');
    // Only write if changed, so latexmk's change detection stays cheap.
    try { if (fs.readFileSync(dest).equals(buf)) continue; } catch {}
    writeShared(dest, buf);
  }
  // Make the lab-wide bibliography available as lab.bib unless the project has its own.
  if (projectId !== LAB_PROJECT_ID && !want.has('lab.bib')) {
    const lab = db.prepare("SELECT id FROM files WHERE project_id=? AND path='lab.bib'").get(LAB_PROJECT_ID);
    if (lab) {
      const buf = Buffer.from(getFileText(lab.id), 'utf8');
      const dest = path.join(dir, 'lab.bib');
      let same = false;
      try { same = fs.readFileSync(dest).equals(buf); } catch {}
      if (!same) writeShared(dest, buf);
    }
  }

  const main = safePath(project.main_file);
  if (!main || !want.has(main)) {
    return { ok: false, errors: [{ file: null, line: null, message: `Main file "${project.main_file}" not found. Choose a main file in the file tree.` }], warnings: [], log: '' };
  }
  const engineFlag = ENGINES[project.engine] || '-pdf';
  // Restricted shell escape (TeX Live's default) lets trusted helpers like latexminted
  // (minted v3), bibtex and repstopdf run, but never arbitrary commands.
  const args = ['-norc', '-r', LATEXMKRC, engineFlag, '-interaction=nonstopmode', '-file-line-error', '-synctex=1',
    '-f', '-g', main];

  const started = Date.now();
  const { code, output, timedOut } = await run('latexmk', args, dir);
  const base = main.replace(/\.tex$/i, '');
  let log = '';
  try { log = fs.readFileSync(path.join(dir, base + '.log'), 'latin1'); } catch { log = output; }
  const pdf = path.join(dir, base + '.pdf');
  const pdfOk = fs.existsSync(pdf) && fs.statSync(pdf).mtimeMs >= started - 1000;
  const parsed = parseLog(log);
  if (timedOut) parsed.errors.unshift({ file: null, line: null, message: `Compile timed out after ${TIMEOUT_MS / 1000}s.` });
  if (code !== 0 && parsed.errors.length === 0) {
    parsed.errors.push({ file: null, line: null, message: 'Compilation failed. See the raw log for details.' });
  }
  return { ok: code === 0 && pdfOk, hasPdf: fs.existsSync(pdf), ...parsed, log: log + (output ? '\n\n===== latexmk output =====\n' + output.slice(-20000) : ''), ms: Date.now() - started };
}

// Write a file, replacing one the compile user may own (we own the directory, so unlink works).
function writeShared(dest, buf) {
  try { fs.writeFileSync(dest, buf); } catch (e) {
    if (e.code !== 'EACCES') throw e;
    fs.rmSync(dest, { force: true }); fs.writeFileSync(dest, buf);
  }
}

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    const texEnv = { openout_any: 'p', openin_any: 'p', shell_escape: 'p', max_print_line: '10000' };
    const secs = Math.ceil(TIMEOUT_MS / 1000);
    let file, argv, env;
    if (COMPILE_USER) {
      const pairs = Object.entries({ ...texEnv, PATH: process.env.PATH, HOME: `/home/${COMPILE_USER}`, LANG: 'C.UTF-8' }).map(([k, v]) => `${k}=${v}`);
      file = 'sudo';
      argv = ['-n', '-u', COMPILE_USER, '/usr/bin/env', '-i', ...pairs, '/bin/sh', '-c', `umask 000 && exec timeout -s KILL ${secs} "$@"`, 'sh', cmd, ...args];
      env = process.env;
    } else {
      file = cmd; argv = args; env = { ...process.env, ...texEnv };
    }
    const child = spawn(file, argv, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false;
    const onData = (d) => { output += d.toString(); if (output.length > 200000) output = output.slice(-100000); };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, TIMEOUT_MS + 5000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, output: String(e), timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); if (code === 137 || code === 124) timedOut = true; resolve({ code, output, timedOut }); });
  });
}

export function parseLog(log) {
  const errors = [], warnings = [];
  const lines = log.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m = l.match(/^(?:\.\/)?([^:\s][^:]*\.(?:tex|sty|cls|bib|bbl|ltx|dtx)):(\d+): (.*)$/);
    if (m) {
      // Include the context line(s) that follow ("l.12 \foo") for clarity.
      let ctx = '';
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) if (/^l\.\d+/.test(lines[j])) { ctx = lines[j]; break; }
      if (/==> Fatal error occurred/.test(m[3])) continue;
      errors.push({ file: m[1], line: Number(m[2]), message: m[3] + (ctx ? `\n${ctx}` : '') });
      continue;
    }
    if (/^! /.test(l)) { errors.push({ file: null, line: null, message: l.slice(2) }); continue; }
    m = l.match(/^(?:LaTeX|Package (\S+)|Class (\S+)) Warning: (.*)$/);
    if (m) {
      let msg = m[3];
      for (let j = i + 1; j < lines.length && /^\(\S*\)\s+|^\s{2,}/.test(lines[j]) && j < i + 6; j++) msg += ' ' + lines[j].replace(/^\(\S*\)\s+/, '').trim();
      const lm = msg.match(/on input line (\d+)/);
      warnings.push({ file: null, line: lm ? Number(lm[1]) : null, message: (m[1] || m[2] ? `[${m[1] || m[2]}] ` : '') + msg });
      continue;
    }
    m = l.match(/^(Overfull|Underfull) \\[hv]box .* at lines? (\d+)/);
    if (m) warnings.push({ file: null, line: Number(m[2]), message: l, box: true });
  }
  // Dedupe errors (pdflatex + file-line-error report the same error twice).
  const seen = new Set();
  return { errors: errors.filter((e) => { const k = e.file + e.line + e.message.split('\n')[0]; if (seen.has(k)) return false; seen.add(k); return true; }), warnings };
}
