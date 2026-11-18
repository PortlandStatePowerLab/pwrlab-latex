import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'labtex.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  main_file TEXT NOT NULL DEFAULT 'main.tex',
  engine TEXT NOT NULL DEFAULT 'pdflatex',
  is_template INTEGER NOT NULL DEFAULT 0,
  template_description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  PRIMARY KEY (project_id, user_id)
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  is_binary INTEGER NOT NULL DEFAULT 0,
  content TEXT,
  data BLOB,
  ydoc BLOB,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_id, path)
);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  label TEXT,
  auto INTEGER NOT NULL DEFAULT 0,
  hash TEXT NOT NULL,
  files TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS blobs (
  hash TEXT PRIMARY KEY,
  data BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snap_project ON snapshots(project_id, created_at);
`);

// Lightweight migrations for databases created by earlier versions.
const cols = db.prepare("PRAGMA table_info(projects)").all().map((c) => c.name);
if (!cols.includes('track_changes')) db.exec('ALTER TABLE projects ADD COLUMN track_changes INTEGER NOT NULL DEFAULT 0');

export const newId = () => crypto.randomBytes(9).toString('base64url');
export const now = () => Date.now();

// The lab-wide shared bibliography lives in a special project everyone can edit.
export const LAB_PROJECT_ID = 'lab-library';
export function ensureLabLibrary() {
  if (db.prepare('SELECT 1 FROM projects WHERE id=?').get(LAB_PROJECT_ID)) return;
  const t = now();
  db.prepare('INSERT INTO projects (id,name,owner_id,main_file,engine,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(LAB_PROJECT_ID, 'Lab Library (shared bibliography)', null, 'main.tex', 'pdflatex', t, t);
  const ins = db.prepare('INSERT INTO files (id,project_id,path,is_binary,content,updated_at) VALUES (?,?,?,0,?,?)');
  ins.run(newId(), LAB_PROJECT_ID, 'lab.bib', `% Lab-wide shared bibliography.
% Every project can cite these entries with \\bibliography{lab}
% (or \\addbibresource{lab.bib} with biblatex). Edits here are shared live.

@article{einstein1905,
  author  = {Einstein, Albert},
  title   = {Zur Elektrodynamik bewegter K{\\"o}rper},
  journal = {Annalen der Physik},
  volume  = {322},
  number  = {10},
  pages   = {891--921},
  year    = {1905}
}

@book{knuth1984,
  author    = {Knuth, Donald E.},
  title     = {The {\\TeX}book},
  publisher = {Addison-Wesley},
  year      = {1984}
}
`, t);
  ins.run(newId(), LAB_PROJECT_ID, 'main.tex', `\\documentclass{article}
\\usepackage[margin=1in]{geometry}
\\title{Lab Library}
\\date{\\today}
\\begin{document}
\\maketitle
Compile this project to preview every entry in the shared lab bibliography.
\\nocite{*}
\\bibliographystyle{plain}
\\bibliography{lab}
\\end{document}
`, t);
}
ensureLabLibrary();
