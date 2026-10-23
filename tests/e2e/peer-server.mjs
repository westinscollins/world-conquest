// Local PeerJS signalling server for testing the peer-to-peer transport offline: node tests/e2e/peer-server.mjs
import http from 'node:http';
import express from 'express';
import { ExpressPeerServer } from 'peer';
const app = express();
const server = http.createServer(app);
app.use('/', ExpressPeerServer(server, { path: '/' }));
server.listen(9000, '127.0.0.1', () => console.log('PeerJS server on 127.0.0.1:9000'));
