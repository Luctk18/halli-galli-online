'use strict';
// Halli Galli – online multiplayer server. No dependencies (Node 18+).
// Realtime = Server-Sent Events, actions = POST. Run: node server.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 6;
const TURN_MS = 12000;      // auto-flip if the current player is idle this long
const LOCK_OK = 1700;       // pause after a correct bell
const LOCK_BAD = 800;       // pause after a wrong bell

const FRUITS = ['banana', 'strawberry', 'lime', 'plum'];
const COUNTS = [1, 1, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 5]; // 14 per fruit -> 56 cards
const COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#ec4899'];

const rooms = new Map();

// ---------- helpers ----------
const rnd = (n) => crypto.randomInt(n);
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function newDeck() {
  const d = [];
  for (const f of FRUITS) for (const n of COUNTS) d.push({ f, n });
  return shuffle(d);
}
const uid = () => crypto.randomBytes(12).toString('hex');
function roomCode() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do {
    c = '';
    for (let i = 0; i < 4; i++) c += L[rnd(L.length)];
  } while (rooms.has(c));
  return c;
}
const cleanName = (s) =>
  String(s || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 14) || 'Player';

function makeRoom() {
  const room = {
    code: roomCode(), players: [], status: 'lobby', turn: 0, lockUntil: 0,
    event: null, seq: 0, winner: null, timer: null, touched: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}
function addPlayer(room, name) {
  let nm = name, i = 2;
  while (room.players.some((p) => p.name === nm)) nm = `${name} ${i++}`;
  const used = new Set(room.players.map((p) => p.color));
  const p = {
    id: uid().slice(0, 8), token: uid(), name: nm,
    color: COLORS.find((c) => !used.has(c)) || COLORS[0],
    deck: [], pile: [], out: false, res: new Set(),
  };
  room.players.push(p);
  return p;
}

function setEvent(room, type, text, by) {
  room.event = { seq: ++room.seq, type, text, by: by || null };
}

function view(room, pid) {
  const cur = room.players[room.turn];
  return {
    code: room.code,
    status: room.status,
    you: pid,
    host: room.players[0] && room.players[0].id,
    turn: room.status === 'playing' && cur ? cur.id : null,
    lockMs: Math.max(0, room.lockUntil - Date.now()),
    players: room.players.map((p) => ({
      id: p.id, name: p.name, color: p.color,
      deckCount: p.deck.length, pileCount: p.pile.length,
      top: p.pile.length ? p.pile[p.pile.length - 1] : null,
      out: p.out, connected: p.res.size > 0,
    })),
    event: room.event,
    winner: room.winner,
  };
}
function broadcast(room) {
  for (const p of room.players) {
    if (!p.res.size) continue;
    const msg = `data: ${JSON.stringify(view(room, p.id))}\n\n`;
    for (const r of p.res) r.write(msg);
  }
}

// ---------- game logic ----------
function ensureTurn(room) {
  const n = room.players.length;
  let i = room.turn;
  for (let k = 0; k < n; k++) {
    const p = room.players[i];
    if (!p.out && p.deck.length) { room.turn = i; return; }
    i = (i + 1) % n;
  }
}
function finish(room, w) {
  room.status = 'finished';
  room.winner = w ? { id: w.id, name: w.name } : null;
  clearTimeout(room.timer);
  setEvent(room, 'end', w ? `🏆 ${w.name} wins the game!` : 'Game over', w && w.id);
}
function checkState(room) {
  for (const p of room.players) {
    if (!p.out && !p.deck.length && !p.pile.length) p.out = true;
  }
  const alive = room.players.filter((p) => !p.out);
  if (alive.length <= 1) return finish(room, alive[0] || null);
  if (!alive.some((p) => p.deck.length)) {
    // nobody can flip any more: most cards wins
    return finish(room, alive.sort((a, b) => b.pile.length - a.pile.length)[0]);
  }
  ensureTurn(room);
}
function armTimer(room) {
  clearTimeout(room.timer);
  if (room.status !== 'playing') return;
  const cur = room.players[room.turn];
  const wait = Math.max(0, room.lockUntil - Date.now()) + (cur.res.size ? TURN_MS : 1200);
  room.timer = setTimeout(() => {
    if (room.status !== 'playing') return;
    const c = room.players[room.turn];
    if (doFlip(room, c, true)) armTimer(room);
    broadcast(room);
  }, wait);
}

function doStart(room, p) {
  if (room.players[0] !== p) return 'Only the host can start';
  if (room.status !== 'lobby') return 'Game already running';
  if (room.players.length < 2) return 'Need at least 2 players';
  const deck = newDeck();
  for (const q of room.players) { q.deck = []; q.pile = []; q.out = false; }
  deck.forEach((c, i) => room.players[i % room.players.length].deck.push(c));
  room.status = 'playing';
  room.turn = 0;
  room.lockUntil = 0;
  room.winner = null;
  setEvent(room, 'start', 'Game on! Ring the bell when exactly 5 of one fruit are showing.');
  armTimer(room);
  return null;
}

function doFlip(room, p, auto) {
  if (room.status !== 'playing') return 'Game is not running';
  if (Date.now() < room.lockUntil) return 'Wait a moment';
  if (room.players[room.turn] !== p) return 'Not your turn';
  if (!p.deck.length) return 'No cards left to flip';
  const c = p.deck.shift();
  p.pile.push(c);
  setEvent(room, 'flip', `${p.name} flips ${c.n} × ${c.f}${auto ? ' (auto)' : ''}`, p.id);
  room.turn = (room.turn + 1) % room.players.length;
  checkState(room);
  armTimer(room);
  return null;
}

function doBell(room, p) {
  if (room.status !== 'playing') return 'Game is not running';
  if (p.out) return 'You are out of the game';
  if (Date.now() < room.lockUntil) return 'Too late – someone already rang!';
  const tot = {};
  for (const q of room.players) {
    if (q.out || !q.pile.length) continue;
    const c = q.pile[q.pile.length - 1];
    tot[c.f] = (tot[c.f] || 0) + c.n;
  }
  if (Object.values(tot).includes(5)) {
    const won = [];
    for (const q of room.players) { won.push(...q.pile); q.pile = []; }
    shuffle(won);
    p.deck.push(...won);
    room.lockUntil = Date.now() + LOCK_OK;
    setEvent(room, 'bell-ok', `🔔 ${p.name} rang it right and won ${won.length} cards!`, p.id);
  } else {
    let paid = 0;
    for (const q of room.players) {
      if (q === p || q.out) continue;
      if (!p.deck.length) break;
      q.deck.push(p.deck.shift());
      paid++;
    }
    room.lockUntil = Date.now() + LOCK_BAD;
    setEvent(room, 'bell-bad', `❌ ${p.name} rang wrong and pays ${paid} card${paid === 1 ? '' : 's'}!`, p.id);
  }
  checkState(room);
  armTimer(room);
  return null;
}

function doReset(room, p) {
  if (room.players[0] !== p) return 'Only the host can do that';
  if (room.status !== 'finished') return 'Game not finished';
  room.players = room.players.filter((q) => q.res.size > 0);
  for (const q of room.players) { q.deck = []; q.pile = []; q.out = false; }
  room.status = 'lobby';
  room.winner = null;
  setEvent(room, 'reset', 'Back in the lobby.');
  return null;
}

function removeFromLobby(room, p) {
  if (room.status !== 'lobby') return;
  const i = room.players.indexOf(p);
  if (i < 0) return;
  room.players.splice(i, 1);
  if (!room.players.length) { rooms.delete(room.code); return; }
  broadcast(room);
}

// ---------- http ----------
const send = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 1e4) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(500); return res.end('index.html missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    const room = rooms.get((url.searchParams.get('code') || '').toUpperCase());
    const p = room && room.players.find((x) => x.token === url.searchParams.get('token'));
    if (!p) { res.writeHead(404); return res.end(); }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    p.res.add(res);
    room.touched = Date.now();
    req.on('close', () => {
      p.res.delete(res);
      room.touched = Date.now();
      broadcast(room);
      if (room.status === 'playing') armTimer(room);
      if (room.status === 'lobby') {
        setTimeout(() => { if (!p.res.size) removeFromLobby(room, p); }, 15000);
      }
    });
    broadcast(room);
    if (room.status === 'playing') armTimer(room);
    return;
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    const act = url.pathname.slice(5);
    const b = await readBody(req);

    if (act === 'create') {
      const room = makeRoom();
      const p = addPlayer(room, cleanName(b.name));
      return send(res, 200, { code: room.code, token: p.token });
    }

    const room = rooms.get(String(b.code || '').toUpperCase());
    if (!room) return send(res, 404, { error: 'Room not found' });

    if (act === 'join') {
      if (room.status !== 'lobby') return send(res, 400, { error: 'Game already started' });
      if (room.players.length >= MAX_PLAYERS) return send(res, 400, { error: 'Room is full' });
      const p = addPlayer(room, cleanName(b.name));
      room.touched = Date.now();
      broadcast(room);
      return send(res, 200, { code: room.code, token: p.token });
    }

    const p = room.players.find((x) => x.token === b.token);
    if (!p) return send(res, 403, { error: 'Not in this room' });

    let err = null;
    switch (act) {
      case 'start': err = doStart(room, p); break;
      case 'flip': err = doFlip(room, p, false); break;
      case 'bell': err = doBell(room, p); break;
      case 'reset': err = doReset(room, p); break;
      case 'leave': removeFromLobby(room, p); break;
      default: err = 'Unknown action';
    }
    room.touched = Date.now();
    if (err) return send(res, 400, { error: err });
    broadcast(room);
    return send(res, 200, { ok: true });
  }

  res.writeHead(404);
  res.end('Not found');
});

// keep SSE connections alive through proxies
setInterval(() => {
  for (const room of rooms.values())
    for (const p of room.players) for (const r of p.res) r.write(': ping\n\n');
}, 15000).unref();

// drop abandoned rooms
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const connected = room.players.some((p) => p.res.size);
    if (!connected && now - room.touched > 10 * 60 * 1000) {
      clearTimeout(room.timer);
      rooms.delete(code);
    }
  }
}, 60000).unref();

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => console.log(`Halli Galli running on http://localhost:${PORT}`));
}
module.exports = { server };
