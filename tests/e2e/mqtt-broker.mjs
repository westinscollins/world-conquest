// Local MQTT-over-WebSocket broker (aedes) for testing the relay path offline:
//   node tests/e2e/mqtt-broker.mjs [port=8090]
// Exported for unit tests too: startBroker(port) -> { close() }.
import http from 'node:http';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);

export async function startBroker(port = 8090) {
  const aedesMod = require('aedes');
  const aedes = (aedesMod.createBroker ?? aedesMod)();
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: '/mqtt', handleProtocols: (p) => (p.has('mqtt') ? 'mqtt' : false) });
  wss.on('connection', (ws) => aedes.handle(createWebSocketStream(ws)));
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return {
    port,
    aedes, // (tests drop single clients through it)
    close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(); aedes.close(() => server.close(() => r())); }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || 8090);
  await startBroker(port);
  console.log(`MQTT broker on ws://127.0.0.1:${port}/mqtt`);
}
