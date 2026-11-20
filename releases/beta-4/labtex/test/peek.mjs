import * as Y from 'yjs'; import { WebsocketProvider } from 'y-websocket'; import WebSocket from 'ws'; import fs from 'fs';
const [,, base, fileId, cookieFile] = process.argv;
const tok = fs.readFileSync(cookieFile, 'utf8').split('\n').find((l) => l.includes('labtex_session')).split('\t').pop();
class WS extends WebSocket { constructor(u, p) { super(u, p, { headers: { cookie: 'labtex_session=' + tok } }); } }
const d = new Y.Doc(); const p = new WebsocketProvider(base + '/ws/doc', fileId, d, { WebSocketPolyfill: WS, disableBc: true });
await new Promise((r) => p.on('sync', (s) => s && r()));
console.log('  threads:', [...d.getMap('threads').keys()], '| text starts with HACKED:', d.getText('content').toString().startsWith('HACKED'));
p.destroy(); process.exit(0);
