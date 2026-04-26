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

let ZH_CLUES = {};
eval(fs.readFileSync(path.join(__dirname, 'zh-clues.js'), 'utf8').replace('const ZH_CLUES', 'ZH_CLUES'));

let CAPITALS;
eval(fs.readFileSync(path.join(__dirname, 'capitals.js'), 'utf8').replace('const CAPITALS', 'CAPITALS'));

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
let autoAdvanceTimer = null;
let roundTimer = null;
let timerSec = 0;
let roundStartTime = 0;
const MAX_CLUES = 5;
const CLUE_INTERVAL = 5000; // 5s between clues

function activePlayers() { return players.filter(p => p.ws && p.ws.readyState === 1); }
function activeCount() { return activePlayers().length; }
function mapPoints() {
  if (!timerSec) return 1;
  const elapsed = (Date.now() - roundStartTime) / 1000;
  return Math.max(1, MAX_CLUES - Math.floor((elapsed / timerSec) * (MAX_CLUES - 1)));
}

function broadcast(msg) {  const s = JSON.stringify(msg);
  if (hostWs?.readyState === 1) hostWs.send(s);
  players.forEach(p => { if (p.ws?.readyState === 1) p.ws.send(s); });
}
function sendTo(ws, msg) { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); }

function lobbyState() {
  const continents = Object.entries(DATA).map(([name, arr]) => ({ name, count: arr.length }));
  const mapContinents = Object.entries(MAP_CONTINENTS).map(([name, arr]) => ({ name, count: arr.length }));
  const capitalContinents = Object.entries(CAPITALS).map(([name, arr]) => ({ name, count: arr.length }));
  broadcast({ type: 'lobby', players: players.map(p => ({ id: p.id, name: p.name, color: p.color })), showFlags, continents, mapContinents, capitalContinents, usStatesCount: US_STATES.length, caProvincesCount: CA_PROVINCES.length });
}

let soloScore = 0;
let gameType = 'trivia'; // trivia | map | local

// Map game continent definitions (TopoJSON names)
const MAP_CONTINENTS = {
  "Europe":["Albania","Austria","Belarus","Belgium","Bosnia and Herz.","Bulgaria","Croatia","Czechia","Denmark","Estonia","Finland","France","Germany","Greece","Hungary","Iceland","Ireland","Italy","Kosovo","Latvia","Lithuania","Luxembourg","Macedonia","Moldova","Montenegro","Netherlands","Norway","Poland","Portugal","Romania","Russia","Serbia","Slovakia","Slovenia","Spain","Sweden","Switzerland","Ukraine","United Kingdom"],
  "Asia":["Afghanistan","Armenia","Azerbaijan","Bangladesh","Bhutan","Brunei","Cambodia","China","Cyprus","Georgia","India","Indonesia","Iran","Iraq","Israel","Japan","Jordan","Kazakhstan","Kuwait","Kyrgyzstan","Laos","Lebanon","Malaysia","Mongolia","Myanmar","Nepal","North Korea","Oman","Pakistan","Philippines","Qatar","Saudi Arabia","South Korea","Sri Lanka","Syria","Taiwan","Tajikistan","Thailand","Timor-Leste","Turkey","Turkmenistan","United Arab Emirates","Uzbekistan","Vietnam","Yemen"],
  "North America":["Bahamas","Belize","Canada","Costa Rica","Cuba","Dominican Rep.","El Salvador","Guatemala","Haiti","Honduras","Jamaica","Mexico","Nicaragua","Panama","Puerto Rico","Trinidad and Tobago","United States of America"],
  "South America":["Argentina","Bolivia","Brazil","Chile","Colombia","Ecuador","Guyana","Paraguay","Peru","Suriname","Uruguay","Venezuela"]
};
const MAP_DISPLAY={"United States of America":"United States","Dominican Rep.":"Dominican Republic","Czechia":"Czech Republic","Bosnia and Herz.":"Bosnia","Macedonia":"North Macedonia"};

const US_STATES=["Alabama","Alaska","Arizona","Arkansas","California","Colorado","Connecticut","Delaware","Florida","Georgia","Hawaii","Idaho","Illinois","Indiana","Iowa","Kansas","Kentucky","Louisiana","Maine","Maryland","Massachusetts","Michigan","Minnesota","Mississippi","Missouri","Montana","Nebraska","Nevada","New Hampshire","New Jersey","New Mexico","New York","North Carolina","North Dakota","Ohio","Oklahoma","Oregon","Pennsylvania","Rhode Island","South Carolina","South Dakota","Tennessee","Texas","Utah","Vermont","Virginia","Washington","West Virginia","Wisconsin","Wyoming"];

const CA_PROVINCES=["Alberta","British Columbia","Manitoba","New Brunswick","Newfoundland and Labrador","Northwest Territories","Nova Scotia","Nunavut","Ontario","Prince Edward Island","Quebec","Saskatchewan","Yukon Territory"];

// Local game data
const LOCAL_CITIES = [
  {name:"Issaquah",clues:["This city's name comes from a Native American word meaning 'the sound of birds'",{img:"https://images.unsplash.com/photo-1501785888041-af3ef285b470?w=400&h=250&fit=crop",caption:"Tiger Mountain trails are a local favorite"},"Home to Costco's headquarters","Salmon Days festival celebrates the return of salmon every October","Located at the base of the Cascades foothills along I-90","Gilman Village is a charming shopping area in converted farm buildings","Triple XXX Rootbeer is a legendary drive-in restaurant here"]},
  {name:"Issaquah",clues:["Poo Poo Point is a famous paragliding launch site here","Lake Sammamish State Park is at the north end of this city",{img:"https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=400&h=250&fit=crop",caption:"Hikers flock to this city's mountain trails year-round"},"Boehm's Chocolates has been making Swiss chocolates here since 1956","Cougar Mountain Regional Wildland Park borders this city","The Issaquah Alps include Tiger, Squak, and Cougar mountains","Located about 15 miles east of Seattle via I-90"]},
  {name:"Bellevue",clues:["Its name means 'beautiful view' in French","Downtown has a skyline that rivals many major cities",{img:"https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?w=400&h=250&fit=crop",caption:"A growing skyline with luxury high-rises"},"Home to T-Mobile's headquarters","The city's population has more than doubled since 2000","Located between Lake Washington and Lake Sammamish","The Spring District is a massive new mixed-use development"]},
  {name:"Bellevue",clues:["The Downtown Park has a circular 240-foot wide waterfall","This city has one of the highest-rated school districts in WA","Crossroads Mall has a famous international food court",{img:"https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=400&h=250&fit=crop",caption:"The diverse food scene ranges from Din Tai Fung to local gems"},"Microsoft and Meta have major offices here","Main Street is lined with restaurants and boutiques in Old Bellevue","The annual Snowflake Lane holiday parade draws huge crowds"]},
  {name:"Sammamish",clues:["Named after the lake on its western border","One of the wealthiest cities in Washington state","Beaver Lake Park is a popular spot for fishing and picnics",{img:"https://images.unsplash.com/photo-1500382017468-9049fed747ef?w=400&h=250&fit=crop",caption:"Known for its spacious suburban lots and green spaces"},"The Sammamish Plateau was mostly farmland until the 1990s","Incorporated as a city in 1999, one of WA's newest cities","This city has no real downtown or commercial center"]},
  {name:"Sammamish",clues:["Soaring Eagle Regional Park has 600 acres of forest trails","Big Rock Park has a massive glacial erratic boulder",{img:"https://images.unsplash.com/photo-1523712999610-f77fbcfc3843?w=400&h=250&fit=crop",caption:"Forested trails and nature preserves define this quiet city"},"Klahanie is one of the largest master-planned communities here","Evans Creek Preserve is a 168-acre nature area","Many tech workers live here and commute to Redmond or Bellevue","The Sammamish Commons is the closest thing to a town center"]},
  {name:"Seattle",clues:["The Space Needle was built for the 1962 World's Fair",{img:"https://images.unsplash.com/photo-1502175353174-a7a70e73b362?w=400&h=250&fit=crop",caption:"This iconic tower defines the city skyline"},"Pike Place Market is one of the oldest farmers' markets in the US","The first Starbucks opened here in 1971","Known as the Emerald City for its lush greenery","Home to Amazon, Boeing, and Starbucks headquarters","Kurt Cobain and Jimi Hendrix both called this city home"]},
  {name:"Seattle",clues:["The Fremont Troll sculpture lives under the Aurora Bridge","Capitol Hill is the heart of the city's nightlife and arts scene",{img:"https://images.unsplash.com/photo-1470004914212-05527e49370b?w=400&h=250&fit=crop",caption:"Ferries crisscross the waters around this city"},"It rains less annually than New York City (the reputation is a myth!)","The Underground Tour reveals the buried original city streets","Bruce Lee is buried in this city's Capitol Hill neighborhood","The city has more dogs than children"]},
];
const LOCAL_OPTIONS = ["Issaquah","Bellevue","Sammamish","Seattle"];

function sendQuestion() {
  if (questionIdx >= countries.length) { endGame(); return; }
  clearInterval(clueTimer);
  clearTimeout(autoAdvanceTimer);
  clearInterval(roundTimer);
  const q = countries[questionIdx];
  answered = new Set();
  clueIdx = 0;
  let base;

  if (gameType === 'trivia') {
    const pool = DATA[continent].filter(c => c.name !== q.name);
    const opts = shuffle([q, ...shuffle(pool).slice(0, 3)]);
    const origClues = q.clues;
    const zhArr = ZH_CLUES[q.name] || [];
    const indices = origClues.map((_,i) => i);
    shuffle(indices);
    const clues = indices.map(i => origClues[i]);
    const zhClues = indices.map(i => zhArr[i] || origClues[i]);
    currentQuestion = { ...q, clues, zhClues, options: opts.map(o => o.name) };
    base = {
      type: 'question', gameType: 'trivia', round: questionIdx + 1, total: countries.length,
      flag: showFlags ? q.flag : '❓', img: q.img || null,
      clues: [clues[0]], zhClues: [zhClues[0]],
      clueNum: 1, maxClues: Math.min(MAX_CLUES, clues.length),
      options: currentQuestion.options, points: MAX_CLUES, timer: timerSec,
    };
  } else if (gameType === 'map') {
    const pool = MAP_CONTINENTS[continent].filter(n => n !== q.name);
    const opts = shuffle([q.name, ...shuffle(pool).slice(0, 3)]);
    currentQuestion = { name: q.name, options: opts };
    base = {
      type: 'question', gameType: 'map', round: questionIdx + 1, total: countries.length,
      topoName: q.name, continent,
      options: currentQuestion.options, points: timerSec ? MAX_CLUES : 1, timer: timerSec,
    };
  } else if (gameType === 'local') {
    const clues = shuffle([...q.clues]);
    currentQuestion = { name: q.name, clues, options: LOCAL_OPTIONS };
    base = {
      type: 'question', gameType: 'local', round: questionIdx + 1, total: countries.length,
      clues: [clues[0]], clueNum: 1, maxClues: Math.min(MAX_CLUES, clues.length),
      options: LOCAL_OPTIONS, points: MAX_CLUES, timer: timerSec,
    };
  } else if (gameType === 'capital') {
    const pool = CAPITALS[continent].filter(c => c.name !== q.name);
    const opts = shuffle([q.capital, ...shuffle(pool).map(c => c.capital).slice(0, 3)]);
    currentQuestion = { name: q.capital, options: opts };
    base = {
      type: 'question', gameType: 'capital', round: questionIdx + 1, total: countries.length,
      country: q.name, flag: q.flag,
      options: currentQuestion.options, points: timerSec ? MAX_CLUES : 1, timer: timerSec,
    };
  } else if (gameType === 'flagquiz') {
    const pool = CAPITALS[continent].filter(c => c.name !== q.name);
    const opts = shuffle([q.flag, ...shuffle(pool).map(c => c.flag).slice(0, 3)]);
    currentQuestion = { name: q.flag, options: opts };
    base = {
      type: 'question', gameType: 'flagquiz', round: questionIdx + 1, total: countries.length,
      country: q.name,
      options: currentQuestion.options, points: timerSec ? MAX_CLUES : 1, timer: timerSec,
    };
  } else if (gameType === 'usmap') {
    const pool = US_STATES.filter(n => n !== q.name);
    const opts = shuffle([q.name, ...shuffle(pool).slice(0, 3)]);
    currentQuestion = { name: q.name, options: opts };
    base = {
      type: 'question', gameType: 'usmap', round: questionIdx + 1, total: countries.length,
      stateName: q.name,
      options: currentQuestion.options, points: timerSec ? MAX_CLUES : 1, timer: timerSec,
    };
  } else if (gameType === 'camap') {
    const pool = CA_PROVINCES.filter(n => n !== q.name);
    const opts = shuffle([q.name, ...shuffle(pool).slice(0, 3)]);
    currentQuestion = { name: q.name, options: opts };
    base = {
      type: 'question', gameType: 'camap', round: questionIdx + 1, total: countries.length,
      stateName: q.name,
      options: currentQuestion.options, points: timerSec ? MAX_CLUES : 1, timer: timerSec,
    };
  }

  roundStartTime = Date.now();
  sendTo(hostWs, { ...base, solo: players.length === 0, players: players.map(p => ({ id: p.id, name: p.name, score: p.score, color: p.color })) });
  players.forEach(p => sendTo(p.ws, base));

  // Progressive clue reveal (trivia + local only)
  if (gameType !== 'map' && gameType !== 'capital' && gameType !== 'flagquiz' && gameType !== 'usmap' && gameType !== 'camap') {
    const clues = currentQuestion.clues;
    const zhClues = currentQuestion.zhClues;
    clueIdx = 1;
    clueTimer = setInterval(() => {
      if (clueIdx >= Math.min(MAX_CLUES, clues.length) || (activeCount() > 0 && answered.size >= activeCount())) {
        clearInterval(clueTimer); return;
      }
      const reveal = { type: 'clue', clue: clues[clueIdx], clueNum: clueIdx + 1, points: MAX_CLUES - clueIdx };
      if (zhClues) reveal.zhClue = zhClues[clueIdx];
      if (hostWs?.readyState === 1) hostWs.send(JSON.stringify(reveal));
      players.forEach(p => { if (p.ws?.readyState === 1) p.ws.send(JSON.stringify(reveal)); });
      clueIdx++;
    }, CLUE_INTERVAL);
  } else {
    clueIdx = 0;
  }

  // Round timer countdown
  if (timerSec > 0) {
    let timeLeft = timerSec;
    roundTimer = setInterval(() => {
      timeLeft -= 1;
      if (answered.size >= activeCount()) { clearInterval(roundTimer); return; }
      broadcast({ type: 'timer_tick', left: timeLeft, total: timerSec });
      if (timeLeft <= 0) {
        clearInterval(roundTimer);
        clearInterval(clueTimer);
        // Timeout: treat unanswered players as wrong, then auto-advance
        broadcast({ type: 'timeout', correctAnswer: currentQuestion.name,
          players: players.map(p => ({ id: p.id, name: p.name, score: p.score, color: p.color })) });
        autoAdvanceTimer = setTimeout(() => { questionIdx++; sendQuestion(); }, 3000);
      }
    }, 1000);
  }
}

// Leaderboard (top 20, persists in memory)
let leaderboard = [];
function addToLeaderboard(name, score, continent) {
  leaderboard.push({ name, score, continent, date: new Date().toISOString().slice(0,10) });
  leaderboard.sort((a,b) => b.score - a.score);
  leaderboard = leaderboard.slice(0, 20);
}

function endGame() {
  state = 'result';
  clearInterval(clueTimer);
  const sorted = [...players].sort((a, b) => b.score - a.score);
  // Add all players to leaderboard
  sorted.forEach(p => addToLeaderboard(p.name, p.score, continent));
  if (players.length === 0 && soloScore > 0) addToLeaderboard('Host', soloScore, continent);
  broadcast({ type: 'gameover', players: sorted.map(p => ({ name: p.name, score: p.score, color: p.color })), leaderboard, soloScore });
}

// MIME types
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };

const server = http.createServer((req, res) => {
  let file;
  if (req.url === '/' || req.url === '/host') file = 'host.html';
  else if (req.url === '/play') file = 'player.html';
  else if (req.url === '/data.js') file = 'data.js';
  else if (req.url === '/zh-clues.js') file = 'zh-clues.js';
  else if (req.url === '/countries-110m.json') { file = 'countries-110m.json'; }
  else if (req.url === '/states-10m.json') { file = 'states-10m.json'; }
  else if (req.url === '/canada.json') { file = 'canada.json'; }
  else if (req.url === '/gamebackground.png') { file = 'gamebackground.png'; }
  else if (req.url === '/map') file = 'map.html';
  else if (req.url === '/local') file = 'local.html';
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

    if (msg.type === 'host') {
      isHost = true; hostWs = ws;
      // If game was in progress, reset to lobby and clean stale players
      if (state === 'playing' || state === 'result') {
        clearInterval(clueTimer); clearTimeout(autoAdvanceTimer); clearInterval(roundTimer);
        state = 'lobby';
        // Remove players with dead connections
        players = players.filter(p => p.ws && p.ws.readyState === 1);
        players.forEach(p => p.score = 0);
      }
      lobbyState();
    }

    if (msg.type === 'join') {
      const name = msg.name || `Player ${nextId}`;
      // Allow rejoin by name if game is in progress
      if (state === 'playing') {
        const existing = players.find(p => p.name === name);
        if (existing) {
          // Reconnect to existing slot
          existing.ws = ws;
          playerId = existing.id;
          sendTo(ws, { type: 'joined', id: playerId, color: existing.color, rejoined: true });
          // Send current question so they can catch up
          if (currentQuestion) {
            sendTo(ws, { type: 'question', gameType, round: questionIdx + 1, total: countries.length,
              options: currentQuestion.options, points: Math.max(1, MAX_CLUES - clueIdx + 1), timer: timerSec,
              flag: currentQuestion.flag, img: currentQuestion.img, topoName: currentQuestion.topoName, continent,
              clues: currentQuestion.clues?.slice(0, clueIdx + 1),
            });
          }
          return;
        }
        // New player during game — allow them to join for next round
      }
      if (players.length >= 8) { sendTo(ws, { type: 'error', msg: 'Game full (8 max)' }); return; }
      playerId = nextId++;
      const p = { id: playerId, name, ws, score: 0, color: COLORS[(players.length) % COLORS.length] };
      players.push(p);
      sendTo(ws, { type: 'joined', id: playerId, color: p.color });
      if (state === 'lobby') lobbyState();
    }

    if (msg.type === 'start' && isHost) {
      gameType = msg.gameType || 'trivia';
      continent = msg.continent;
      showFlags = msg.showFlags !== false;
      timerSec = msg.timer || 0;

      if (gameType === 'trivia') {
        roundsPerGame = Math.min(msg.rounds || 8, DATA[continent].length);
        countries = shuffle([...DATA[continent]]).slice(0, roundsPerGame);
      } else if (gameType === 'map') {
        const pool = MAP_CONTINENTS[continent] || [];
        roundsPerGame = Math.min(msg.rounds || 15, pool.length);
        countries = shuffle([...pool]).slice(0, roundsPerGame).map(n => ({ name: n, topoName: n, continent }));
      } else if (gameType === 'local') {
        roundsPerGame = Math.min(msg.rounds || 12, LOCAL_CITIES.length);
        countries = shuffle([...LOCAL_CITIES]).slice(0, roundsPerGame);
      } else if (gameType === 'capital') {
        const pool = CAPITALS[continent] || [];
        roundsPerGame = Math.min(msg.rounds || 15, pool.length);
        countries = shuffle([...pool]).slice(0, roundsPerGame);
      } else if (gameType === 'flagquiz') {
        const pool = CAPITALS[continent] || [];
        roundsPerGame = Math.min(msg.rounds || 15, pool.length);
        countries = shuffle([...pool]).slice(0, roundsPerGame);
      } else if (gameType === 'usmap') {
        roundsPerGame = Math.min(msg.rounds || 20, US_STATES.length);
        countries = shuffle([...US_STATES]).slice(0, roundsPerGame).map(n => ({ name: n }));
      } else if (gameType === 'camap') {
        roundsPerGame = Math.min(msg.rounds || 13, CA_PROVINCES.length);
        countries = shuffle([...CA_PROVINCES]).slice(0, roundsPerGame).map(n => ({ name: n }));
      }
      questionIdx = 0;
      players.forEach(p => p.score = 0);
      soloScore = 0;
      state = 'playing';
      sendQuestion();
    }

    // Solo mode: host answers directly
    if (msg.type === 'host_answer' && isHost && state === 'playing' && players.length === 0) {
      clearInterval(clueTimer);
      clearInterval(roundTimer);
      const correct = msg.answer === currentQuestion.name;
      const noClueTypes = new Set(['map','capital','flagquiz','usmap','camap']);
      const pts = correct ? (noClueTypes.has(gameType) ? mapPoints() : Math.max(1, MAX_CLUES - clueIdx + 1)) : 0;
      soloScore += pts;
      sendTo(hostWs, { type: 'solo_result', correct, correctAnswer: currentQuestion.name, pts, totalScore: soloScore });
      autoAdvanceTimer = setTimeout(() => { questionIdx++; sendQuestion(); }, 3000);
    }

    if (msg.type === 'answer' && state === 'playing' && playerId) {      if (answered.has(playerId)) return;
      answered.add(playerId);
      const correct = msg.answer === currentQuestion.name;
      const p = players.find(x => x.id === playerId);
      if (correct && p) { const nc=new Set(['map','capital','flagquiz','usmap','camap']); p.score += nc.has(gameType) ? mapPoints() : Math.max(1, MAX_CLUES - clueIdx + 1); }

      sendTo(hostWs, {
        type: 'player_answered', playerId, name: p?.name, answer: msg.answer, correct,
        answeredCount: answered.size, totalPlayers: players.length,
        players: players.map(p => ({ id: p.id, name: p.name, score: p.score, color: p.color })),
      });
      sendTo(ws, { type: 'answer_result', correct, correctAnswer: currentQuestion.name });

      if (answered.size >= activeCount()) {
        clearInterval(clueTimer);
        clearInterval(roundTimer);
        sendTo(hostWs, {
          type: 'all_answered', correctAnswer: currentQuestion.name,
          players: players.map(p => ({ id: p.id, name: p.name, score: p.score, color: p.color })),
          autoAdvance: 3,
        });
        players.forEach(p => sendTo(p.ws, { type: 'all_answered', correctAnswer: currentQuestion.name, autoAdvance: 3 }));
        autoAdvanceTimer = setTimeout(() => { questionIdx++; sendQuestion(); }, 3000);
      }
    }

    if (msg.type === 'next' && isHost && state === 'playing') { clearTimeout(autoAdvanceTimer); clearInterval(roundTimer); questionIdx++; sendQuestion(); }
    if (msg.type === 'back_to_lobby' && isHost) { state = 'lobby'; players.forEach(p => p.score = 0); lobbyState(); }
  });

  ws.on('close', () => {
    if (isHost) {
      hostWs = null;
      // Don't reset game — host might reconnect
    }
    if (playerId) {
      // Mark player as disconnected but keep their slot for rejoin
      const p = players.find(x => x.id === playerId);
      if (p) p.ws = null;
      // In lobby, remove them entirely
      if (state === 'lobby') {
        players = players.filter(x => x.id !== playerId);
        lobbyState();
      }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌍 Flag Game Online — listening on port ${PORT}`);
});
