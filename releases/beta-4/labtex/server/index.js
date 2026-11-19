import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import AdmZip from 'adm-zip';
import { db, newId, now, LAB_PROJECT_ID, DATA_DIR, getSetting, setSetting } from './db.js';
import {
  createSession, destroySession, userFromRequest, requireUser, requireAdmin, requireLab,
  hashPassword, checkPassword, projectAccess, roleFor, atLeast, ROLES, LAB_ROLES,
} from './auth.js';
import { notify, markRead, hydrate, unreadCount, isOnline, projectMemberIds } from './notify.js';
import {
  attachWebSockets, getFileText, setFileText, flushProject, closeFileRoom,
  emitProject, closeProject, kickUser, flushAll,
} from './collab.js';
import { compile, pdfPath, buildDir, safePath, ENGINE_NAMES } from './compile.js';
import { BUILTIN_TEMPLATES } from './templates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const ALLOW_REGISTRATION = process.env.ALLOW_REGISTRATION !== 'false';
const REGISTRATION_CODE = process.env.REGISTRATION_CODE || '';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 50);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true');
app.use(express.json({ limit: '20mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 200 } });

const TEXT_EXT = /\.(tex|bib|bst|cls|sty|txt|md|csv|tsv|dat|cfg|def|clo|bbx|cbx|lbx|ltx|dtx|ins|json|yaml|yml|py|r|m|tikz|pgf|gp|asy|mp|latexmkrc|bbl|gitignore)$/i;
const isTextName = (p) => TEXT_EXT.test(p) || !/\.[^/]+$/.test(p);
const looksBinary = (buf) => buf.subarray(0, 8000).includes(0);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const rmQuiet = (p, opts) => { try { fs.rmSync(p, opts); } catch (e) { console.warn('cleanup failed', p, e.code); } };
const touch = (pid) => db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(now(), pid);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

// ---------------- Auth ----------------
// Anyone may sign up (unless 'closed'). 'approval': new accounts start outside the lab team and a lab
// admin decides whether to add them; 'open': new accounts join the lab team right away; 'closed': only
// admins create accounts. ALLOW_REGISTRATION=false forces 'closed'.
const SIGNUP_MODES = ['approval', 'open', 'closed'];
const signupMode = () => (ALLOW_REGISTRATION ? getSetting('signup_mode', 'approval') : 'closed');
const adminIds = () => db.prepare("SELECT id FROM users WHERE is_admin=1 AND status='active'").all().map((u) => u.id);

app.get('/api/config', (req, res) => {
  const hasUsers = !!db.prepare('SELECT 1 FROM users LIMIT 1').get();
  const mode = signupMode();
  res.json({ allowRegistration: mode !== 'closed' || !hasUsers, needsCode: !!REGISTRATION_CODE && hasUsers, hasUsers, engines: ENGINE_NAMES });
});

app.post('/api/register', (req, res) => {
  const { email, name, password, code } = req.body || {};
  const hasUsers = !!db.prepare('SELECT 1 FROM users LIMIT 1').get();
  const mode = signupMode();
  if (hasUsers && mode === 'closed') return bad(res, 'Sign-up is turned off. Ask a lab admin to create your account.', 403);
  if (hasUsers && REGISTRATION_CODE && code !== REGISTRATION_CODE) return bad(res, 'Invalid lab registration code.', 403);
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) return bad(res, 'Enter a valid email.');
  if (!name?.trim()) return bad(res, 'Enter your name.');
  if (!password || password.length < 8) return bad(res, 'Password must be at least 8 characters.');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return bad(res, 'An account with that email already exists.');
  const guest = hasUsers && mode === 'approval';
  const info = db.prepare('INSERT INTO users (email,name,password_hash,is_admin,created_at,status) VALUES (?,?,?,?,?,?)')
    .run(email.trim(), name.trim(), hashPassword(password), hasUsers ? 0 : 1, now(), guest ? 'guest' : 'active');
  if (guest) notify(adminIds(), { type: 'signup_request', actorId: info.lastInsertRowid, data: { name: name.trim(), email: email.trim() } });
  createSession(res, info.lastInsertRowid);
  res.json({ ok: true });
});

// Basic brute-force protection: 10 failed logins per IP per 15 minutes.
const failures = new Map();
setInterval(() => { const t = Date.now(); for (const [k, v] of failures) if (t - v.first > 15 * 60e3) failures.delete(k); }, 60e3).unref();
app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const f = failures.get(req.ip);
  if (f && f.count >= 10 && Date.now() - f.first < 15 * 60e3) return bad(res, 'Too many failed attempts. Try again in 15 minutes.', 429);
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email || '');
  if (!u || !checkPassword(password || '', u.password_hash)) {
    const cur = failures.get(req.ip) || { count: 0, first: Date.now() };
    cur.count++; failures.set(req.ip, cur);
    return bad(res, 'Wrong email or password.', 401);
  }
  failures.delete(req.ip);
  createSession(res, u.id);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => { destroySession(req, res); res.json({ ok: true }); });

app.get('/api/me', requireUser, (req, res) => res.json(req.user));

app.post('/api/me/password', requireUser, (req, res) => {
  const { current, next } = req.body || {};
  const u = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user.id);
  if (!checkPassword(current || '', u.password_hash)) return bad(res, 'Current password is wrong.', 403);
  if (!next || next.length < 8) return bad(res, 'New password must be at least 8 characters.');
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(next), req.user.id);
  res.json({ ok: true });
});

app.patch('/api/me', requireUser, (req, res) => {
  const { name, title } = req.body || {};
  if (name !== undefined) {
    if (!name.trim()) return bad(res, 'Name required.');
    db.prepare('UPDATE users SET name=? WHERE id=?').run(name.trim(), req.user.id);
  }
  if (title !== undefined) db.prepare('UPDATE users SET title=? WHERE id=?').run(String(title).trim().slice(0, 80) || null, req.user.id);
  res.json({ ok: true });
});

// ---------------- Admin ----------------
app.get('/api/admin/users', requireUser, requireAdmin, (req, res) => {
  res.json(db.prepare(`SELECT u.id,u.email,u.name,u.is_admin,u.created_at,
    (SELECT COUNT(*) FROM members m WHERE m.user_id=u.id AND m.role='owner') AS projects
    FROM users u ORDER BY u.created_at`).all());
});

// Sign-up requests and the sign-up policy.
app.get('/api/admin/signups', requireUser, requireAdmin, (req, res) => {
  res.json({
    mode: signupMode(), locked: !ALLOW_REGISTRATION, needsCode: !!REGISTRATION_CODE,
    guests: db.prepare(`SELECT u.id,u.name,u.email,u.created_at,u.last_seen_at,
      (SELECT COUNT(*) FROM members m WHERE m.user_id=u.id AND m.role='owner') AS projects
      FROM users u WHERE u.status='guest' AND u.is_admin=0 ORDER BY u.created_at DESC`).all(),
  });
});
app.patch('/api/admin/signups', requireUser, requireAdmin, (req, res) => {
  const { mode } = req.body || {};
  if (!SIGNUP_MODES.includes(mode)) return bad(res, 'Unknown sign-up mode.');
  if (!ALLOW_REGISTRATION) return bad(res, 'Sign-up is turned off by ALLOW_REGISTRATION=false on the server.');
  setSetting('signup_mode', mode);
  res.json({ ok: true, mode });
});
// Add someone to the lab team, or take them off it (they keep their account and own projects).
app.post('/api/admin/users/:uid/lab', requireUser, requireAdmin, (req, res) => {
  const uid = Number(req.params.uid);
  const member = !!req.body?.member;
  const u = db.prepare('SELECT id,is_admin,status FROM users WHERE id=?').get(uid);
  if (!u) return bad(res, 'User not found.', 404);
  if (!member && u.is_admin) return bad(res, 'Lab admins are always on the lab team. Remove their admin rights first.');
  db.prepare('UPDATE users SET status=? WHERE id=?').run(member ? 'active' : 'guest', uid);
  if (member && u.status !== 'active') notify([uid], { type: 'lab_joined', actorId: req.user.id, data: {} });
  // Their access to lab-wide projects changed: make open editors reconnect.
  for (const p of db.prepare('SELECT id FROM projects WHERE lab_role IS NOT NULL OR id=?').all(LAB_PROJECT_ID)) kickUser(p.id, uid);
  res.json({ ok: true });
});

app.post('/api/admin/users', requireUser, requireAdmin, (req, res) => {
  const { email, name, password, is_admin } = req.body || {};
  if (!email || !name || !password || password.length < 8) return bad(res, 'Email, name and a password of 8+ characters are required.');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return bad(res, 'Email already in use.');
  db.prepare("INSERT INTO users (email,name,password_hash,is_admin,created_at,status) VALUES (?,?,?,?,?,'active')")
    .run(email.trim(), name.trim(), hashPassword(password), is_admin ? 1 : 0, now());
  res.json({ ok: true });
});

app.patch('/api/admin/users/:uid', requireUser, requireAdmin, (req, res) => {
  const uid = Number(req.params.uid);
  const { is_admin, password } = req.body || {};
  if (is_admin !== undefined) {
    if (uid === req.user.id && !is_admin) return bad(res, "You can't remove your own admin rights.");
    db.prepare(`UPDATE users SET is_admin=?${is_admin ? ", status='active'" : ''} WHERE id=?`).run(is_admin ? 1 : 0, uid);
  }
  if (password) {
    if (password.length < 8) return bad(res, 'Password must be at least 8 characters.');
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(password), uid);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(uid);
  }
  res.json({ ok: true });
});

app.delete('/api/admin/users/:uid', requireUser, requireAdmin, (req, res) => {
  const uid = Number(req.params.uid);
  if (uid === req.user.id) return bad(res, "You can't delete yourself.");
  // Transfer owned projects to the admin performing the deletion so work isn't lost.
  const owned = db.prepare("SELECT project_id FROM members WHERE user_id=? AND role='owner'").all(uid);
  const tx = db.transaction(() => {
    for (const { project_id } of owned) {
      db.prepare('INSERT OR REPLACE INTO members (project_id,user_id,role) VALUES (?,?,?)').run(project_id, req.user.id, 'owner');
      db.prepare('UPDATE projects SET owner_id=? WHERE id=?').run(req.user.id, project_id);
    }
    db.prepare('DELETE FROM users WHERE id=?').run(uid);
  });
  tx();
  res.json({ ok: true, transferred: owned.length });
});

// ---------------- Projects ----------------
function listFiles(pid) {
  return db.prepare(`SELECT id,path,is_binary,updated_at,
      CASE WHEN is_binary THEN length(data) ELSE length(content) END AS size
    FROM files WHERE project_id=? ORDER BY path`).all(pid);
}

function createProject(ownerId, name, files, opts = {}) {
  const id = newId(), t = now();
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO projects (id,name,owner_id,main_file,engine,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, name, ownerId, opts.main_file || 'main.tex', opts.engine || 'pdflatex', t, t);
    db.prepare('INSERT INTO members (project_id,user_id,role) VALUES (?,?,?)').run(id, ownerId, 'owner');
    const ins = db.prepare('INSERT INTO files (id,project_id,path,is_binary,content,data,updated_at) VALUES (?,?,?,?,?,?,?)');
    for (const f of files) {
      const p = safePath(f.path);
      if (!p) continue;
      ins.run(newId(), id, p, f.is_binary ? 1 : 0, f.is_binary ? null : f.content ?? '', f.is_binary ? f.data : null, t);
    }
  });
  tx();
  return id;
}

function projectFilesForCopy(pid) {
  flushProject(pid);
  return db.prepare('SELECT path,is_binary,content,data FROM files WHERE project_id=?').all(pid);
}

app.get('/api/projects', requireUser, (req, res) => {
  // Your projects plus everything shared with the whole lab; `role` is your effective role.
  const rows = db.prepare(`SELECT p.id,p.name,p.updated_at,p.created_at,p.is_template,p.lab_role,m.role AS member_role,u.name AS owner_name,
      (SELECT COUNT(*) FROM members mm WHERE mm.project_id=p.id) AS member_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id AND t.status!='done') AS open_tasks
    FROM projects p LEFT JOIN members m ON m.project_id=p.id AND m.user_id=?
    LEFT JOIN users u ON u.id=p.owner_id
    WHERE p.id != ? AND (m.user_id IS NOT NULL OR (? AND p.lab_role IS NOT NULL)) ORDER BY p.updated_at DESC`).all(req.user.id, LAB_PROJECT_ID, req.user.lab_member ? 1 : 0);
  res.json(rows.map((r) => ({ ...r, role: roleFor(req.user, r.id), via_lab: !r.member_role })));
});

app.get('/api/templates', requireUser, (req, res) => {
  const lab = db.prepare(`SELECT p.id,p.name,p.template_description AS description,u.name AS owner_name
    FROM projects p LEFT JOIN users u ON u.id=p.owner_id WHERE p.is_template=1 ORDER BY p.name`).all().filter(() => req.user.lab_member);
  res.json({
    builtin: BUILTIN_TEMPLATES.map(({ id, name, description }) => ({ id, name, description })),
    lab,
  });
});

app.post('/api/projects', requireUser, (req, res) => {
  const name = (req.body?.name || '').trim() || 'Untitled project';
  const tpl = req.body?.template || 'blank';
  let files, opts = {};
  if (tpl.startsWith('project:')) {
    const src = tpl.slice(8);
    const p = db.prepare('SELECT * FROM projects WHERE id=? AND is_template=1').get(src);
    if (!p || !req.user.lab_member) return bad(res, 'Template not found.', 404);
    files = projectFilesForCopy(src);
    opts = { main_file: p.main_file, engine: p.engine };
  } else {
    const b = BUILTIN_TEMPLATES.find((t) => t.id === tpl);
    if (!b) return bad(res, 'Unknown template.');
    files = Object.entries(b.files).map(([p, content]) => ({ path: p, content }));
  }
  res.json({ id: createProject(req.user.id, name, files, opts) });
});

app.post('/api/projects/import', requireUser, upload.single('zip'), (req, res) => {
  if (!req.file) return bad(res, 'Upload a .zip file.');
  let zip;
  try { zip = new AdmZip(req.file.buffer); } catch { return bad(res, 'That file is not a valid zip archive.'); }
  let entries = zip.getEntries().filter((e) => !e.isDirectory && !/(^|\/)(__MACOSX|\.DS_Store)/.test(e.entryName));
  if (!entries.length) return bad(res, 'The zip is empty.');
  if (entries.length > 2000) return bad(res, 'Too many files in zip (max 2000).');
  // Strip a single common top-level folder (Overleaf/GitHub exports have one).
  const tops = new Set(entries.map((e) => e.entryName.split('/')[0]));
  const strip = tops.size === 1 && entries.every((e) => e.entryName.includes('/')) ? [...tops][0] + '/' : '';
  let total = 0;
  const files = [];
  for (const e of entries) {
    const p = safePath(e.entryName.slice(strip.length));
    if (!p) continue;
    const buf = e.getData();
    total += buf.length;
    if (total > MAX_UPLOAD_MB * 4 * 1024 * 1024) return bad(res, 'Zip contents are too large.');
    const binary = !isTextName(p) || looksBinary(buf);
    files.push(binary ? { path: p, is_binary: true, data: buf } : { path: p, content: buf.toString('utf8') });
  }
  const texs = files.filter((f) => /\.tex$/i.test(f.path));
  const main = texs.find((f) => /\\documentclass/.test(f.content || '') && !f.path.includes('/'))
    || texs.find((f) => /\\documentclass/.test(f.content || '')) || texs[0];
  const name = (req.body?.name || '').trim() || req.file.originalname.replace(/\.zip$/i, '') || 'Imported project';
  res.json({ id: createProject(req.user.id, name, files, { main_file: main?.path || 'main.tex' }) });
});

app.get('/api/projects/:id', requireUser, projectAccess('viewer'), (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  const members = db.prepare(`SELECT u.id,u.name,u.email,u.title,m.role FROM members m JOIN users u ON u.id=m.user_id
    WHERE m.project_id=? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'editor' THEN 2 WHEN 'commenter' THEN 3 ELSE 4 END, u.name`).all(p.id);
  res.json({ ...p, is_lab: p.id === LAB_PROJECT_ID, role: req.role, files: listFiles(p.id), members, engines: ENGINE_NAMES });
});

app.patch('/api/projects/:id', requireUser, projectAccess('editor'), (req, res) => {
  const { name, main_file, engine, is_template, template_description, track_changes, lab_role } = req.body || {};
  const pid = req.params.id;
  if (name !== undefined) {
    if (!atLeast(req.role, 'admin')) return bad(res, 'Only the owner or a project admin can rename the project.', 403);
    if (!name.trim()) return bad(res, 'Name required.');
    db.prepare('UPDATE projects SET name=? WHERE id=?').run(name.trim(), pid);
  }
  if (main_file !== undefined) {
    const mf = safePath(main_file);
    if (!mf || !db.prepare('SELECT 1 FROM files WHERE project_id=? AND path=? AND is_binary=0').get(pid, mf)) return bad(res, 'Main file must be an existing text file.');
    db.prepare('UPDATE projects SET main_file=? WHERE id=?').run(mf, pid);
  }
  if (lab_role !== undefined) {
    if (!atLeast(req.role, 'admin')) return bad(res, 'Only the owner or a project admin can share with the whole lab.', 403);
    if (!req.user.lab_member) return bad(res, 'Only lab-team members can share with the whole lab.', 403);
    if (pid === LAB_PROJECT_ID) return bad(res, 'The lab library is always shared with everyone.');
    if (lab_role !== null && !LAB_ROLES.includes(lab_role)) return bad(res, 'Lab-wide role must be viewer, commenter or editor.');
    const before = db.prepare('SELECT lab_role,name FROM projects WHERE id=?').get(pid);
    db.prepare('UPDATE projects SET lab_role=? WHERE id=?').run(lab_role, pid);
    if (lab_role && !before.lab_role) {
      const everyone = db.prepare("SELECT id FROM users WHERE status='active' OR is_admin=1").all().map((u) => u.id).filter((id) => !projectMemberIds(pid).includes(id));
      notify(everyone, { type: 'lab_share', actorId: req.user.id, projectId: pid, data: { role: lab_role, name: before.name } });
    }
    // Lab members' effective access changed: make their open editors reconnect.
    for (const u of db.prepare('SELECT id FROM users').all()) if (!projectMemberIds(pid).includes(u.id)) kickUser(pid, u.id);
  }
  if (track_changes !== undefined) db.prepare('UPDATE projects SET track_changes=? WHERE id=?').run(track_changes ? 1 : 0, pid);
  if (engine !== undefined) {
    if (!ENGINE_NAMES.includes(engine)) return bad(res, 'Unknown engine.');
    db.prepare('UPDATE projects SET engine=? WHERE id=?').run(engine, pid);
  }
  if (is_template !== undefined || template_description !== undefined) {
    if (!atLeast(req.role, 'admin')) return bad(res, 'Only the owner or a project admin can publish a lab template.', 403);
    if (!req.user.lab_member) return bad(res, 'Only lab-team members can publish lab templates.', 403);
    if (pid === LAB_PROJECT_ID) return bad(res, 'Not allowed for the lab library.');
    if (is_template !== undefined) db.prepare('UPDATE projects SET is_template=? WHERE id=?').run(is_template ? 1 : 0, pid);
    if (template_description !== undefined) db.prepare('UPDATE projects SET template_description=? WHERE id=?').run(String(template_description).slice(0, 300), pid);
  }
  touch(pid);
  emitProject(pid, { type: 'project' });
  res.json({ ok: true });
});

app.delete('/api/projects/:id', requireUser, projectAccess('owner'), (req, res) => {
  const pid = req.params.id;
  if (pid === LAB_PROJECT_ID) return bad(res, 'The lab library cannot be deleted.');
  closeProject(pid);
  db.prepare('DELETE FROM projects WHERE id=?').run(pid);
  rmQuiet(buildDir(pid), { recursive: true, force: true });
  res.json({ ok: true });
});

app.post('/api/projects/:id/copy', requireUser, projectAccess('viewer'), (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  const name = (req.body?.name || '').trim() || `Copy of ${p.name}`;
  res.json({ id: createProject(req.user.id, name, projectFilesForCopy(p.id), { main_file: p.main_file, engine: p.engine }) });
});

// ---------------- Sharing ----------------
// Owner > admin > editor > commenter > viewer. Owners and project admins manage sharing; only the
// owner can make someone else owner (transfer) or touch the owner's membership.
const MEMBER_ROLES = ['viewer', 'commenter', 'editor', 'admin'];
const roleLabel = (r) => ({ viewer: 'Viewer', commenter: 'Commenter', editor: 'Editor', admin: 'Admin', owner: 'Owner' })[r] || r;

app.post('/api/projects/:id/members', requireUser, projectAccess('admin'), (req, res) => {
  const { email, userId, role } = req.body || {};
  if (req.params.id === LAB_PROJECT_ID) return bad(res, 'Everyone in the lab already has access to the library.');
  if (!MEMBER_ROLES.includes(role)) return bad(res, 'Role must be viewer, commenter, editor or admin.');
  const u = userId ? db.prepare('SELECT id,name FROM users WHERE id=?').get(Number(userId)) : db.prepare('SELECT id,name FROM users WHERE email=? COLLATE NOCASE').get((email || '').trim());
  if (!u) return bad(res, 'No LabTeX account with that email. They need to sign up first.', 404);
  const existing = db.prepare('SELECT role FROM members WHERE project_id=? AND user_id=?').get(req.params.id, u.id);
  if (existing?.role === 'owner') return bad(res, 'That user is the owner.');
  if (existing?.role === role) return res.json({ ok: true });
  db.prepare('INSERT OR REPLACE INTO members (project_id,user_id,role) VALUES (?,?,?)').run(req.params.id, u.id, role);
  const name = db.prepare('SELECT name FROM projects WHERE id=?').get(req.params.id).name;
  notify([u.id], { type: existing ? 'role_change' : 'share', actorId: req.user.id, projectId: req.params.id, data: { role, name } });
  if (existing) kickUser(req.params.id, u.id);
  emitProject(req.params.id, { type: 'project' });
  res.json({ ok: true });
});

app.patch('/api/projects/:id/members/:uid', requireUser, projectAccess('admin'), (req, res) => {
  const uid = Number(req.params.uid);
  const { role } = req.body || {};
  const m = db.prepare('SELECT role FROM members WHERE project_id=? AND user_id=?').get(req.params.id, uid);
  if (!m) return bad(res, 'Not a member.', 404);
  const name = db.prepare('SELECT name FROM projects WHERE id=?').get(req.params.id).name;
  if (role === 'owner') {
    if (req.role !== 'owner') return bad(res, 'Only the owner can transfer ownership.', 403);
    // Transfer ownership: current owner becomes admin.
    db.transaction(() => {
      db.prepare("UPDATE members SET role='admin' WHERE project_id=? AND role='owner'").run(req.params.id);
      db.prepare("UPDATE members SET role='owner' WHERE project_id=? AND user_id=?").run(req.params.id, uid);
      db.prepare('UPDATE projects SET owner_id=? WHERE id=?').run(uid, req.params.id);
    })();
    notify([uid], { type: 'role_change', actorId: req.user.id, projectId: req.params.id, data: { role: 'owner', name } });
  } else if (MEMBER_ROLES.includes(role)) {
    if (m.role === 'owner') return bad(res, 'Transfer ownership to someone else first.');
    db.prepare('UPDATE members SET role=? WHERE project_id=? AND user_id=?').run(role, req.params.id, uid);
    notify([uid], { type: 'role_change', actorId: req.user.id, projectId: req.params.id, data: { role, name } });
    kickUser(req.params.id, uid); // reconnect with new permissions
  } else return bad(res, 'Invalid role.');
  emitProject(req.params.id, { type: 'project' });
  res.json({ ok: true });
});

app.delete('/api/projects/:id/members/:uid', requireUser, (req, res) => {
  const uid = Number(req.params.uid);
  const role = roleFor(req.user, req.params.id);
  const self = uid === req.user.id;
  if (!role || (!self && !atLeast(role, 'admin'))) return bad(res, 'Not allowed.', 403);
  const m = db.prepare('SELECT role FROM members WHERE project_id=? AND user_id=?').get(req.params.id, uid);
  if (!m) return bad(res, 'Not a member.', 404);
  if (m.role === 'owner') return bad(res, 'The owner cannot be removed. Transfer ownership or delete the project.');
  db.prepare('DELETE FROM members WHERE project_id=? AND user_id=?').run(req.params.id, uid);
  kickUser(req.params.id, uid);
  emitProject(req.params.id, { type: 'project' });
  res.json({ ok: true });
});

// ---------------- Team directory ----------------
app.get('/api/team', requireUser, requireLab, (req, res) => {
  const users = db.prepare("SELECT id,name,email,title,is_admin,created_at,last_seen_at FROM users WHERE status='active' OR is_admin=1 ORDER BY name COLLATE NOCASE").all();
  const counts = db.prepare(`SELECT m.user_id, COUNT(*) AS n FROM members m JOIN projects p ON p.id=m.project_id
    WHERE p.id IN (SELECT project_id FROM members WHERE user_id=?) OR p.lab_role IS NOT NULL GROUP BY m.user_id`).all(req.user.id);
  const shared = new Map(counts.map((c) => [c.user_id, c.n]));
  const openTasks = new Map(db.prepare("SELECT assignee_id, COUNT(*) AS n FROM tasks WHERE status!='done' AND assignee_id IS NOT NULL GROUP BY assignee_id").all().map((r) => [r.assignee_id, r.n]));
  res.json(users.map((u) => ({ ...u, is_admin: !!u.is_admin, online: isOnline(u.id), shared_projects: u.id === req.user.id ? null : shared.get(u.id) || 0, open_tasks: openTasks.get(u.id) || 0 })));
});

app.get('/api/team/:uid', requireUser, requireLab, (req, res) => {
  const uid = Number(req.params.uid);
  const u = db.prepare("SELECT id,name,email,title,is_admin,created_at,last_seen_at FROM users WHERE id=? AND (status='active' OR is_admin=1)").get(uid);
  if (!u) return bad(res, 'Not found.', 404);
  const visible = (pid) => !!roleFor(req.user, pid);
  // Projects this person is on that you can also open, with their role there.
  const projects = db.prepare(`SELECT p.id,p.name,p.updated_at,m.role FROM members m JOIN projects p ON p.id=m.project_id
    WHERE m.user_id=? AND p.id != ? ORDER BY p.updated_at DESC`).all(uid, LAB_PROJECT_ID).filter((p) => visible(p.id));
  const tasks = db.prepare(`SELECT t.*, p.name AS project_name FROM tasks t JOIN projects p ON p.id=t.project_id
    WHERE t.assignee_id=? AND t.status!='done' ORDER BY t.due_date IS NULL, t.due_date, t.created_at`).all(uid).filter((t) => visible(t.project_id));
  // Projects you could share with them (you're owner/admin there and they aren't a member yet).
  const shareable = db.prepare(`SELECT p.id,p.name FROM projects p JOIN members m ON m.project_id=p.id AND m.user_id=? AND m.role IN ('owner','admin')
    WHERE p.id NOT IN (SELECT project_id FROM members WHERE user_id=?) ORDER BY p.name`).all(req.user.id, uid);
  res.json({ ...u, is_admin: !!u.is_admin, online: isOnline(uid), projects, tasks: tasks.map(taskOut), shareable });
});

// ---------------- Tasks ----------------
function taskOut(t) {
  const name = (id) => (id ? db.prepare('SELECT name FROM users WHERE id=?').get(id)?.name || null : null);
  return { ...t, assignee_name: name(t.assignee_id), created_by_name: name(t.created_by) };
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function cleanTask(body, pid) {
  const out = {};
  if (body.title !== undefined) { out.title = String(body.title).trim().slice(0, 200); if (!out.title) throw new Error('Give the task a title.'); }
  if (body.description !== undefined) out.description = String(body.description || '').slice(0, 5000) || null;
  if (body.status !== undefined) { if (!['todo', 'doing', 'done'].includes(body.status)) throw new Error('Invalid status.'); out.status = body.status; }
  if (body.due_date !== undefined) { if (body.due_date && !DATE_RE.test(body.due_date)) throw new Error('Invalid due date.'); out.due_date = body.due_date || null; }
  if (body.assignee_id !== undefined) {
    const id = body.assignee_id ? Number(body.assignee_id) : null;
    if (id) {
      const u = db.prepare('SELECT id,name,email,is_admin FROM users WHERE id=?').get(id);
      if (!u || !roleFor({ id: u.id, is_admin: !!u.is_admin }, pid)) throw new Error('The assignee must have access to this project. Share it with them first.');
    }
    out.assignee_id = id;
  }
  if (body.file_path !== undefined) out.file_path = body.file_path ? safePath(body.file_path) : null;
  if (body.line !== undefined) out.line = body.line ? Math.max(1, Number(body.line) | 0) : null;
  return out;
}

app.get('/api/projects/:id/tasks', requireUser, projectAccess('viewer'), (req, res) => {
  res.json(db.prepare(`SELECT * FROM tasks WHERE project_id=? ORDER BY CASE status WHEN 'doing' THEN 0 WHEN 'todo' THEN 1 ELSE 2 END,
    due_date IS NULL, due_date, created_at`).all(req.params.id).map(taskOut));
});

app.post('/api/projects/:id/tasks', requireUser, projectAccess('commenter'), (req, res) => {
  const pid = req.params.id;
  let t;
  try { t = cleanTask(req.body || {}, pid); } catch (e) { return bad(res, e.message); }
  if (!t.title) return bad(res, 'Give the task a title.');
  const ts = now();
  const info = db.prepare(`INSERT INTO tasks (project_id,title,description,status,assignee_id,created_by,due_date,file_path,line,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(pid, t.title, t.description ?? null, t.status || 'todo', t.assignee_id ?? null, req.user.id, t.due_date ?? null, t.file_path ?? null, t.line ?? null, ts, ts);
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(info.lastInsertRowid);
  const name = db.prepare('SELECT name FROM projects WHERE id=?').get(pid).name;
  if (task.assignee_id) notify([task.assignee_id], { type: 'task_assigned', actorId: req.user.id, projectId: pid, taskId: task.id, data: { title: task.title, due: task.due_date, name } });
  emitProject(pid, { type: 'tasks' });
  touch(pid);
  res.json(taskOut(task));
});

app.patch('/api/projects/:id/tasks/:tid', requireUser, projectAccess('viewer'), (req, res) => {
  const pid = req.params.id;
  const task = db.prepare('SELECT * FROM tasks WHERE id=? AND project_id=?').get(Number(req.params.tid), pid);
  if (!task) return bad(res, 'Task not found.', 404);
  const isEditor = atLeast(req.role, 'editor');
  const isCreator = task.created_by === req.user.id && atLeast(req.role, 'commenter');
  const isAssignee = task.assignee_id === req.user.id;
  const body = req.body || {};
  if (!isEditor && !isCreator) {
    // Assignees (even viewers) may move their own task along, nothing else.
    if (!isAssignee || Object.keys(body).some((k) => k !== 'status')) return bad(res, 'You can only change the status of tasks assigned to you.', 403);
  }
  let t;
  try { t = cleanTask(body, pid); } catch (e) { return bad(res, e.message); }
  if (!Object.keys(t).length) return res.json(taskOut(task));
  const ts = now();
  if (t.status) t.completed_at = t.status === 'done' ? (task.status === 'done' ? task.completed_at : ts) : null;
  if (t.due_date !== undefined && t.due_date !== task.due_date) t.reminded_at = null;
  const sets = Object.keys(t).map((k) => `${k}=?`).join(',');
  db.prepare(`UPDATE tasks SET ${sets}, updated_at=? WHERE id=?`).run(...Object.values(t), ts, task.id);
  const updated = db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id);
  const name = db.prepare('SELECT name FROM projects WHERE id=?').get(pid).name;
  const data = { title: updated.title, due: updated.due_date, name };
  if (t.assignee_id !== undefined && t.assignee_id && t.assignee_id !== task.assignee_id) {
    notify([t.assignee_id], { type: 'task_assigned', actorId: req.user.id, projectId: pid, taskId: task.id, data });
  }
  if (t.status && t.status !== task.status) {
    notify([task.created_by, updated.assignee_id], { type: 'task_status', actorId: req.user.id, projectId: pid, taskId: task.id, data: { ...data, status: t.status } });
  }
  emitProject(pid, { type: 'tasks' });
  res.json(taskOut(updated));
});

app.delete('/api/projects/:id/tasks/:tid', requireUser, projectAccess('viewer'), (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id=? AND project_id=?').get(Number(req.params.tid), req.params.id);
  if (!task) return bad(res, 'Task not found.', 404);
  if (!atLeast(req.role, 'editor') && !(task.created_by === req.user.id && atLeast(req.role, 'commenter'))) return bad(res, 'Only editors or the task’s creator can delete it.', 403);
  db.prepare('DELETE FROM tasks WHERE id=?').run(task.id);
  emitProject(req.params.id, { type: 'tasks' });
  res.json({ ok: true });
});

/** Tasks across all projects you can open: assigned to you, or created by you. */
app.get('/api/tasks', requireUser, (req, res) => {
  const scope = req.query.scope === 'created' ? 'created_by' : 'assignee_id';
  const rows = db.prepare(`SELECT t.*, p.name AS project_name FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.${scope}=?
    ORDER BY t.status='done', CASE t.status WHEN 'doing' THEN 0 ELSE 1 END, t.due_date IS NULL, t.due_date, t.created_at DESC LIMIT 500`).all(req.user.id);
  res.json(rows.filter((t) => roleFor(req.user, t.project_id)).map(taskOut));
});

// Due-date reminders: once, when a task is due today or tomorrow and not done.
function localDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 864e5);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function sendDueReminders() {
  const due = db.prepare(`SELECT t.*, p.name AS project_name FROM tasks t JOIN projects p ON p.id=t.project_id
    WHERE t.status!='done' AND t.assignee_id IS NOT NULL AND t.reminded_at IS NULL AND t.due_date IS NOT NULL AND t.due_date <= ?`).all(localDate(1));
  for (const t of due) {
    notify([t.assignee_id], { type: 'task_due', projectId: t.project_id, taskId: t.id, data: { title: t.title, due: t.due_date, name: t.project_name, overdue: t.due_date < localDate(0) } });
    db.prepare('UPDATE tasks SET reminded_at=? WHERE id=?').run(now(), t.id);
  }
}
setInterval(sendDueReminders, 15 * 60e3).unref();
setTimeout(sendDueReminders, 10e3).unref();

// ---------------- Notifications ----------------
app.get('/api/notifications', requireUser, (req, res) => {
  const limit = Math.min(100, Number(req.query.limit) || 40);
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id=? AND id<? ORDER BY id DESC LIMIT ?').all(req.user.id, before, limit);
  res.json({ items: hydrate(rows), unread: unreadCount(req.user.id) });
});
app.post('/api/notifications/read', requireUser, (req, res) => {
  const ids = req.body?.all ? 'all' : (Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : []);
  markRead(req.user.id, ids);
  res.json({ ok: true, unread: unreadCount(req.user.id) });
});

// ---------------- Files ----------------
app.post('/api/projects/:id/files', requireUser, projectAccess('editor'), (req, res) => {
  const p = safePath(req.body?.path);
  if (!p) return bad(res, 'Invalid file name.');
  if (db.prepare('SELECT 1 FROM files WHERE project_id=? AND path=?').get(req.params.id, p)) return bad(res, 'A file with that name already exists.');
  if (db.prepare('SELECT 1 FROM files WHERE project_id=? AND path LIKE ?').get(req.params.id, p + '/%')) return bad(res, 'A folder with that name already exists.');
  const id = newId();
  db.prepare('INSERT INTO files (id,project_id,path,is_binary,content,updated_at) VALUES (?,?,?,0,?,?)')
    .run(id, req.params.id, p, req.body?.content ?? '', now());
  touch(req.params.id);
  emitProject(req.params.id, { type: 'files' });
  res.json({ id, path: p });
});

app.post('/api/projects/:id/upload', requireUser, projectAccess('editor'), upload.array('files'), (req, res) => {
  const folder = req.body?.folder ? safePath(req.body.folder) : '';
  if (req.body?.folder && !folder) return bad(res, 'Invalid folder.');
  const out = [];
  const t = now();
  db.transaction(() => {
    for (const f of req.files || []) {
      const name = Buffer.from(f.originalname, 'latin1').toString('utf8'); // multer decodes as latin1
      const p = safePath((folder ? folder + '/' : '') + path.basename(name));
      if (!p) continue;
      const binary = !isTextName(p) || looksBinary(f.buffer);
      const existing = db.prepare('SELECT id,is_binary FROM files WHERE project_id=? AND path=?').get(req.params.id, p);
      if (existing) {
        if (!binary && !existing.is_binary) setFileText(existing.id, f.buffer.toString('utf8'));
        else {
          closeFileRoom(existing.id);
          db.prepare('UPDATE files SET is_binary=?,content=?,data=?,ydoc=NULL,updated_at=? WHERE id=?')
            .run(binary ? 1 : 0, binary ? null : f.buffer.toString('utf8'), binary ? f.buffer : null, t, existing.id);
        }
        out.push({ id: existing.id, path: p, replaced: true });
      } else {
        const id = newId();
        db.prepare('INSERT INTO files (id,project_id,path,is_binary,content,data,updated_at) VALUES (?,?,?,?,?,?,?)')
          .run(id, req.params.id, p, binary ? 1 : 0, binary ? null : f.buffer.toString('utf8'), binary ? f.buffer : null, t);
        out.push({ id, path: p });
      }
    }
  })();
  touch(req.params.id);
  emitProject(req.params.id, { type: 'files' });
  res.json({ files: out });
});

app.patch('/api/projects/:id/files/:fid', requireUser, projectAccess('editor'), (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id=? AND project_id=?').get(req.params.fid, req.params.id);
  if (!f) return bad(res, 'File not found.', 404);
  const p = safePath(req.body?.path);
  if (!p) return bad(res, 'Invalid file name.');
  if (p !== f.path && db.prepare('SELECT 1 FROM files WHERE project_id=? AND path=?').get(req.params.id, p)) return bad(res, 'A file with that name already exists.');
  db.prepare('UPDATE files SET path=? WHERE id=?').run(p, f.id);
  const proj = db.prepare('SELECT main_file FROM projects WHERE id=?').get(req.params.id);
  if (proj.main_file === f.path) db.prepare('UPDATE projects SET main_file=? WHERE id=?').run(p, req.params.id);
  rmQuiet(path.join(buildDir(req.params.id), f.path), { force: true });
  touch(req.params.id);
  emitProject(req.params.id, { type: 'files' });
  res.json({ ok: true });
});

// Rename/move a folder (all files under a prefix).
app.post('/api/projects/:id/folders/rename', requireUser, projectAccess('editor'), (req, res) => {
  const from = safePath(req.body?.from), to = safePath(req.body?.to);
  if (!from || !to) return bad(res, 'Invalid folder name.');
  if (to.startsWith(from + '/')) return bad(res, "Can't move a folder into itself.");
  const files = db.prepare('SELECT id,path FROM files WHERE project_id=? AND path LIKE ?').all(req.params.id, from + '/%');
  const proj = db.prepare('SELECT main_file FROM projects WHERE id=?').get(req.params.id);
  try {
    db.transaction(() => {
      for (const f of files) {
        const np = to + f.path.slice(from.length);
        db.prepare('UPDATE files SET path=? WHERE id=?').run(np, f.id);
        if (proj.main_file === f.path) db.prepare('UPDATE projects SET main_file=? WHERE id=?').run(np, req.params.id);
      }
    })();
  } catch { return bad(res, 'A file already exists at the destination.'); }
  rmQuiet(path.join(buildDir(req.params.id), from), { recursive: true, force: true });
  emitProject(req.params.id, { type: 'files' });
  res.json({ ok: true });
});

app.post('/api/projects/:id/folders/delete', requireUser, projectAccess('editor'), (req, res) => {
  const folder = safePath(req.body?.folder);
  if (!folder) return bad(res, 'Invalid folder.');
  const files = db.prepare('SELECT id FROM files WHERE project_id=? AND path LIKE ?').all(req.params.id, folder + '/%');
  for (const f of files) closeFileRoom(f.id);
  db.prepare('DELETE FROM files WHERE project_id=? AND path LIKE ?').run(req.params.id, folder + '/%');
  rmQuiet(path.join(buildDir(req.params.id), folder), { recursive: true, force: true });
  emitProject(req.params.id, { type: 'files' });
  res.json({ ok: true, deleted: files.length });
});

app.delete('/api/projects/:id/files/:fid', requireUser, projectAccess('editor'), (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id=? AND project_id=?').get(req.params.fid, req.params.id);
  if (!f) return bad(res, 'File not found.', 404);
  closeFileRoom(f.id);
  db.prepare('DELETE FROM files WHERE id=?').run(f.id);
  rmQuiet(path.join(buildDir(req.params.id), f.path), { force: true });
  touch(req.params.id);
  emitProject(req.params.id, { type: 'files' });
  res.json({ ok: true });
});

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', pdf: 'application/pdf', webp: 'image/webp' };
app.get('/api/projects/:id/files/:fid/raw', requireUser, projectAccess('viewer'), (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id=? AND project_id=?').get(req.params.fid, req.params.id);
  if (!f) return bad(res, 'File not found.', 404);
  const ext = f.path.split('.').pop().toLowerCase();
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.query.download) res.attachment(path.basename(f.path));
  if (f.is_binary) {
    res.type(MIME[ext] && ext !== 'svg' ? MIME[ext] : 'application/octet-stream');
    return res.send(f.data);
  }
  res.type('text/plain; charset=utf-8').send(getFileText(f.id));
});

// ---------------- Compile / PDF ----------------
app.post('/api/projects/:id/compile', requireUser, projectAccess('viewer'), wrap(async (req, res) => {
  const pid = req.params.id;
  const result = await compile(pid);
  if (result.ok && req.role !== 'viewer') autoSnapshot(pid, req.user.id);
  emitProject(pid, { type: 'compiled', by: req.user.name, ok: result.ok });
  res.json(result);
}));

app.get('/api/projects/:id/pdf', requireUser, projectAccess('viewer'), (req, res) => {
  const p = pdfPath(req.params.id);
  if (!p || !fs.existsSync(p)) return bad(res, 'Not compiled yet.', 404);
  const proj = db.prepare('SELECT name FROM projects WHERE id=?').get(req.params.id);
  res.setHeader('Cache-Control', 'no-store');
  if (req.query.download) res.attachment(proj.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') + '.pdf');
  res.type('application/pdf').sendFile(p);
});

app.get('/api/projects/:id/zip', requireUser, projectAccess('viewer'), (req, res) => {
  flushProject(req.params.id);
  const proj = db.prepare('SELECT name FROM projects WHERE id=?').get(req.params.id);
  const zip = new AdmZip();
  for (const f of db.prepare('SELECT id,path,is_binary,data FROM files WHERE project_id=?').all(req.params.id)) {
    zip.addFile(f.path, f.is_binary ? f.data : Buffer.from(getFileText(f.id), 'utf8'));
  }
  res.attachment((proj.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'project') + '.zip');
  res.type('application/zip').send(zip.toBuffer());
});

// SyncTeX: source -> PDF and PDF -> source.
function synctex(args, cwd) {
  return new Promise((resolve) => execFile('synctex', args, { cwd, timeout: 10000 }, (err, stdout) => resolve(err ? '' : stdout)));
}
app.get('/api/projects/:id/synctex/view', requireUser, projectAccess('viewer'), wrap(async (req, res) => {
  const pdf = pdfPath(req.params.id);
  const file = safePath(req.query.file), line = Number(req.query.line) || 1;
  if (!pdf || !fs.existsSync(pdf) || !file) return res.json({ boxes: [] });
  const dir = buildDir(req.params.id);
  const out = await synctex(['view', '-i', `${line}:0:${path.join(dir, file)}`, '-o', pdf], dir);
  const boxes = [];
  let cur = null;
  for (const l of out.split('\n')) {
    const [k, v] = [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1)];
    if (k === 'Page') { cur = { page: Number(v) }; boxes.push(cur); }
    else if (cur && ['h', 'v', 'W', 'H'].includes(k)) cur[k] = Number(v);
  }
  res.json({ boxes: boxes.filter((b) => b.page) });
}));
app.get('/api/projects/:id/synctex/edit', requireUser, projectAccess('viewer'), wrap(async (req, res) => {
  const pdf = pdfPath(req.params.id);
  if (!pdf || !fs.existsSync(pdf)) return res.json({});
  const dir = buildDir(req.params.id);
  const { page, x, y } = req.query;
  const out = await synctex(['edit', '-o', `${Number(page)}:${Number(x)}:${Number(y)}:${pdf}`], dir);
  const input = out.match(/^Input:(.*)$/m)?.[1];
  const line = Number(out.match(/^Line:(\d+)/m)?.[1]);
  if (!input) return res.json({});
  let rel = path.relative(dir, path.resolve(dir, input)).replace(/\\/g, '/');
  rel = rel.replace(/^(\.\/)+/, '');
  const f = db.prepare('SELECT id,path FROM files WHERE project_id=? AND path=?').get(req.params.id, rel);
  res.json(f ? { fileId: f.id, path: f.path, line } : {});
}));

// ---------------- History ----------------
function captureFiles(pid) {
  flushProject(pid);
  const files = db.prepare('SELECT id,path,is_binary,data FROM files WHERE project_id=? ORDER BY path').all(pid);
  return files.map((f) => {
    if (f.is_binary) {
      const h = sha(f.data);
      db.prepare('INSERT OR IGNORE INTO blobs (hash,data) VALUES (?,?)').run(h, f.data);
      return { path: f.path, is_binary: 1, blob: h, size: f.data.length };
    }
    return { path: f.path, is_binary: 0, content: getFileText(f.id) };
  });
}
function takeSnapshot(pid, userId, label, auto) {
  const files = captureFiles(pid);
  const json = JSON.stringify(files);
  const hash = sha(json);
  const last = db.prepare('SELECT hash FROM snapshots WHERE project_id=? ORDER BY id DESC LIMIT 1').get(pid);
  if (auto && last?.hash === hash) return null;
  const info = db.prepare('INSERT INTO snapshots (project_id,user_id,label,auto,hash,files,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(pid, userId, label || null, auto ? 1 : 0, hash, json, now());
  if (auto) {
    // Keep the newest 300 automatic snapshots per project.
    db.prepare(`DELETE FROM snapshots WHERE project_id=? AND auto=1 AND id NOT IN
      (SELECT id FROM snapshots WHERE project_id=? AND auto=1 ORDER BY id DESC LIMIT 300)`).run(pid, pid);
  }
  return info.lastInsertRowid;
}
const lastAuto = new Map();
function autoSnapshot(pid, userId) {
  // At most one automatic snapshot every 2 minutes per project.
  if (Date.now() - (lastAuto.get(pid) || 0) < 120000) return;
  if (takeSnapshot(pid, userId, null, true)) lastAuto.set(pid, Date.now());
}

app.get('/api/projects/:id/snapshots', requireUser, projectAccess('viewer'), (req, res) => {
  res.json(db.prepare(`SELECT s.id,s.label,s.auto,s.created_at,u.name AS user_name,json_array_length(s.files) AS file_count
    FROM snapshots s LEFT JOIN users u ON u.id=s.user_id WHERE s.project_id=? ORDER BY s.id DESC LIMIT 500`).all(req.params.id));
});

app.post('/api/projects/:id/snapshots', requireUser, projectAccess('editor'), (req, res) => {
  const label = (req.body?.label || '').trim().slice(0, 200);
  const id = takeSnapshot(req.params.id, req.user.id, label || 'Manual snapshot', false);
  emitProject(req.params.id, { type: 'history' });
  if (label) {
    const name = db.prepare('SELECT name FROM projects WHERE id=?').get(req.params.id).name;
    notify(projectMemberIds(req.params.id), { type: 'version', actorId: req.user.id, projectId: req.params.id, data: { label, name } });
  }
  res.json({ id });
});

app.patch('/api/projects/:id/snapshots/:sid', requireUser, projectAccess('editor'), (req, res) => {
  const label = (req.body?.label || '').trim().slice(0, 200);
  db.prepare('UPDATE snapshots SET label=?, auto=0 WHERE id=? AND project_id=?').run(label || null, req.params.sid, req.params.id);
  res.json({ ok: true });
});

app.get('/api/projects/:id/snapshots/:sid', requireUser, projectAccess('viewer'), (req, res) => {
  const s = db.prepare('SELECT * FROM snapshots WHERE id=? AND project_id=?').get(req.params.sid, req.params.id);
  if (!s) return bad(res, 'Snapshot not found.', 404);
  const current = captureFiles(req.params.id);
  res.json({ id: s.id, label: s.label, created_at: s.created_at, files: JSON.parse(s.files), current });
});

app.get('/api/projects/:id/snapshots/:sid/zip', requireUser, projectAccess('viewer'), (req, res) => {
  const s = db.prepare('SELECT * FROM snapshots WHERE id=? AND project_id=?').get(req.params.sid, req.params.id);
  if (!s) return bad(res, 'Snapshot not found.', 404);
  const zip = new AdmZip();
  for (const f of JSON.parse(s.files)) {
    const data = f.is_binary ? db.prepare('SELECT data FROM blobs WHERE hash=?').get(f.blob)?.data : Buffer.from(f.content, 'utf8');
    if (data) zip.addFile(f.path, data);
  }
  const proj = db.prepare('SELECT name FROM projects WHERE id=?').get(req.params.id);
  const stamp = new Date(s.created_at).toISOString().slice(0, 16).replace(/[:T]/g, '-');
  res.attachment(`${proj.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'project'}_${stamp}.zip`);
  res.type('application/zip').send(zip.toBuffer());
});

app.post('/api/projects/:id/snapshots/:sid/restore', requireUser, projectAccess('editor'), (req, res) => {
  const pid = req.params.id;
  const s = db.prepare('SELECT * FROM snapshots WHERE id=? AND project_id=?').get(req.params.sid, pid);
  if (!s) return bad(res, 'Snapshot not found.', 404);
  takeSnapshot(pid, req.user.id, `Before restoring “${s.label || new Date(s.created_at).toLocaleString()}”`, false);
  const snapFiles = JSON.parse(s.files);
  const onlyPath = req.body?.path ? safePath(req.body.path) : null; // optional single-file restore
  const existing = db.prepare('SELECT id,path,is_binary FROM files WHERE project_id=?').all(pid);
  const byPath = new Map(existing.map((f) => [f.path, f]));
  const t = now();
  db.transaction(() => {
    for (const sf of snapFiles) {
      if (onlyPath && sf.path !== onlyPath) continue;
      const cur = byPath.get(sf.path);
      const data = sf.is_binary ? db.prepare('SELECT data FROM blobs WHERE hash=?').get(sf.blob)?.data : null;
      if (cur && !cur.is_binary && !sf.is_binary) setFileText(cur.id, sf.content);
      else if (cur) {
        closeFileRoom(cur.id);
        db.prepare('UPDATE files SET is_binary=?,content=?,data=?,ydoc=NULL,updated_at=? WHERE id=?')
          .run(sf.is_binary, sf.is_binary ? null : sf.content, data, t, cur.id);
      } else {
        db.prepare('INSERT INTO files (id,project_id,path,is_binary,content,data,updated_at) VALUES (?,?,?,?,?,?,?)')
          .run(newId(), pid, sf.path, sf.is_binary, sf.is_binary ? null : sf.content, data, t);
      }
    }
    if (!onlyPath) {
      const keep = new Set(snapFiles.map((f) => f.path));
      for (const f of existing) if (!keep.has(f.path)) {
        closeFileRoom(f.id);
        db.prepare('DELETE FROM files WHERE id=?').run(f.id);
      }
    }
  })();
  if (!onlyPath) rmQuiet(buildDir(pid), { recursive: true, force: true });
  touch(pid);
  emitProject(pid, { type: 'files' });
  emitProject(pid, { type: 'history' });
  res.json({ ok: true });
});


// ---------------- Static frontend ----------------
const PUBLIC = path.join(__dirname, '..', 'public');
// Cache busting: the page references app.js/style.css with a content hash, so a new build is
// picked up immediately, and index.html itself is never cached.
const fileHash = (f) => { try { return sha(fs.readFileSync(path.join(PUBLIC, f))).slice(0, 10); } catch { return 'dev'; } };
const BUILD = fileHash('app.js');
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
  .replace('/app.js', `/app.js?v=${BUILD}`)
  .replace('/style.css', `/style.css?v=${fileHash('style.css')}`)
  .replace('<head>', `<head>\n  <meta name="labtex-build" content="${BUILD}">`);
console.log(`LabTeX build ${BUILD}`);
app.get('/api/version', (req, res) => res.json({ build: BUILD }));
const sendIndex = (req, res) => { res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); res.type('html').send(INDEX_HTML); };
app.get(['/', '/index.html'], sendIndex);
app.use(express.static(PUBLIC, {
  index: false,
  setHeaders: (res, file, stat) => {
    // Versioned URLs (?v=hash) can be cached forever; anything else must be revalidated.
    res.setHeader('Cache-Control', res.req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
  },
}));
app.get(/^\/(?!api\/|ws\/).*/, sendIndex);

app.use((err, req, res, next) => {
  console.error(err);
  if (err instanceof multer.MulterError) return bad(res, err.code === 'LIMIT_FILE_SIZE' ? `File too large (max ${MAX_UPLOAD_MB} MB).` : err.message);
  res.status(500).json({ error: 'Server error' });
});

// Clean expired sessions daily.
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now()), 864e5).unref();

const server = http.createServer(app);
attachWebSockets(server);
server.listen(PORT, () => console.log(`LabTeX listening on http://localhost:${PORT} (data: ${DATA_DIR})`));

const shutdown = () => { flushAll(); server.close(); db.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
