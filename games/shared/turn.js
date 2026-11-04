// Shared engine for two-player turn games: menu, pass & play, vs computer, and online play with a friend.
//
// A game is described by plain rules; this file handles everything else.
//   GZ.turnGame({
//     id, title, help,                       // help = HTML list of rules
//     sides: [{ name, color }, { name, color }],
//     modes: ['online', 'local', 'cpu'],     // which ways to play are offered
//     levels: ['Easy', 'Medium', 'Hard'],    // computer difficulty names
//     init(seed)            -> starting state (seed is a string, same on both phones)
//     turn(state)           -> 0 or 1, the side that moves next
//     apply(state, move, side) -> new state, or null if the move is illegal (never mutate state)
//     result(state)         -> null while playing, else { winner: 0 | 1 | null, reason }
//     mount(stage, api)     -> build the board once; call api.play(move) when the player acts
//     draw(state, view)     -> redraw; view = { me, mode, canPlay, thinking, over }
//     ai(state, side, level) -> a move for the computer (level 0, 1, 2)
//     score(state)          -> optional [a, b] shown next to the names
//     status(state, view)   -> optional custom status line
//   })
//
// Online games are a list of moves relayed through ntfy.sh (a free public message service).
// Every message holds the whole game, so whoever has the newest message knows everything.
(function () {
  const RELAY = 'https://ntfy.sh/';
  const $ = id => document.getElementById(id);

  function randId(n) {
    const a = 'abcdefghijkmnpqrstuvwxyz23456789';
    return Array.from(crypto.getRandomValues(new Uint8Array(n)), x => a[x % a.length]).join('');
  }
  const myId = localStorage.getItem('gzPlayerId') || (() => {
    const id = randId(12);
    localStorage.setItem('gzPlayerId', id);
    return id;
  })();

  // Seeded random numbers, so both phones get the same "random" things from the same seed.
  function rng(seed) {
    let h = 1779033703 ^ seed.length;
    for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = h << 13 | h >>> 19; }
    let a = h >>> 0;
    return () => {
      a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  window.GZ = { randId, myId, rng, turnGame };

  function turnGame(def) {
    const KEY = 'gz_' + def.id;
    const levels = def.levels || ['Easy', 'Medium', 'Hard'];
    let mode = null, level = 1, human = 0;
    let seed = '', moves = [], state = null;
    let thinking = false, aiToken = 0, shownResult = null;
    let net = null; // { room, st, seen, lastId, es, relayHad }

    // ---------- page skeleton ----------
    document.title = def.title;
    document.body.insertAdjacentHTML('afterbegin', `
      <div id="top"><a href="../../">&#8249;</a><h1>${def.title}</h1><span id="net"></span><button class="round" id="helpBtn">?</button></div>
      <div id="menu">
        <button class="opt hidden" id="continueBtn"><span class="e">▶️</span><span><b>Continue</b><small id="continueSub"></small></span></button>
        ${def.modes.includes('online') ? '<button class="opt" id="m-online"><span class="e">🌍</span><span><b>Play a friend online</b><small>Send a link to someone far away</small></span></button>' : ''}
        ${def.modes.includes('local') ? '<button class="opt" id="m-local"><span class="e">📱</span><span><b>Pass &amp; play</b><small>Two players, one phone</small></span></button>' : ''}
        ${def.modes.includes('cpu') ? `<button class="opt" id="m-cpu"><span class="e">🤖</span><span><b>vs Computer</b><small>Practice against the bot</small></span></button>
        <div class="sub hidden" id="cpuOpts"><p>Difficulty</p><div class="row">${levels.map((l, i) => `<button class="seg${i === 1 ? ' on' : ''}" data-level="${i}">${l}</button>`).join('')}</div>
        <p>Who goes first?</p><div class="row"><button class="seg on" data-first="0">Me</button><button class="seg" data-first="1">Computer</button></div>
        <button class="btn main" id="cpuStart" style="margin-top:8px;padding:14px">Start</button></div>` : ''}
      </div>
      <div id="play" class="hidden">
        <div id="bar">${[0, 1].map(i => `<div class="chip" id="chip${i}" style="--c:${def.sides[i].color}"><span class="sw"></span><span class="nm"></span><b class="sc"></b></div>`).join('')}</div>
        <div id="stage"></div>
        <div id="status"></div>
        <div id="controls"></div>
      </div>
      <div id="share" class="overlay hidden"><div class="card">
        <h2>Invite a friend</h2>
        <p>Send this link to your friend. When they open it, you're both in the same game.</p>
        <div id="link"></div>
        <button class="btn main" id="shareBtn">Share link</button>
        <button class="btn" id="copyBtn">Copy link</button>
        <button class="btn" id="shareClose">Done</button>
      </div></div>
      <div id="result" class="overlay hidden"><div class="card">
        <h2 id="resTitle"></h2><p id="resSub"></p>
        <button class="btn main" id="resAgain"></button>
        <button class="btn" id="resView">Look at the board</button>
        <button class="btn" id="resMenu">Menu</button>
      </div></div>
      <div id="helpBox" class="overlay hidden"><div class="card help">
        <h2>How to play</h2>${def.help}<button class="btn main" id="helpClose">Got it</button>
      </div></div>`);

    const api = { play, redraw: () => refresh(), get state() { return state; }, get moves() { return moves; }, get seed() { return seed; } };
    GZ.current = api; // handy for testing from the browser console
    def.mount($('stage'), api);

    // ---------- core ----------
    function build(sd, list) {
      let s = def.init(sd);
      for (const m of list) {
        s = def.apply(s, m, def.turn(s));
        if (!s) return null;
      }
      return s;
    }

    function setGame(sd, list) {
      // Only apply the new moves when the list just grew; rebuild otherwise
      if (sd === seed && state && list.length >= moves.length && moves.every((m, i) => JSON.stringify(m) === JSON.stringify(list[i]))) {
        let s = state;
        for (const m of list.slice(moves.length)) {
          s = def.apply(s, m, def.turn(s));
          if (!s) return false;
        }
        state = s;
      } else {
        const s = build(sd, list);
        if (!s) return false;
        state = s;
      }
      seed = sd;
      moves = list.slice();
      return true;
    }

    function mySide() {
      if (mode === 'cpu') return human;
      if (mode === 'local') return def.turn(state);
      return onlineSide();
    }

    function canPlay() {
      if (!state || def.result(state)) return false;
      const t = def.turn(state);
      if (mode === 'local') return true;
      if (mode === 'cpu') return t === human && !thinking;
      if (mode === 'online') return onlineSide() === t;
      return false;
    }

    function play(move) {
      if (!canPlay()) return false;
      const n = def.apply(state, move, def.turn(state));
      if (!n) return false;
      state = n;
      moves.push(move);
      if (navigator.vibrate) navigator.vibrate(10);
      afterMove();
      return true;
    }

    function afterMove() {
      if (mode === 'online') {
        net.st = Object.assign({}, net.st, { moves: moves.slice() });
        saveOnline();
        publish();
      } else saveLocal();
      refresh();
      if (mode === 'cpu') maybeAi();
    }

    function view() {
      return { me: mySide(), mode, canPlay: canPlay(), thinking, over: !!def.result(state), online: mode === 'online' };
    }

    function names() {
      if (mode === 'cpu') return [0, 1].map(i => i === human ? 'You' : '🤖 ' + levels[level]);
      if (mode === 'online') {
        const me = onlineSide();
        if (me === null) return def.sides.map(s => s.name);
        const waiting = net && net.st && !net.st.guest;
        return [0, 1].map(i => i === me ? 'You' : waiting ? 'Waiting…' : 'Friend');
      }
      return def.sides.map(s => s.name);
    }

    function statusText() {
      const r = def.result(state), v = view();
      if (def.status) { const s = def.status(state, v); if (s) return s; }
      if (r) return r.winner === null ? 'Draw — ' + r.reason : `${names()[r.winner]} ${names()[r.winner] === 'You' ? 'win' : 'wins'} — ${r.reason}`;
      const t = def.turn(state);
      if (mode === 'local') return `${def.sides[t].name}'s turn`;
      if (mode === 'cpu') return thinking ? 'Computer is thinking…' : 'Your turn';
      if (mode === 'online') {
        const me = onlineSide();
        if (me === null) return `Watching — ${def.sides[t].name}'s turn`;
        if (!net.st.guest && net.st.host === myId) return t === me ? 'Your move (friend hasn\'t joined yet)' : 'Waiting for your friend…';
        return t === me ? 'Your turn' : 'Friend\'s turn';
      }
      return '';
    }

    function refresh() {
      if (!state) return;
      const v = view();
      def.draw(state, v);
      const nm = names(), sc = def.score ? def.score(state) : null, r = def.result(state), t = def.turn(state);
      [0, 1].forEach(i => {
        const c = $('chip' + i);
        c.querySelector('.nm').textContent = nm[i];
        c.querySelector('.sc').textContent = sc ? sc[i] : '';
        c.classList.toggle('active', !r && t === i);
      });
      $('status').textContent = statusText();
      renderControls();
      checkResult();
      if (mode === 'online') document.title = (!r && onlineSide() === t ? '● Your turn — ' : '') + def.title;
    }

    function renderControls() {
      const c = $('controls');
      c.innerHTML = '';
      const add = (label, fn, main) => {
        const b = document.createElement('button');
        b.className = 'btn' + (main ? ' main' : '');
        b.textContent = label;
        b.onclick = fn;
        c.appendChild(b);
      };
      const r = def.result(state);
      if (mode === 'online') {
        add('Invite link', openShare, !net.st || !net.st.guest);
        if (r && onlineSide() !== null) add('Rematch', rematch, true);
      } else {
        if (moves.length && !r) add('Undo', undo);
        add('New game', newOffline, !!r);
      }
      add('Menu', showMenu);
    }

    function checkResult() {
      const r = def.result(state);
      if (!r) { $('result').classList.add('hidden'); return; }
      const key = mode + seed + moves.length;
      if (shownResult === key) return;
      shownResult = key;
      const nm = names(), me = mode === 'local' ? null : mySide();
      $('resTitle').textContent = r.winner === null ? 'Draw' : me === null ? `${nm[r.winner]} wins!` : r.winner === me ? 'You win! 🎉' : 'You lost';
      $('resSub').textContent = r.reason[0].toUpperCase() + r.reason.slice(1);
      $('resAgain').textContent = mode === 'online' ? 'Rematch' : 'New game';
      $('resAgain').classList.toggle('hidden', mode === 'online' && onlineSide() === null);
      if (navigator.vibrate) navigator.vibrate(me === null || r.winner === me ? [60, 50, 60] : 200);
      setTimeout(() => { if (def.result(state)) $('result').classList.remove('hidden'); }, 700);
      if (mode !== 'online') localStorage.removeItem(KEY + '_local');
    }
    $('resView').onclick = () => $('result').classList.add('hidden');
    $('resMenu').onclick = () => { $('result').classList.add('hidden'); showMenu(); };
    $('resAgain').onclick = () => { $('result').classList.add('hidden'); mode === 'online' ? rematch() : newOffline(); };

    // ---------- pass & play / computer ----------
    function saveLocal() {
      localStorage.setItem(KEY + '_local', JSON.stringify({ mode, level, human, seed, moves }));
    }

    function startOffline(m, hum) {
      enter(m);
      human = hum;
      setGame(GZ.randId(10), []);
      saveLocal(); refresh(); maybeAi();
    }
    // A new game against the computer swaps who goes first
    function newOffline() { startOffline(mode, mode === 'cpu' ? 1 - human : 0); }

    let aiStreak = 0; // computer moving again right after itself (extra turns) goes quicker
    function maybeAi() {
      if (mode !== 'cpu' || def.result(state) || def.turn(state) === human) { aiStreak = 0; return; }
      thinking = true;
      const token = ++aiToken, started = Date.now();
      refresh();
      setTimeout(async () => { // let the screen update before the computer thinks
        const move = await def.ai(state, def.turn(state), level);
        setTimeout(() => {
          if (token !== aiToken || mode !== 'cpu') return;
          thinking = false;
          const n = def.apply(state, move, def.turn(state));
          if (!n) { refresh(); return; }
          state = n;
          moves.push(move);
          afterMove();
        }, Math.max(0, (aiStreak++ ? 250 : 500) - (Date.now() - started)));
      }, 30);
    }

    function undo() {
      if (!moves.length) return;
      aiToken++; thinking = false;
      const list = moves.slice(0, -1);
      if (mode === 'cpu') while (list.length && def.turn(build(seed, list)) !== human) list.pop();
      state = build(seed, list); moves = list;
      shownResult = null;
      saveLocal(); refresh(); maybeAi();
    }

    // ---------- online ----------
    const topic = room => 'gamezone-' + def.id + '-' + room;
    const roomLink = room => location.origin + location.pathname + '?room=' + room;
    const gameSeed = st => st.seed + ':' + st.g;

    // Sides swap every rematch, so going first alternates
    function onlineSide() {
      const st = net && net.st;
      if (!st) return null;
      const hostSide = st.g % 2;
      if (myId === st.host) return hostSide;
      if (myId === st.guest) return 1 - hostSide;
      return null;
    }

    function isNewer(a, b) {
      return a.g !== b.g ? a.g > b.g : a.moves.length > b.moves.length;
    }

    function accept(st) {
      if (!st || !Array.isArray(st.moves) || !st.host || typeof st.g !== 'number') return;
      const cur = net.st;
      if (cur && st.host !== cur.host) return;
      if (!build(gameSeed(st), st.moves)) return;
      if (!cur || isNewer(st, cur)) net.st = Object.assign({}, st, { guest: st.guest || (cur && cur.guest) || null });
      else if (st.guest && !cur.guest) net.st = Object.assign({}, cur, { guest: st.guest });
    }

    function saveOnline() {
      if (net && net.st) localStorage.setItem(KEY + '_room_' + net.room, JSON.stringify(net.st));
    }

    function onRaw(d) {
      if (d.event !== 'message' || net.seen.has(d.id)) return;
      net.seen.add(d.id);
      net.lastId = d.id;
      net.relayHad = true;
      try {
        const st = JSON.parse(d.message);
        if (st.app === KEY) accept(st);
      } catch (e) {}
    }

    let publishTimer = null;
    async function publish() {
      clearTimeout(publishTimer);
      if (!net || !net.st) return;
      const room = net.room;
      try {
        const res = await fetch(RELAY + topic(room), { method: 'POST', body: JSON.stringify(Object.assign({ app: KEY }, net.st)) });
        if (!res.ok) throw new Error(res.status);
        setNet('');
      } catch (e) {
        setNet('Not sent — retrying…');
        publishTimer = setTimeout(() => { if (net && net.room === room) publish(); }, 3000);
      }
    }

    function setNet(t) { $('net').textContent = t; }

    function openRoom(room, initial) {
      closeNet();
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(KEY + '_room_' + room)); } catch (e) {}
      net = { room, st: initial || saved, seen: new Set(), lastId: null, es: null, relayHad: false };
      localStorage.setItem(KEY + '_lastRoom', room);
      history.replaceState(null, '', '?room=' + room);
      enter('online');
      if (net.st) sync();
      else $('status').textContent = 'Connecting…';
      connect(true);
    }

    async function connect(first, tries = 0) {
      if (!net) return;
      const room = net.room;
      setNet('Connecting…');
      try {
        const res = await fetch(RELAY + topic(room) + '/json?poll=1&since=all');
        const text = await res.text();
        if (!net || net.room !== room) return;
        for (const line of text.split('\n')) if (line.trim()) onRaw(JSON.parse(line));
      } catch (e) {
        setNet('Offline — retrying…');
        setTimeout(() => { if (net && net.room === room) connect(first, tries); }, 4000);
        return;
      }
      if (!net.st) {
        // A brand-new game can take a moment to show up on the relay
        if (tries < 8) {
          $('status').textContent = 'Finding the game…';
          setTimeout(() => { if (net && net.room === room) connect(first, tries + 1); }, 1500);
          return;
        }
        $('status').textContent = 'Game not found. Invite links expire 12 hours after the last move — ask your friend for a new one.';
        setNet('');
        openStream();
        return;
      }
      setNet('');
      if (first && !net.relayHad) publish(); // relay forgot the game but we remember it: put it back
      sync();
      openStream();
    }

    function openStream() {
      if (!net) return;
      if (net.es) net.es.close();
      const es = new EventSource(RELAY + topic(net.room) + '/sse?since=' + (net.lastId || 'all'));
      es.onmessage = e => {
        try { onRaw(JSON.parse(e.data)); } catch (err) { return; }
        sync();
      };
      es.onopen = () => setNet('');
      es.onerror = () => setNet('Reconnecting…');
      net.es = es;
    }

    function closeNet() {
      if (net && net.es) net.es.close();
      clearTimeout(publishTimer);
      net = null;
      setNet('');
    }

    // Phones pause background connections; refresh when you come back
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && net && net.st) connect(false);
    });

    let lastSync = '';
    function sync() {
      if (!net || !net.st) return;
      // First new person to open the link gets the second seat
      if (net.st.host !== myId && !net.st.guest) {
        net.st = Object.assign({}, net.st, { guest: myId });
        publish();
      }
      saveOnline();
      const key = JSON.stringify(net.st);
      if (key === lastSync) return;
      lastSync = key;
      const before = state && def.turn(state);
      if (!setGame(gameSeed(net.st), net.st.moves)) return;
      if (navigator.vibrate && !def.result(state) && def.turn(state) === onlineSide() && before !== onlineSide()) navigator.vibrate(30);
      refresh();
    }

    function createRoom() {
      const room = GZ.randId(8);
      openRoom(room, { host: myId, guest: null, g: 0, seed: GZ.randId(10), moves: [] });
      openShare();
    }

    function rematch() {
      if (!def.result(state)) return; // friend already started it
      net.st = Object.assign({}, net.st, { g: net.st.g + 1, moves: [] });
      shownResult = null;
      publish(); sync();
    }

    function openShare() {
      $('link').textContent = roomLink(net.room);
      $('shareBtn').classList.toggle('hidden', !navigator.share);
      $('share').classList.remove('hidden');
    }
    $('shareBtn').onclick = () => navigator.share({ title: def.title, text: `Play ${def.title} with me!`, url: roomLink(net.room) }).catch(() => {});
    $('copyBtn').onclick = async () => {
      try { await navigator.clipboard.writeText(roomLink(net.room)); $('copyBtn').textContent = 'Copied!'; }
      catch (e) { $('copyBtn').textContent = 'Press & hold the link to copy'; }
      setTimeout(() => $('copyBtn').textContent = 'Copy link', 2000);
    };
    $('shareClose').onclick = () => $('share').classList.add('hidden');

    // ---------- screens ----------
    function enter(m) {
      aiToken++; thinking = false;
      mode = m; shownResult = null; lastSync = '';
      seed = ''; moves = []; state = null;
      $('menu').classList.add('hidden');
      $('play').classList.remove('hidden');
    }

    function showMenu() {
      aiToken++; thinking = false;
      if (mode === 'online') history.replaceState(null, '', location.pathname);
      closeNet();
      mode = null;
      document.title = def.title;
      $('play').classList.add('hidden');
      $('menu').classList.remove('hidden');
      $('result').classList.add('hidden');
      const opts = $('cpuOpts');
      if (opts) opts.classList.add('hidden');

      let local = null;
      try { local = JSON.parse(localStorage.getItem(KEY + '_local')); } catch (e) {}
      const room = localStorage.getItem(KEY + '_lastRoom');
      const cont = $('continueBtn');
      cont.classList.remove('hidden');
      if (room && localStorage.getItem(KEY + '_room_' + room)) {
        $('continueSub').textContent = 'Your online game';
        cont.onclick = () => openRoom(room);
      } else if (local && local.moves && local.moves.length && def.modes.includes(local.mode)) {
        $('continueSub').textContent = local.mode === 'cpu' ? 'vs Computer (' + levels[local.level] + ')' : 'Pass & play';
        cont.onclick = () => {
          enter(local.mode);
          level = local.level; human = local.human;
          if (!setGame(local.seed, local.moves)) setGame(GZ.randId(10), []);
          refresh(); maybeAi();
        };
      } else cont.classList.add('hidden');
    }

    if ($('m-online')) $('m-online').onclick = createRoom;
    if ($('m-local')) $('m-local').onclick = () => startOffline('local', 0);
    let firstPick = 0;
    if ($('m-cpu')) {
      $('m-cpu').onclick = () => $('cpuOpts').classList.toggle('hidden');
      document.querySelectorAll('[data-level]').forEach(b => b.onclick = () => {
        level = +b.dataset.level;
        document.querySelectorAll('[data-level]').forEach(x => x.classList.toggle('on', x === b));
      });
      document.querySelectorAll('[data-first]').forEach(b => b.onclick = () => {
        firstPick = +b.dataset.first;
        document.querySelectorAll('[data-first]').forEach(x => x.classList.toggle('on', x === b));
      });
      $('cpuStart').onclick = () => startOffline('cpu', firstPick);
    }
    $('helpBtn').onclick = () => $('helpBox').classList.remove('hidden');
    $('helpClose').onclick = () => { $('helpBox').classList.add('hidden'); localStorage.setItem(KEY + '_help', 1); };

    const roomParam = new URLSearchParams(location.search).get('room');
    if (roomParam && /^[a-z0-9]{4,20}$/.test(roomParam)) openRoom(roomParam);
    else {
      showMenu();
      if (!localStorage.getItem(KEY + '_help')) $('helpBox').classList.remove('hidden');
    }

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('../../sw.js');
    return api;
  }
})();
