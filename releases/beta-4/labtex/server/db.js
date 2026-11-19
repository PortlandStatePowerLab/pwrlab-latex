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
  role TEXT NOT NULL CHECK (role IN ('owner','admin','editor','commenter','viewer')),
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
const colsOf = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
const cols = colsOf('projects');
if (!cols.includes('track_changes')) db.exec('ALTER TABLE projects ADD COLUMN track_changes INTEGER NOT NULL DEFAULT 0');
// Everyone in the lab gets this role on the project (NULL = not shared with the lab).
if (!cols.includes('lab_role')) db.exec('ALTER TABLE projects ADD COLUMN lab_role TEXT');
const ucols = colsOf('users');
if (!ucols.includes('title')) db.exec('ALTER TABLE users ADD COLUMN title TEXT');
if (!ucols.includes('last_seen_at')) db.exec('ALTER TABLE users ADD COLUMN last_seen_at INTEGER');
// 'active' = member of the lab team; 'guest' = has an account (own projects, things shared with them
// directly) but is not on the lab team.
if (!ucols.includes('status')) db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
// Widen the members.role CHECK to the five project roles (SQLite needs a table rebuild).
const membersSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='members'").get()?.sql || '';
if (!membersSql.includes('commenter')) {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`CREATE TABLE members_new (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('owner','admin','editor','commenter','viewer')),
      PRIMARY KEY (project_id, user_id));
      INSERT INTO members_new SELECT project_id, user_id, role FROM members;
      DROP TABLE members;
      ALTER TABLE members_new RENAME TO members;`);
  })();
  db.pragma('foreign_keys = ON');
}

db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','done')),
  assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  due_date TEXT,
  file_path TEXT,
  line INTEGER,
  reminded_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id, status);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  data TEXT,
  read_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at, created_at);
`);

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

export const getSetting = (key, fallback = null) => db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? fallback;
export const setSetting = (key, value) => db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
