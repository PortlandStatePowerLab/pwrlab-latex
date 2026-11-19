// Real-time collaboration: Yjs documents synced over WebSockets (compatible with the y-websocket client),
// plus a lightweight per-project event channel for file-tree changes and presence.
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { WebSocketServer } from 'ws';
import { db, now } from './db.js';
import { userFromRequest, roleFor, atLeast } from './auth.js';
import { addUserSocket, notify, projectManagerIds, touchSeen } from './notify.js';

const MSG_SYNC = 0, MSG_AWARENESS = 1, MSG_QUERY_AWARENESS = 3;
const rooms = new Map(); // fileId -> Room

class Room {
  constructor(file) {
    this.fileId = file.id;
    this.projectId = file.project_id;
    this.doc = new Y.Doc();
    this.text = this.doc.getText('content');
    if (file.ydoc) {
      Y.applyUpdate(this.doc, file.ydoc);
      // Guard against drift: DB content is the source of truth if they ever disagree.
      if (this.accepted() !== (file.content ?? '')) this.replace(file.content ?? '');
    } else {
      this.text.insert(0, file.content ?? '');
    }
    this.doc.getMap('threads').observeDeep((events, tr) => {
      try { onThreadsChange(this, events, tr); } catch (e) { console.error('comment notification failed', e); }
    });
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalState(null);
    this.conns = new Map(); // ws -> { clientIds:Set, readOnly }
    this.saveTimer = null;

    this.doc.on('update', (update, origin) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      this.broadcast(encoding.toUint8Array(enc));
      this.scheduleSave();
    });
    this.awareness.on('update', ({ added, updated, removed }, origin) => {
      const changed = added.concat(updated, removed);
      const c = this.conns.get(origin);
      if (c) {
        added.forEach((id) => c.clientIds.add(id));
        removed.forEach((id) => c.clientIds.delete(id));
      }
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      this.broadcast(encoding.toUint8Array(enc));
    });
  }
  broadcast(buf) { for (const ws of this.conns.keys()) if (ws.readyState === 1) ws.send(buf); }
  /** Text as if every tracked change were accepted: insertions kept, suggested deletions dropped. */
  accepted() { return acceptedText(this.text); }
  /**
   * Make the document read `content`, with no pending tracked changes. Only the differing middle
   * part is rewritten, so comments anchored elsewhere in the file keep their positions.
   */
  replace(content) {
    this.doc.transact(() => {
      const cur = this.text.toString();
      let a = 0;
      while (a < cur.length && a < content.length && cur[a] === content[a]) a++;
      let b = 0;
      while (b < cur.length - a && b < content.length - a && cur[cur.length - 1 - b] === content[content.length - 1 - b]) b++;
      const delLen = cur.length - a - b;
      if (delLen > 0) this.text.delete(a, delLen);
      const ins = content.slice(a, content.length - b);
      if (ins) this.text.insert(a, ins, {});
      if (this.text.length) this.text.format(0, this.text.length, { ins: null, del: null });
    }, 'server');
  }
  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 800);
  }
  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const t = now();
    const r = db.prepare('UPDATE files SET content=?, ydoc=?, updated_at=? WHERE id=?')
      .run(this.accepted(), Buffer.from(Y.encodeStateAsUpdate(this.doc)), t, this.fileId);
    if (r.changes) db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(t, this.projectId);
  }
  close(code = 4000, reason = 'closed') {
    for (const ws of this.conns.keys()) ws.close(code, reason);
  }
  destroy() {
    if (this.saveTimer) this.save();
    this.awareness.destroy();
    this.doc.destroy();
    rooms.delete(this.fileId);
  }
}

function getRoom(fileId) {
  let room = rooms.get(fileId);
  if (room) return room;
  const file = db.prepare('SELECT * FROM files WHERE id=? AND is_binary=0').get(fileId);
  if (!file) return null;
  room = new Room(file);
  rooms.set(fileId, room);
  return room;
}

/** Current text of a file (live room state if someone is editing it). */
export function getFileText(fileId) {
  const room = rooms.get(fileId);
  if (room) return room.accepted();
  return db.prepare('SELECT content FROM files WHERE id=?').get(fileId)?.content ?? '';
}

/** Overwrite a text file's contents, propagating to live editors. */
export function setFileText(fileId, content) {
  // Go through a (possibly temporary) room so comments and history in the Yjs state survive.
  const room = getRoom(fileId);
  if (!room) return;
  room.replace(content);
  room.save();
  if (room.conns.size === 0) room.destroy();
}

/** Accepted text of a Y.Text that may contain tracked-change attributes. */
export function acceptedText(ytext) {
  let out = '';
  for (const op of ytext.toDelta()) {
    if (typeof op.insert === 'string' && !op.attributes?.del) out += op.insert;
  }
  return out;
}

/** Flush any pending edits for a project to the DB. */
export function flushProject(projectId) {
  for (const room of rooms.values()) if (room.projectId === projectId && room.saveTimer) room.save();
}

/** Disconnect editors of a file (e.g. it was deleted). */
export function closeFileRoom(fileId) {
  const room = rooms.get(fileId);
  if (room) { room.close(4004, 'file removed'); room.destroy(); }
}

// ---------- Project event channel ----------
const projectChannels = new Map(); // projectId -> Set<ws>

function presence(projectId) {
  const set = projectChannels.get(projectId);
  if (!set) return [];
  const seen = new Map();
  for (const ws of set) seen.set(ws.user.id, { id: ws.user.id, name: ws.user.name, color: ws.color });
  return [...seen.values()];
}

export function emitProject(projectId, event, exceptWs = null) {
  const set = projectChannels.get(projectId);
  if (!set) return;
  const msg = JSON.stringify(event);
  for (const ws of set) if (ws !== exceptWs && ws.readyState === 1) ws.send(msg);
}

export function closeProject(projectId) {
  for (const room of [...rooms.values()]) if (room.projectId === projectId) { room.close(4004, 'project removed'); room.destroy(); }
  for (const ws of projectChannels.get(projectId) || []) ws.close(4004, 'project removed');
}

/** Disconnect a specific user from a project (e.g. their access was revoked). */
export function kickUser(projectId, userId) {
  for (const room of rooms.values()) {
    if (room.projectId !== projectId) continue;
    for (const ws of room.conns.keys()) if (ws.user.id === userId) ws.close(4003, 'access revoked');
  }
  for (const ws of projectChannels.get(projectId) || []) if (ws.user.id === userId) ws.close(4003, 'access revoked');
}

const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#9a6324', '#469990', '#800000'];
const colorFor = (id) => COLORS[id % COLORS.length];

// ---------- WebSocket wiring ----------
export function attachWebSockets(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    // Reject cross-site WebSocket connections.
    const origin = req.headers.origin;
    if (origin) {
      let host = null;
      try { host = new URL(origin).host; } catch {}
      const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (host !== req.headers.host && !allowed.includes(origin)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    }
    const user = userFromRequest(req);
    if (user && url.pathname === '/ws/user') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.user = user; ws.isAlive = true; ws.on('pong', () => (ws.isAlive = true));
        ws.on('message', () => touchSeen(user.id));
        addUserSocket(ws);
      });
      return;
    }
    const m = url.pathname.match(/^\/ws\/(doc|project)\/([\w-]+)$/);
    if (!user || !m) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    const [, kind, id] = m;
    let projectId = id, fileId = null;
    if (kind === 'doc') {
      const f = db.prepare('SELECT project_id FROM files WHERE id=? AND is_binary=0').get(id);
      if (!f) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
      projectId = f.project_id; fileId = id;
    }
    const role = roleFor(user, projectId);
    if (!role) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.user = user; ws.color = colorFor(user.id); ws.role = role;
      // editor+: full sync; commenter: only comment changes are accepted; viewer: read-only.
      ws.mode = atLeast(role, 'editor') ? 'edit' : role === 'commenter' ? 'comment' : 'view';
      ws.readOnly = ws.mode !== 'edit';
      if (kind === 'doc') handleDoc(ws, fileId); else handleProject(ws, projectId);
    });
  });

  // Heartbeat to drop dead connections.
  setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false; ws.ping();
    }
  }, 30000);
  wss.on('connection', () => {});
  return wss;
}

function handleProject(ws, projectId) {
  ws.isAlive = true; ws.on('pong', () => (ws.isAlive = true));
  if (!projectChannels.has(projectId)) projectChannels.set(projectId, new Set());
  projectChannels.get(projectId).add(ws);
  const announce = () => emitProject(projectId, { type: 'presence', users: presence(projectId) });
  announce();
  ws.on('message', () => {}); // server-push only
  ws.on('close', () => {
    const set = projectChannels.get(projectId);
    set?.delete(ws);
    if (set && set.size === 0) projectChannels.delete(projectId);
    announce();
  });
}

/** True if applying `update` would change nothing but the comment threads. */
function commentOnly(room, update) {
  const before = JSON.stringify(room.text.toDelta());
  const probe = new Y.Doc();
  Y.applyUpdate(probe, Y.encodeStateAsUpdate(room.doc));
  Y.applyUpdate(probe, update);
  // Reject updates that can't be fully applied (they depend on changes we refused earlier).
  const pending = probe.store.pendingStructs || probe.store.pendingDs;
  const ok = !pending && JSON.stringify(probe.getText('content').toDelta()) === before;
  probe.destroy();
  return ok;
}

// ---------- Comment notifications ----------
// New threads notify the project's owner/admins, replies notify everyone in the thread, @mentions
// notify the mentioned member, and resolving notifies the thread's author.
function membersOf(projectId) {
  return db.prepare(`SELECT u.id,u.name FROM users u WHERE u.id IN (SELECT user_id FROM members WHERE project_id=?)
    OR ((u.status='active' OR u.is_admin=1) AND (SELECT lab_role FROM projects WHERE id=?) IS NOT NULL)`).all(projectId, projectId);
}
function mentionedIds(text, projectId) {
  if (!text || !text.includes('@')) return [];
  const lower = text.toLowerCase();
  return membersOf(projectId).filter((m) => lower.includes('@' + m.name.toLowerCase())).map((m) => m.id);
}
function onThreadsChange(room, events, tr) {
  const actor = tr.origin?.user;
  if (!actor) return; // server-side or initial load
  const file = db.prepare('SELECT path FROM files WHERE id=?').get(room.fileId);
  const base = { actorId: actor.id, projectId: room.projectId };
  const threads = room.doc.getMap('threads');
  for (const ev of events) {
    if (ev.target === threads) {
      for (const [id, change] of ev.changes.keys) {
        if (change.action !== 'add') continue;
        const t = threads.get(id);
        const first = t?.get('messages')?.get(0);
        const data = { fileId: room.fileId, path: file?.path, threadId: id, quote: (t?.get('quote') || '').slice(0, 120), text: (first?.text || '').slice(0, 200) };
        const mentioned = mentionedIds(first?.text, room.projectId);
        notify(mentioned, { ...base, type: 'comment_mention', data });
        notify(projectManagerIds(room.projectId).filter((u) => !mentioned.includes(u)), { ...base, type: 'comment_new', data });
      }
    } else if (ev.target instanceof Y.Array && ev.path.length === 2 && ev.path[1] === 'messages') {
      const threadId = ev.path[0];
      const t = threads.get(threadId);
      const all = t?.get('messages')?.toArray() || [];
      for (const item of ev.changes.added) {
        for (const msg of item.content.getContent()) {
          const data = { fileId: room.fileId, path: file?.path, threadId, quote: (t?.get('quote') || '').slice(0, 120), text: (msg.text || '').slice(0, 200) };
          const mentioned = mentionedIds(msg.text, room.projectId);
          notify(mentioned, { ...base, type: 'comment_mention', data });
          const participants = [t?.get('uid'), ...all.map((m) => m.uid)].filter((u) => !mentioned.includes(u));
          notify(participants, { ...base, type: 'comment_reply', data });
        }
      }
    } else if (ev.target instanceof Y.Map && ev.path.length === 1 && ev.changes.keys.has('resolved')) {
      const t = ev.target;
      if (t.get('resolved')) notify([t.get('uid')], { ...base, type: 'comment_resolved', data: { fileId: room.fileId, path: file?.path, threadId: ev.path[0], quote: (t.get('quote') || '').slice(0, 120) } });
    }
  }
}

function handleDoc(ws, fileId) {
  const room = getRoom(fileId);
  if (!room) return ws.close(4004, 'not found');
  ws.isAlive = true; ws.on('pong', () => (ws.isAlive = true));
  ws.binaryType = 'arraybuffer';
  room.conns.set(ws, { clientIds: new Set() });

  ws.on('message', (data) => {
    try {
      const msg = new Uint8Array(data);
      const dec = decoding.createDecoder(msg);
      const type = decoding.readVarUint(dec);
      if (type === MSG_SYNC) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        if (ws.readOnly) {
          // Viewers/commenters may request state (step1). Viewers' updates are ignored; commenters'
          // updates are applied only if they leave the text untouched (i.e. they only change comments).
          const sub = decoding.readVarUint(dec);
          const payload = decoding.readVarUint8Array(dec);
          if (sub === syncProtocol.messageYjsSyncStep1) syncProtocol.writeSyncStep2(enc, room.doc, payload);
          else if (ws.mode === 'comment' && commentOnly(room, payload)) Y.applyUpdate(room.doc, payload, ws);
        } else {
          syncProtocol.readSyncMessage(dec, enc, room.doc, ws);
        }
        if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
      } else if (type === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(dec), ws);
      } else if (type === MSG_QUERY_AWARENESS) {
        sendAwareness(ws, room);
      }
    } catch (e) {
      console.error('collab message error', e);
    }
  });

  ws.on('close', () => {
    const c = room.conns.get(ws);
    room.conns.delete(ws);
    if (c) awarenessProtocol.removeAwarenessStates(room.awareness, [...c.clientIds], null);
    if (room.conns.size === 0 && rooms.get(fileId) === room) room.destroy();
  });

  // Start sync: send our state vector, and current awareness.
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeSyncStep1(enc, room.doc);
  ws.send(encoding.toUint8Array(enc));
  sendAwareness(ws, room);
}

function sendAwareness(ws, room) {
  const states = room.awareness.getStates();
  if (states.size === 0) return;
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_AWARENESS);
  encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()]));
  ws.send(encoding.toUint8Array(enc));
}

export function flushAll() { for (const room of rooms.values()) if (room.saveTimer) room.save(); }
