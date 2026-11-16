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

// ---------- accounts & ranking ----------
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const START_ELO = 1000;
const TIERS = [
  { min: 1700, name: 'Master', icon: '🔥' },
  { min: 1500, name: 'Diamond', icon: '💎' },
  { min: 1300, name: 'Platinum', icon: '🔷' },
  { min: 1100, name: 'Gold', icon: '🟡' },
  { min: 900, name: 'Silver', icon: '⚪' },
  { min: 0, name: 'Bronze', icon: '🟤' },
];
const tierOf = (elo) => TIERS.find((t) => elo >= t.min);

// null-prototype maps so names like "__proto__" or "constructor" are safe usernames
const db = { users: Object.create(null), sessions: Object.create(null) };
try {
  const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  Object.assign(db.users, d.users || {});
  Object.assign(db.sessions, d.sessions || {});
} catch { /* first run: no data file yet */ }

function flushDb() {
  try {
    fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(db));
    fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
  } catch (e) { console.error('Could not save ranking data:', e.message); }
}
let saveTimer = null;
function saveDb() {
  if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; flushDb(); }, 400);
}

// leaderboard cache (only players with at least one rated game)
let lbCache = null;
function getLb() {
  if (!lbCache) {
    const arr = Object.entries(db.users)
      .filter(([, u]) => u.games > 0)
      .sort((a, b) => b[1].elo - a[1].elo || b[1].wins - a[1].wins || a[1].name.localeCompare(b[1].name))
      .map(([key, u], i) => ({ key, rank: i + 1, name: u.name, elo: u.elo, games: u.games, wins: u.wins, tier: tierOf(u.elo) }));
    lbCache = { arr, idx: new Map(arr.map((e) => [e.key, e])) };
  }
  return lbCache;
}
const publicRow = ({ key, ...rest }) => rest;

const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32);
function checkPw(u, pw) {
  const h = hashPw(pw, u.salt);
  const s = Buffer.from(u.hash, 'hex');
  return h.length === s.length && crypto.timingSafeEqual(h, s);
}
function newSession(key) {
  const t = crypto.randomBytes(24).toString('hex');
  db.sessions[t] = key;
  const mine = Object.keys(db.sessions).filter((k) => db.sessions[k] === key);
  while (mine.length > 5) delete db.sessions[mine.shift()]; // keep the 5 newest logins
  saveDb();
  return t;
}
function userFor(auth) {
  const key = db.sessions[String(auth || '')];
  return key && db.users[key] ? { key, u: db.users[key] } : null;
}

// brute-force protection for login
const fails = new Map();
function limited(k) {
  const f = fails.get(k);
  if (!f) return false;
  if (Date.now() - f.t >= 10 * 60 * 1000) { fails.delete(k); return false; }
  return f.n >= 8;
}
function failed(k) {
  const f = fails.get(k) || { n: 0, t: 0 };
  f.n++; f.t = Date.now();
  fails.set(k, f);
}

// Multiplayer Elo: every pair of signed-in players is a head-to-head result.
function applyRatings(room, w) {
  const alive = room.players.filter((p) => !p.out)
    .sort((a, b) => (b === w) - (a === w) || (b.deck.length + b.pile.length) - (a.deck.length + a.pile.length));
  const gone = room.players.filter((p) => p.out).sort((a, b) => b.outSeq - a.outSeq); // out later = placed higher
  const order = [...alive, ...gone];
  room.results = order.map((p, i) => ({ id: p.id, name: p.name, place: i + 1, delta: null, elo: null }));
  if (!room.ranked) return; // casual rooms never change ratings
  const reg = order.filter((p) => p.acct && db.users[p.acct]);
  if (reg.length < 2) return;
  const before = reg.map((p) => db.users[p.acct].elo);
  const n = reg.length;
  reg.forEach((p, i) => {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      sum += (i < j ? 1 : 0) - 1 / (1 + Math.pow(10, (before[j] - before[i]) / 400));
    }
    const u = db.users[p.acct];
    const K = u.games < 10 ? 48 : 32; // new players move faster
    const next = Math.max(0, Math.round(before[i] + (K * sum) / (n - 1)));
    const r = room.results.find((x) => x.id === p.id);
    r.delta = next - before[i];
    r.elo = next;
    u.elo = next;
    u.games++;
    if (i === 0) u.wins++;
  });
  lbCache = null;
  saveDb();
}

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
    results: null, outCount: 0, ranked: false,
  };
  rooms.set(room.code, room);
  return room;
}
function addPlayer(room, name, acct) {
  let nm = name, i = 2;
  if (!acct) while (room.players.some((p) => p.name === nm)) nm = `${name} ${i++}`;
  const used = new Set(room.players.map((p) => p.color));
  const p = {
    id: uid().slice(0, 8), token: uid(), name: nm, acct: acct || null,
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
    players: room.players.map((p) => {
      const u = p.acct && db.users[p.acct];
      const e = u && getLb().idx.get(p.acct);
      return {
        id: p.id, name: p.name, color: p.color,
        deckCount: p.deck.length, pileCount: p.pile.length,
        top: p.pile.length ? p.pile[p.pile.length - 1] : null,
        out: p.out, connected: p.res.size > 0,
        acct: !!u, elo: u ? u.elo : null, tier: u ? tierOf(u.elo) : null, rank: e ? e.rank : null,
      };
    }),
    ranked: room.ranked,
    results: room.status === 'finished' ? room.results : null,
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
  applyRatings(room, w);
}
function checkState(room) {
  for (const p of room.players) {
    if (!p.out && !p.deck.length && !p.pile.length) { p.out = true; p.outSeq = ++room.outCount; }
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
  room.results = null;
  room.outCount = 0;
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

function doRanked(room, p, on) {
  if (room.players[0] !== p) return 'Only the host can change the mode';
  if (room.status !== 'lobby') return 'Mode can only change in the lobby';
  if (on && room.players.some((q) => !q.acct)) return 'Guests are in the room – ranked needs everyone signed in';
  room.ranked = !!on;
  setEvent(room, 'mode', on ? 'Ranked mode on' : 'Casual mode');
  return null;
}

function doReset(room, p) {
  if (room.players[0] !== p) return 'Only the host can do that';
  if (room.status !== 'finished') return 'Game not finished';
  room.players = room.players.filter((q) => q.res.size > 0);
  for (const q of room.players) { q.deck = []; q.pile = []; q.out = false; }
  room.status = 'lobby';
  room.winner = null;
  room.results = null;
  room.outCount = 0;
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

    // ----- accounts & leaderboard -----
    if (act === 'register' || act === 'login') {
      const uname = String(b.username || '').trim();
      const key = uname.toLowerCase();
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const lk = ip + '|' + key;
      if (limited(lk)) return send(res, 429, { error: 'Too many attempts – try again in a few minutes' });
      const pw = String(b.password || '');
      if (act === 'register') {
        if (!/^[A-Za-z0-9_-]{3,14}$/.test(uname)) return send(res, 400, { error: 'Username: 3–14 letters, numbers, _ or -' });
        if (pw.length < 6 || pw.length > 64) return send(res, 400, { error: 'Password must be 6–64 characters' });
        if (db.users[key]) return send(res, 400, { error: 'Username already taken' });
        const salt = crypto.randomBytes(16).toString('hex');
        db.users[key] = { name: uname, salt, hash: hashPw(pw, salt).toString('hex'), elo: START_ELO, games: 0, wins: 0, created: Date.now() };
        return send(res, 200, { token: newSession(key), name: uname });
      }
      const u = db.users[key];
      if (!u || !checkPw(u, pw)) { failed(lk); return send(res, 400, { error: 'Wrong username or password' }); }
      fails.delete(lk);
      return send(res, 200, { token: newSession(key), name: u.name });
    }
    if (act === 'logout') {
      delete db.sessions[String(b.auth || '')];
      saveDb();
      return send(res, 200, { ok: true });
    }
    if (act === 'leaderboard') {
      const { arr, idx } = getLb();
      const s = userFor(b.auth);
      let me = null;
      if (s) {
        const e = idx.get(s.key);
        me = { name: s.u.name, elo: s.u.elo, tier: tierOf(s.u.elo), games: s.u.games, wins: s.u.wins, rank: e ? e.rank : null };
      }
      return send(res, 200, { top: arr.slice(0, 50).map(publicRow), total: arr.length, me });
    }

    // who is joining: a signed-in account (ranked) or a guest (unranked)
    const identify = () => {
      if (b.auth) {
        const s = userFor(b.auth);
        if (!s) return { error: 'Session expired – please log in again', expired: true };
        return { name: s.u.name, acct: s.key };
      }
      const name = cleanName(b.name);
      if (db.users[name.toLowerCase()]) return { error: 'That name belongs to a ranked account – log in or pick another name' };
      return { name, acct: null };
    };

    if (act === 'create') {
      const id = identify();
      if (id.error) return send(res, 400, { error: id.error, expired: id.expired });
      const room = makeRoom();
      const p = addPlayer(room, id.name, id.acct);
      return send(res, 200, { code: room.code, token: p.token });
    }

    const room = rooms.get(String(b.code || '').toUpperCase());
    if (!room) return send(res, 404, { error: 'Room not found' });

    if (act === 'join') {
      const id = identify();
      if (id.error) return send(res, 400, { error: id.error, expired: id.expired });
      if (id.acct) { // signed-in players can always get back into their own seat
        const ex = room.players.find((q) => q.acct === id.acct);
        if (ex) return send(res, 200, { code: room.code, token: ex.token });
      }
      if (room.status !== 'lobby') return send(res, 400, { error: 'Game already started' });
      if (room.ranked && !id.acct) return send(res, 400, { error: 'This is a ranked room – log in to join' });
      if (room.players.length >= MAX_PLAYERS) return send(res, 400, { error: 'Room is full' });
      const p = addPlayer(room, id.name, id.acct);
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
      case 'ranked': err = doRanked(room, p, b.value); break;
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
  for (const [k, f] of fails) if (now - f.t > 10 * 60 * 1000) fails.delete(k);
  for (const [code, room] of rooms) {
    const connected = room.players.some((p) => p.res.size);
    if (!connected && now - room.touched > 10 * 60 * 1000) {
      clearTimeout(room.timer);
      rooms.delete(code);
    }
  }
}, 60000).unref();

if (require.main === module) {
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flushDb(); process.exit(0); });
  server.listen(PORT, '0.0.0.0', () => console.log(`Halli Galli running on http://localhost:${PORT}`));
}
module.exports = { server };
