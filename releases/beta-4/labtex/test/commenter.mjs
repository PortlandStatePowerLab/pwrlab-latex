// A commenter tries to (1) edit the text and (2) add a comment thread with an @mention.
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import fs from 'fs';
const [,, base, fileId, cookieFile] = process.argv;
const tok = fs.readFileSync(cookieFile, 'utf8').split('\n').find((l) => l.includes('labtex_session')).split('\t').pop();
class WS extends WebSocket { constructor(u, p) { super(u, p, { headers: { cookie: 'labtex_session=' + tok } }); } }
const d = new Y.Doc();
const p = new WebsocketProvider(base + '/ws/doc', fileId, d, { WebSocketPolyfill: WS, disableBc: true });
await new Promise((r) => p.on('sync', (s) => s && r()));
const before = d.getText('content').toString().length;
d.getText('content').insert(0, 'HACKED BY COMMENTER\n');
const t = new Y.Map(); const msgs = new Y.Array();
d.transact(() => {
  t.set('id', 'th1'); t.set('quote', 'Paper Title'); t.set('uid', 4); t.set('name', 'Dan Park'); t.set('resolved', false);
  t.set('start', Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(d.getText('content'), 30)));
  t.set('end', Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(d.getText('content'), 40, -1)));
  msgs.push([{ id: 'm1', uid: 4, name: 'Dan Park', text: 'Hey @Cara Diaz, can you check this title?', ts: Date.now() }]);
  t.set('messages', msgs); d.getMap('threads').set('th1', t);
});
await new Promise((r) => setTimeout(r, 1500));
p.destroy();
// Fresh connection to see what the server kept.
const d2 = new Y.Doc();
const p2 = new WebsocketProvider(base + '/ws/doc', fileId, d2, { WebSocketPolyfill: WS, disableBc: true });
await new Promise((r) => p2.on('sync', (s) => s && r()));
console.log('text edit kept by server:', d2.getText('content').toString().startsWith('HACKED'));
console.log('text length unchanged:', d2.getText('content').toString().length === before);
p2.destroy(); process.exit(0);
