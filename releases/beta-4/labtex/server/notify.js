// In-app notifications: stored per user and pushed live over each user's /ws/user socket.
import { db, now } from './db.js';

const sockets = new Map(); // userId -> Set<ws>

export function addUserSocket(ws) {
  const id = ws.user.id;
  if (!sockets.has(id)) sockets.set(id, new Set());
  sockets.get(id).add(ws);
  touchSeen(id, true);
  ws.on('close', () => {
    const set = sockets.get(id);
    set?.delete(ws);
    if (set && !set.size) sockets.delete(id);
    touchSeen(id, true);
  });
  ws.send(JSON.stringify({ type: 'count', unread: unreadCount(id) }));
}

export const isOnline = (userId) => sockets.has(userId);
export const onlineUserIds = () => [...sockets.keys()];

const lastTouch = new Map();
/** Record activity (throttled to once a minute unless forced). */
export function touchSeen(userId, force = false) {
  const t = now();
  if (!force && t - (lastTouch.get(userId) || 0) < 60000) return;
  lastTouch.set(userId, t);
  db.prepare('UPDATE users SET last_seen_at=? WHERE id=?').run(t, userId);
}

function push(userId, msg) {
  const set = sockets.get(userId);
  if (!set) return;
  const data = JSON.stringify(msg);
  for (const ws of set) if (ws.readyState === 1) ws.send(data);
}

export const unreadCount = (userId) => db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND read_at IS NULL').get(userId).n;

/** Same shape the REST API returns. */
export function hydrate(rows) {
  const users = new Map();
  const projects = new Map();
  const user = (id) => {
    if (id == null) return null;
    if (!users.has(id)) users.set(id, db.prepare('SELECT id,name FROM users WHERE id=?').get(id) || null);
    return users.get(id);
  };
  const project = (id) => {
    if (!id) return null;
    if (!projects.has(id)) projects.set(id, db.prepare('SELECT id,name FROM projects WHERE id=?').get(id) || null);
    return projects.get(id);
  };
  return rows.map((r) => ({
    id: r.id, type: r.type, read: !!r.read_at, created_at: r.created_at,
    actor: user(r.actor_id), project: project(r.project_id), task_id: r.task_id,
    data: r.data ? JSON.parse(r.data) : {},
  }));
}

/**
 * Notify users (the actor is never notified about their own action).
 * @param {number[]} userIds
 * @param {{type:string, actorId?:number, projectId?:string, taskId?:number, data?:object}} n
 */
export function notify(userIds, n) {
  const targets = [...new Set(userIds)].filter((id) => id != null && id !== n.actorId);
  if (!targets.length) return;
  const ins = db.prepare('INSERT INTO notifications (user_id,type,actor_id,project_id,task_id,data,created_at) VALUES (?,?,?,?,?,?,?)');
  const t = now();
  for (const uid of targets) {
    const info = ins.run(uid, n.type, n.actorId ?? null, n.projectId ?? null, n.taskId ?? null, n.data ? JSON.stringify(n.data) : null, t);
    const row = db.prepare('SELECT * FROM notifications WHERE id=?').get(info.lastInsertRowid);
    push(uid, { type: 'notification', notification: hydrate([row])[0], unread: unreadCount(uid) });
  }
}

export function markRead(userId, ids) {
  const t = now();
  if (ids === 'all') db.prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL').run(t, userId);
  else for (const id of ids) db.prepare('UPDATE notifications SET read_at=? WHERE id=? AND user_id=?').run(t, id, userId);
  push(userId, { type: 'count', unread: unreadCount(userId) });
}

/** Members with explicit access to a project (not counting lab-wide access). */
export const projectMemberIds = (pid) => db.prepare('SELECT user_id FROM members WHERE project_id=?').all(pid).map((r) => r.user_id);
export const projectManagerIds = (pid) => db.prepare("SELECT user_id FROM members WHERE project_id=? AND role IN ('owner','admin')").all(pid).map((r) => r.user_id);

// Keep the table from growing forever: drop read notifications older than 90 days.
setInterval(() => db.prepare('DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < ?').run(now() - 90 * 864e5), 864e5).unref();
