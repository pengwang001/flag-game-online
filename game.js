const COLORS=['#3b82f6','#ef4444','#22c55e','#f59e0b'];
const MEDALS=['🥇','🥈','🥉','4th'];
const AVATARS=['🦊','🐼','🦁','🐸','🐙','🦄','🐲','🦈','🐧','🦅','🐺','🦋','🐯','🦖','🐳','🦜','🐵','🦀','🐨','🦉'];
const MAX_CLUES=5;
let numPlayers=1,players=[],playerAvatars=['🦊','🐼','🦁','🐸'],currentContinent,countries,questionIdx,currentPlayer,showFlags,maxRounds=8;
let timerSec=0,timerInterval=null,timeLeft=0;
let clueSet=[],cluesShown=0,clueInterval=null;

// === SOUND EFFECTS ===
const audioCtx=new (window.AudioContext||window.webkitAudioContext)();
function playTone(freq,dur,type='sine',vol=0.3){
  const o=audioCtx.createOscillator(),g=audioCtx.createGain();
  o.type=type;o.frequency.value=freq;g.gain.value=vol;
  o.connect(g);g.connect(audioCtx.destination);
  o.start();g.gain.exponentialRampToValueAtTime(0.001,audioCtx.currentTime+dur);
  o.stop(audioCtx.currentTime+dur);
}
function sfxCorrect(){playTone(523,.1);setTimeout(()=>playTone(659,.1),100);setTimeout(()=>playTone(784,.2),200)}
function sfxWrong(){playTone(200,.15,'square',0.2);setTimeout(()=>playTone(150,.3,'square',0.2),150)}
function sfxTick(){playTone(800,.05,'sine',0.15)}
function sfxUrgent(){playTone(600,.08,'square',0.2);setTimeout(()=>playTone(600,.08,'square',0.2),150)}
function sfxTimeout(){playTone(300,.15,'sawtooth',0.25);setTimeout(()=>playTone(200,.15,'sawtooth',0.25),150);setTimeout(()=>playTone(100,.4,'sawtooth',0.25),300)}
function sfxReveal(){playTone(440,.08,'sine',0.15)}

function pointsForClues(n){return Math.max(1,MAX_CLUES-n+1)} // 5 clues shown=1pt, 1 clue=5pt

// === CORE ===
function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}
function show(id){document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));document.getElementById(id).classList.add('active')}
function showSetup(){clearTimer();clearClueInterval();show('setup')}

function buildSetup(){
  const pc=document.getElementById('pcBtns');pc.innerHTML='';
  for(let i=1;i<=4;i++){const b=document.createElement('button');b.className='pc-btn'+(i===numPlayers?' active':'');b.textContent=i+' Player'+(i>1?'s':'');b.onclick=()=>{numPlayers=i;buildSetup()};pc.appendChild(b)}
  const pi=document.getElementById('playerInputs');pi.innerHTML='';
  for(let i=0;i<numPlayers;i++){
    const wrap=document.createElement('div');wrap.style.cssText='background:#0f172a;border-radius:10px;padding:.6rem';
    const r=document.createElement('div');r.className='player-row';
    const d=document.createElement('div');d.className='dot';d.style.background=COLORS[i];
    const av=document.createElement('span');av.style.fontSize='1.8rem';av.textContent=playerAvatars[i];
    const inp=document.createElement('input');inp.placeholder=`Player ${i+1} name`;inp.id=`pname${i}`;inp.value=(players[i]||'');
    inp.oninput=()=>{players[i]=inp.value};
    r.append(d,av,inp);wrap.appendChild(r);
    const ap=document.createElement('div');ap.className='avatar-picker';
    AVATARS.forEach(a=>{
      const b=document.createElement('button');b.className='avatar-btn'+(a===playerAvatars[i]?' selected':'');b.textContent=a;
      b.onclick=(e)=>{e.preventDefault();playerAvatars[i]=a;buildSetup()};
      ap.appendChild(b);
    });
    wrap.appendChild(ap);pi.appendChild(wrap);
  }
  const rs=document.getElementById('roundSelect');rs.innerHTML='';
  [5,8,10,15].forEach(n=>{const b=document.createElement('button');b.className='pc-btn'+(n===maxRounds?' active':'');b.textContent=n;b.onclick=()=>{maxRounds=n;buildSetup()};rs.appendChild(b)});
  const ts=document.getElementById('timerSelect');ts.innerHTML='';
  [{v:0,l:'No timer'},{v:15,l:'15s'},{v:20,l:'20s'},{v:30,l:'30s'},{v:45,l:'45s'}].forEach(t=>{
    const b=document.createElement('button');b.className='pc-btn'+(t.v===timerSec?' active':'');b.textContent=t.l;
    b.onclick=()=>{timerSec=t.v;buildSetup()};ts.appendChild(b);
  });
  const g=document.getElementById('continentGrid');g.innerHTML='';
  Object.keys(DATA).forEach(c=>{const b=document.createElement('button');b.className='continent-btn';b.textContent=c+` (${DATA[c].length})`;b.onclick=()=>startGame(c);g.appendChild(b)});
}

function startGame(continent){
  if(audioCtx.state==='suspended')audioCtx.resume();
  for(let i=0;i<numPlayers;i++){const v=document.getElementById(`pname${i}`).value.trim();players[i]=v||`Player ${i+1}`}
  players.length=numPlayers;
  showFlags=document.getElementById('showFlag').checked;
  currentContinent=continent;
  countries=shuffle([...DATA[continent]]).slice(0,maxRounds);
  questionIdx=0;currentPlayer=0;
  players=players.map((p,i)=>typeof p==='string'?{name:p,score:0,avatar:playerAvatars[i]}:{...p,score:0,avatar:playerAvatars[i]});
  show('game');nextTurn();
}

function renderScoreboard(){
  const sb=document.getElementById('scoreboard');sb.innerHTML='';
  players.forEach((p,i)=>{
    const c=document.createElement('div');c.className='sb-chip'+(i===currentPlayer?' active-player':'');
    c.style.borderColor=i===currentPlayer?COLORS[i]:'#334155';
    c.innerHTML=`${p.avatar} ${p.name}: ${p.score}`;
    sb.appendChild(c);
  });
}

// === CLUE REVEAL ===
function clearClueInterval(){if(clueInterval){clearInterval(clueInterval);clueInterval=null}}

function revealNextClue(){
  if(cluesShown>=clueSet.length)return;
  const cl=document.getElementById('clues');
  const li=document.createElement('li');li.textContent=clueSet[cluesShown];
  li.style.animation='fadeIn .3s';cl.appendChild(li);
  cluesShown++;
  sfxReveal();
  updatePointsHint();
  // Hide "show clue" button if all shown
  const btn=document.getElementById('revealBtn');
  if(btn&&cluesShown>=clueSet.length)btn.style.display='none';
}

function updatePointsHint(){
  const pts=pointsForClues(cluesShown);
  document.getElementById('pointsHint').textContent=`Answer now: ${pts} pt${pts>1?'s':''}`;
  document.getElementById('pointsHint').style.color=pts>=4?'#22c55e':pts>=3?'#3b82f6':pts>=2?'#f59e0b':'#94a3b8';
}

function startClueReveals(){
  cluesShown=0;
  const cl=document.getElementById('clues');cl.innerHTML='';
  // Show first clue immediately
  revealNextClue();
  if(timerSec){
    // Auto-reveal clues at intervals spread across the timer
    const interval=(timerSec*1000)/(MAX_CLUES);
    clueInterval=setInterval(()=>{
      if(cluesShown<clueSet.length)revealNextClue();
      else clearClueInterval();
    },interval);
  }
  // Show manual reveal button (always available, useful with or without timer)
  const btn=document.getElementById('revealBtn');
  if(btn){btn.style.display=cluesShown<clueSet.length?'inline-block':'none'}
}

// === TIMER ===
function clearTimer(){
  if(timerInterval){clearInterval(timerInterval);timerInterval=null}
  document.getElementById('timerBarContainer').style.display='none';
  document.getElementById('timerDisplay').style.display='none';
}

function startTimer(){
  if(!timerSec)return;
  timeLeft=timerSec;
  const barC=document.getElementById('timerBarContainer');
  const bar=document.getElementById('timerBar');
  const disp=document.getElementById('timerDisplay');
  barC.style.display='block';disp.style.display='block';
  updateTimerUI(bar,disp);
  timerInterval=setInterval(()=>{
    timeLeft-=0.1;
    if(timeLeft<=0){
      timeLeft=0;clearInterval(timerInterval);timerInterval=null;
      updateTimerUI(bar,disp);onTimeout();
    }else{
      updateTimerUI(bar,disp);
      if(timeLeft<=3&&Math.abs(timeLeft-Math.round(timeLeft))<0.05)sfxUrgent();
      else if(timeLeft<=5&&Math.abs(timeLeft-Math.round(timeLeft))<0.05)sfxTick();
    }
  },100);
}

function updateTimerUI(bar,disp){
  const pct=(timeLeft/timerSec)*100;
  bar.style.width=pct+'%';
  bar.className='timer-bar'+(pct<=20?' danger':pct<=40?' warning':'');
  disp.textContent=Math.ceil(timeLeft)+'s';
  disp.className='timer-display'+(timeLeft<=3?' danger':timeLeft<=5?' warning':'');
}

function onTimeout(){
  clearClueInterval();sfxTimeout();
  document.querySelectorAll('.choice-btn').forEach(b=>b.disabled=true);
  const q=countries[questionIdx];
  document.querySelectorAll('.choice-btn').forEach(b=>{if(b.textContent===q.name)b.classList.add('correct')});
  const p=players[currentPlayer];
  document.getElementById('result').textContent=`⏰ Time's up, ${p.avatar} ${p.name}! It was ${q.name}`;
  document.getElementById('pointsHint').textContent='0 pts';document.getElementById('pointsHint').style.color='#ef4444';
  document.getElementById('revealBtn').style.display='none';
  questionIdx++;currentPlayer=(currentPlayer+1)%players.length;
  document.getElementById('nextBtn').style.display='inline-block';
  document.getElementById('nextBtn').textContent=questionIdx>=countries.length?'See Results →':'Next →';
  renderScoreboard();
}

// === TURNS ===
function nextTurn(){
  clearTimer();clearClueInterval();
  if(questionIdx>=countries.length){endGame();return}
  const q=countries[questionIdx];
  const p=players[currentPlayer];
  document.getElementById('turnBanner').innerHTML=`<span style="color:${COLORS[currentPlayer]}">${p.avatar} ${p.name}'s turn</span> — Round ${questionIdx+1}/${countries.length}`;
  document.getElementById('turnBanner').style.borderBottom=`3px solid ${COLORS[currentPlayer]}`;
  renderScoreboard();
  document.getElementById('flag').textContent=showFlags?q.flag:'❓';
  const lm=document.getElementById('landmark');
  if(q.img){lm.src=q.img;lm.style.display='block';lm.alt='Famous landmark'}else{lm.style.display='none'}

  // Prepare clues
  clueSet=shuffle([...q.clues]).slice(0,MAX_CLUES);

  const pool=DATA[currentContinent].filter(c=>c.name!==q.name);
  const opts=shuffle([q,...shuffle(pool).slice(0,3)]);
  const ch=document.getElementById('choices');ch.innerHTML='';
  opts.forEach(o=>{const b=document.createElement('button');b.className='choice-btn';b.textContent=o.name;b.onclick=()=>answer(b,o.name===q.name,q.name);ch.appendChild(b)});
  document.getElementById('result').textContent='';
  document.getElementById('nextBtn').style.display='none';
  document.getElementById('pointsHint').textContent='';

  startClueReveals();
  startTimer();
}

function answer(btn,correct,rightAnswer){
  clearTimer();clearClueInterval();
  document.querySelectorAll('.choice-btn').forEach(b=>{b.disabled=true;if(b.textContent===rightAnswer)b.classList.add('correct')});
  const p=players[currentPlayer];
  const pts=correct?pointsForClues(cluesShown):0;
  if(correct){
    p.score+=pts;sfxCorrect();
    document.getElementById('result').textContent=`✅ ${p.avatar} ${p.name} got it! +${pts} pt${pts>1?'s':''}`;
    document.getElementById('pointsHint').textContent=`+${pts}`;document.getElementById('pointsHint').style.color='#22c55e';
  }else{
    btn.classList.add('wrong');sfxWrong();
    document.getElementById('result').textContent=`❌ It was ${rightAnswer}`;
    document.getElementById('pointsHint').textContent='0 pts';document.getElementById('pointsHint').style.color='#ef4444';
  }
  document.getElementById('revealBtn').style.display='none';
  renderScoreboard();questionIdx++;
  currentPlayer=(currentPlayer+1)%players.length;
  document.getElementById('nextBtn').style.display='inline-block';
  document.getElementById('nextBtn').textContent=questionIdx>=countries.length?'See Results →':'Next →';
}

function endGame(){
  clearTimer();clearClueInterval();show('end');
  const maxPts=countries.length*MAX_CLUES; // theoretical max
  const sorted=[...players].sort((a,b)=>b.score-a.score);
  const pod=document.getElementById('podium');pod.innerHTML='';
  sorted.forEach((p,i)=>{
    pod.innerHTML+=`<div class="podium-row"><span class="medal">${MEDALS[i]||''}</span><span class="pname">${p.avatar} ${p.name}</span><span class="pscore">${p.score} pts</span></div>`;
  });
  if(sorted[0].score>0){setTimeout(()=>{playTone(523,.1);setTimeout(()=>playTone(659,.1),120);setTimeout(()=>playTone(784,.1),240);setTimeout(()=>playTone(1047,.3),360)},300)}
}

buildSetup();
