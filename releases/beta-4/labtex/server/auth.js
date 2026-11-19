import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

const cookie = {
  parse(h) {
    const out = {};
    for (const part of h.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {} }
    }
    return out;
  },
  serialize(name, value, o = {}) {
    let s = `${name}=${encodeURIComponent(value)}; Path=${o.path || '/'}; Max-Age=${o.maxAge ?? 0}`;
    if (o.httpOnly !== false) s += '; HttpOnly';
    s += '; SameSite=Lax';
    if (o.secure) s += '; Secure';
    return s;
  },
};
import { db, now, LAB_PROJECT_ID } from './db.js';
import { touchSeen } from './notify.js';

const SESSION_DAYS = 30;
export const COOKIE = 'labtex_session';
const SECURE_COOKIES = process.env.SECURE_COOKIES === 'true';

export function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = now() + SESSION_DAYS * 864e5;
  db.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)').run(token, userId, expires);
  res.setHeader('Set-Cookie', cookie.serialize(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', path: '/', secure: SECURE_COOKIES, maxAge: SESSION_DAYS * 86400,
  }));
}

export function destroySession(req, res) {
  const token = cookie.parse(req.headers.cookie || '')[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token);
  res.setHeader('Set-Cookie', cookie.serialize(COOKIE, '', { path: '/', maxAge: 0 }));
}

export function userFromRequest(req) {
  const token = cookie.parse(req.headers.cookie || '')[COOKIE];
  if (!token) return null;
  const row = db.prepare(`SELECT u.id,u.email,u.name,u.is_admin,u.title,u.status,s.expires_at FROM sessions s
    JOIN users u ON u.id=s.user_id WHERE s.token=?`).get(token);
  if (!row) return null;
  if (row.expires_at < now()) { db.prepare('DELETE FROM sessions WHERE token=?').run(token); return null; }
  return { id: row.id, email: row.email, name: row.name, title: row.title || '', is_admin: !!row.is_admin, lab_member: !!row.is_admin || row.status === 'active' };
}

export function requireUser(req, res, next) {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  req.user = user;
  touchSeen(user.id);
  next();
}

export function isLabMember(userId) {
  const u = db.prepare('SELECT is_admin,status FROM users WHERE id=?').get(userId);
  return !!u && (!!u.is_admin || u.status === 'active');
}
export function requireLab(req, res, next) {
  if (!req.user?.lab_member) return res.status(403).json({ error: 'Only lab-team members can see this. Ask a lab admin to add you to the lab team.' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admins only' });
  next();
}

export const hashPassword = (pw) => bcrypt.hashSync(pw, 10);
export const checkPassword = (pw, hash) => bcrypt.compareSync(pw, hash);

export const ROLES = ['viewer', 'commenter', 'editor', 'admin', 'owner'];
const RANK = { viewer: 1, commenter: 2, editor: 3, admin: 4, owner: 5 };
export const LAB_ROLES = ['viewer', 'commenter', 'editor']; // roles the whole lab can be given
/**
 * The user's effective role in a project, or null: the higher of their own membership and the
 * project's lab-wide role. Site admins get owner rights everywhere.
 */
export function roleFor(user, projectId) {
  if (!user) return null;
  const p = db.prepare('SELECT lab_role FROM projects WHERE id=?').get(projectId);
  if (!p) return null;
  // Lab-wide access (the lab library, "everyone in the lab" sharing) is for lab-team members only.
  const inLab = user.lab_member ?? isLabMember(user.id);
  if (projectId === LAB_PROJECT_ID) return user.is_admin ? 'owner' : inLab ? 'editor' : null;
  if (user.is_admin) return 'owner';
  const m = db.prepare('SELECT role FROM members WHERE project_id=? AND user_id=?').get(projectId, user.id);
  const candidates = [m?.role, inLab && p.lab_role].filter(Boolean);
  if (!candidates.length) return null;
  return candidates.sort((a, b) => RANK[b] - RANK[a])[0];
}
export const atLeast = (role, needed) => !!role && RANK[role] >= RANK[needed];

/** Express middleware factory: loads req.role for :id and enforces a minimum role. */
export const projectAccess = (needed) => (req, res, next) => {
  const role = roleFor(req.user, req.params.id);
  if (!role) return res.status(404).json({ error: 'Project not found' });
  if (!atLeast(role, needed)) return res.status(403).json({ error: `Requires ${needed} access` });
  req.role = role;
  next();
};
