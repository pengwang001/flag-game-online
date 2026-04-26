const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;

// Load country data from data.js
let DATA;
const raw = fs.readFileSync(path.join(__dirname, 'data.js'), 'utf8');
eval(raw.replace('const DATA', 'DATA'));

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// Game state
const COLORS = ['#3b82f6','#ef4444','#22c55e','#f59e0b','#a855f7','#ec4899','#14b8a6','#f97316'];
let players = [];
let state = 'lobby';
let continent = null;
let countries = [];
let questionIdx = 0;
let currentQuestion = null;
let showFlags = true;
let hostWs = null;
let answered = new Set();
let roundsPerGame = 8;
// Progressive clue state
let clueIdx = 0;
let clueTimer = null;
const MAX_CLUES = 5;
const CLUE_INTERVAL = 5000; // 5s between clues

function broadcast(msg) {
  const s = JSON.stringify(msg);
  if (hostWs?.readyState === 1) hostWs.send(s);
  players.forEach(p => { if (p.ws?.readyState === 1) p.ws.send(s); });
}
function sendTo(ws, msg) { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); }

function lobbyState() {
  const continents = Object.entries(DATA).map(([name, arr]) => ({ name, count: arr.length }));
  broadcast({ type: 'lobby', players: players.map(p => ({ id: p.id, name: p.name, color: p.color })), showFlags, continents });
}

function sendQuestion() {
  if (questionIdx >= countries.length) { endGame(); return; }
  clearInterval(clueTimer);
  const q = countries[questionIdx];
  const pool = DATA[continent].filter(c => c.name !== q.name);
  const opts = shuffle([q, ...shuffle(pool).slice(0, 3)]);
  const clues = shuffle([...q.clues]);
  currentQuestion = { ...q, clues, options: opts.map(o => o.name) };
  answered = new Set();
  clueIdx = 0;

  const base = {
    type: 'question', round: questionIdx + 1, total: countries.length,
    flag: showFlags ? q.flag : '❓', img: q.img || null,
    clues: [clues[0]], clueNum: 1, maxClues: Math.min(MAX_CLUES, clues.length),
    options: currentQuestion.options,
    points: MAX_CLUES,
  };

  sendTo(hostWs, { ...base, players: players.map(p => ({ id: p.id, name: p.name, score: p.score, color: p.color })) });
  players.forEach(p => sendTo(p.ws, base));

  // Progressive clue reveal
  clueIdx = 1;
  clueTimer = setInterval(() => {
    if (clueIdx >= Math.min(MAX_CLUES, clues.length) || answered.size >= players.length) {
      clearInterval(clueTimer); return;
    }
    const reveal = { type: 'clue', clue: clues[clueIdx], clueNum: clueIdx + 1, points: MAX_CLUES - clueIdx };
    if (hostWs?.readyState === 1) hostWs.send(JSON.stringify(reveal));
    players.forEach(p => { if (p.ws?.readyState === 1) p.ws.send(JSON.stringify(reveal)); });
    clueIdx++;
  }, CLUE_INTERVAL);
}

function endGame() {
  state = 'result';
  clearInterval(clueTimer);
  const sorted = [...players].sort((a, b) => b.score - a.score);
  broadcast({ type: 'gameover', players: sorted.map(p => ({ name: p.name, score: p.score, color: p.color })) });
}

// MIME types
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };

const server = http.createServer((req, res) => {
  let file;
  if (req.url === '/' || req.url === '/host') file = 'host.html';
  else if (req.url === '/play') file = 'player.html';
  else if (req.url === '/data.js') file = 'data.js';
  else if (req.url === '/qr') {
    const playUrl = `${req.headers['x-forwarded-proto']||'http'}://${req.headers.host}/play`;
    QRCode.toDataURL(playUrl, {width:300,margin:1}, (err,url) => {
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({qr:url,url:playUrl}));
    }); return;
  }
  else { res.writeHead(404); res.end('Not found'); return; }
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
  res.end(fs.readFileSync(path.join(__dirname, file)));
});

const wss = new WebSocketServer({ server });
let nextId = 1;

wss.on('connection', (ws) => {
  let playerId = null, isHost = false;

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);

    if (msg.type === 'host') { isHost = true; hostWs = ws; lobbyState(); }

    if (msg.type === 'join') {
      if (players.length >= 8) { sendTo(ws, { type: 'error', msg: 'Game full (8 max)' }); return; }
      if (state === 'playing') { sendTo(ws, { type: 'error', msg: 'Game in progress' }); return; }
      playerId = nextId++;
      const p = { id: playerId, name: msg.name || `Player ${playerId}`, ws, score: 0, color: COLORS[(players.length) % COLORS.length] };
      players.push(p);
      sendTo(ws, { type: 'joined', id: playerId, color: p.color });
      lobbyState();
    }

    if (msg.type === 'start' && isHost) {
      if (!players.length) { sendTo(ws, { type: 'error', msg: 'Need at least 1 player' }); return; }
      continent = msg.continent;
      showFlags = msg.showFlags !== false;
      roundsPerGame = Math.min(msg.rounds || 8, DATA[continent].length);
      countries = shuffle([...DATA[continent]]).slice(0, roundsPerGame);
      questionIdx = 0;
      players.forEach(p => p.score = 0);
      state = 'playing';
      sendQuestion();
    }

    if (msg.type === 'answer' && state === 'playing' && playerId) {
      if (answered.has(playerId)) return;
      answered.add(playerId);
      const correct = msg.answer === currentQuestion.name;
      const p = players.find(x => x.id === playerId);
      if (correct && p) p.score += Math.max(1, MAX_CLUES - clueIdx + 1);

      sendTo(hostWs, {
        type: 'player_answered', playerId, name: p?.name, answer: msg.answer, correct,
        answeredCount: answered.size, totalPlayers: players.length,
        players: players.map(p => ({ id: p.id, name: p.name, score: p.score, color: p.color })),
      });
      sendTo(ws, { type: 'answer_result', correct, correctAnswer: currentQuestion.name });

      if (answered.size >= players.length) {
        clearInterval(clueTimer);
        sendTo(hostWs, {
          type: 'all_answered', correctAnswer: currentQuestion.name,
          players: players.map(p => ({ id: p.id, name: p.name, score: p.score, color: p.color })),
        });
      }
    }

    if (msg.type === 'next' && isHost && state === 'playing') { questionIdx++; sendQuestion(); }
    if (msg.type === 'back_to_lobby' && isHost) { state = 'lobby'; players.forEach(p => p.score = 0); lobbyState(); }
  });

  ws.on('close', () => {
    if (isHost) hostWs = null;
    if (playerId) { players = players.filter(p => p.id !== playerId); if (state === 'lobby') lobbyState(); }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌍 Flag Game Online — listening on port ${PORT}`);
});
