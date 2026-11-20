// mode=comment: a commenter adds a thread with an @mention; mode=edit: a commenter tries to edit text.
import * as Y from 'yjs'; import { WebsocketProvider } from 'y-websocket'; import WebSocket from 'ws'; import fs from 'fs';
const [,, base, fileId, cookieFile, mode] = process.argv;
const tok = fs.readFileSync(cookieFile, 'utf8').split('\n').find((l) => l.includes('labtex_session')).split('\t').pop();
class WS extends WebSocket { constructor(u, p) { super(u, p, { headers: { cookie: 'labtex_session=' + tok } }); } }
const d = new Y.Doc(); const p = new WebsocketProvider(base + '/ws/doc', fileId, d, { WebSocketPolyfill: WS, disableBc: true });
await new Promise((r) => p.on('sync', (s) => s && r()));
if (mode === 'edit') d.getText('content').insert(0, 'HACKED BY COMMENTER\n');
else d.transact(() => {
  const t = new Y.Map(); const msgs = new Y.Array();
  t.set('id', 'th1'); t.set('quote', 'Paper Title'); t.set('uid', 4); t.set('name', 'Dan Park'); t.set('resolved', false);
  t.set('start', Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(d.getText('content'), 30)));
  t.set('end', Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(d.getText('content'), 40, -1)));
  msgs.push([{ id: 'm1', uid: 4, name: 'Dan Park', text: 'Hey @Cara Diaz, can you check this title?', ts: Date.now() }]);
  t.set('messages', msgs); d.getMap('threads').set('th1', t);
});
await new Promise((r) => setTimeout(r, 1200)); p.destroy(); process.exit(0);
