// Chess rules engine. Board is a 64-array, index = row * 8 + col, row 0 = rank 8 (black's back rank).
// White pieces are uppercase (PNBRQK), black are lowercase. Shared by the page and the AI worker.

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
const KN = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
const KG = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const ORTH = [[-1, 0], [1, 0], [0, -1], [0, 1]];

const colorOf = p => p ? (p === p.toUpperCase() ? 'w' : 'b') : null;
const other = c => c === 'w' ? 'b' : 'w';
const on = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
const sqName = i => 'abcdefgh'[i & 7] + (8 - (i >> 3));
const sqIndex = s => (8 - +s[1]) * 8 + 'abcdefgh'.indexOf(s[0]);

function initialState() {
  const b = [];
  for (const ch of START.replace(/\//g, '')) {
    if (/\d/.test(ch)) for (let i = 0; i < +ch; i++) b.push(null);
    else b.push(ch);
  }
  return { b, turn: 'w', castle: 'KQkq', ep: -1, half: 0 };
}

function attacked(b, sq, by) {
  const r = sq >> 3, c = sq & 7, w = by === 'w';
  const pr = w ? r + 1 : r - 1; // a white pawn attacks from the row below
  for (const dc of [-1, 1]) if (on(pr, c + dc) && b[pr * 8 + c + dc] === (w ? 'P' : 'p')) return true;
  for (const [dr, dc] of KN) if (on(r + dr, c + dc) && b[(r + dr) * 8 + c + dc] === (w ? 'N' : 'n')) return true;
  for (const [dr, dc] of KG) if (on(r + dr, c + dc) && b[(r + dr) * 8 + c + dc] === (w ? 'K' : 'k')) return true;
  const Q = w ? 'Q' : 'q';
  for (const [dirs, P] of [[DIAG, w ? 'B' : 'b'], [ORTH, w ? 'R' : 'r']]) {
    for (const [dr, dc] of dirs) {
      let rr = r + dr, cc = c + dc;
      while (on(rr, cc)) {
        const p = b[rr * 8 + cc];
        if (p) { if (p === P || p === Q) return true; break; }
        rr += dr; cc += dc;
      }
    }
  }
  return false;
}

const kingSq = (b, color) => b.indexOf(color === 'w' ? 'K' : 'k');
const inCheck = s => attacked(s.b, kingSq(s.b, s.turn), other(s.turn));

function pseudoMoves(s) {
  const { b, turn } = s, moves = [];
  const add = (from, to, extra) => moves.push(Object.assign({ from, to }, extra));
  for (let i = 0; i < 64; i++) {
    const p = b[i];
    if (!p || colorOf(p) !== turn) continue;
    const r = i >> 3, c = i & 7, t = p.toLowerCase();
    if (t === 'p') {
      const dir = turn === 'w' ? -1 : 1, startR = turn === 'w' ? 6 : 1, lastR = turn === 'w' ? 0 : 7;
      const addP = (to) => {
        if ((to >> 3) === lastR) for (const promo of 'qrbn') add(i, to, { promo });
        else add(i, to);
      };
      if (on(r + dir, c) && !b[(r + dir) * 8 + c]) {
        addP((r + dir) * 8 + c);
        if (r === startR && !b[(r + 2 * dir) * 8 + c]) add(i, (r + 2 * dir) * 8 + c, { double: true });
      }
      for (const dc of [-1, 1]) {
        if (!on(r + dir, c + dc)) continue;
        const to = (r + dir) * 8 + c + dc;
        if (b[to] && colorOf(b[to]) !== turn) addP(to);
        else if (to === s.ep) add(i, to, { epCap: true });
      }
    } else if (t === 'n' || t === 'k') {
      for (const [dr, dc] of t === 'n' ? KN : KG) {
        if (!on(r + dr, c + dc)) continue;
        const to = (r + dr) * 8 + c + dc;
        if (colorOf(b[to]) !== turn) add(i, to);
      }
      if (t === 'k') {
        const home = turn === 'w' ? 60 : 4, opp = other(turn);
        const [kS, qS] = turn === 'w' ? ['K', 'Q'] : ['k', 'q'];
        const rook = turn === 'w' ? 'R' : 'r';
        if (i === home && !attacked(b, home, opp)) {
          if (s.castle.includes(kS) && !b[home + 1] && !b[home + 2] && b[home + 3] === rook &&
              !attacked(b, home + 1, opp) && !attacked(b, home + 2, opp)) add(i, home + 2);
          if (s.castle.includes(qS) && !b[home - 1] && !b[home - 2] && !b[home - 3] && b[home - 4] === rook &&
              !attacked(b, home - 1, opp) && !attacked(b, home - 2, opp)) add(i, home - 2);
        }
      }
    } else {
      const dirs = t === 'b' ? DIAG : t === 'r' ? ORTH : DIAG.concat(ORTH);
      for (const [dr, dc] of dirs) {
        let rr = r + dr, cc = c + dc;
        while (on(rr, cc)) {
          const to = rr * 8 + cc;
          if (b[to]) { if (colorOf(b[to]) !== turn) add(i, to); break; }
          add(i, to);
          rr += dr; cc += dc;
        }
      }
    }
  }
  return moves;
}

function makeMove(s, m) {
  const b = s.b.slice();
  const p = b[m.from], captured = b[m.to];
  b[m.to] = m.promo ? (s.turn === 'w' ? m.promo.toUpperCase() : m.promo) : p;
  b[m.from] = null;
  if (m.epCap) b[m.to + (s.turn === 'w' ? 8 : -8)] = null;
  const isKing = p === 'K' || p === 'k';
  if (isKing && Math.abs(m.to - m.from) === 2) { // castling: bring the rook across
    const kside = m.to > m.from;
    b[kside ? m.from + 1 : m.from - 1] = b[kside ? m.from + 3 : m.from - 4];
    b[kside ? m.from + 3 : m.from - 4] = null;
  }
  let castle = s.castle;
  if (p === 'K') castle = castle.replace(/[KQ]/g, '');
  if (p === 'k') castle = castle.replace(/[kq]/g, '');
  const rookHome = { 63: 'K', 56: 'Q', 7: 'k', 0: 'q' };
  for (const sq of [m.from, m.to]) if (rookHome[sq]) castle = castle.replace(rookHome[sq], '');
  return {
    b, turn: other(s.turn), castle,
    ep: m.double ? (m.from + m.to) / 2 : -1,
    half: (p === 'P' || p === 'p' || captured || m.epCap) ? 0 : s.half + 1,
  };
}

function legalMoves(s) {
  return pseudoMoves(s).filter(m => {
    const n = makeMove(s, m);
    return !attacked(n.b, kingSq(n.b, s.turn), n.turn);
  });
}

const moveStr = m => sqName(m.from) + sqName(m.to) + (m.promo || '');
const posKey = s => s.b.map(p => p || '.').join('') + s.turn + s.castle + s.ep;

// Replays a list like ["e2e4", "e7e5", ...]. Returns null if any move is illegal.
function replay(list) {
  let s = initialState();
  const keys = [posKey(s)], history = [s];
  for (const str of list) {
    const m = legalMoves(s).find(m => moveStr(m) === str);
    if (!m) return null;
    s = makeMove(s, m);
    history.push(s);
    keys.push(posKey(s));
  }
  return { state: s, history, keys };
}

function insufficient(b) {
  const pieces = b.filter(p => p && p.toLowerCase() !== 'k');
  if (pieces.length === 0) return true;
  return pieces.length === 1 && 'nNbB'.includes(pieces[0]);
}

// Game outcome, or null if still going.
function gameStatus(game) {
  const s = game.state;
  if (legalMoves(s).length === 0) {
    return inCheck(s)
      ? { over: true, winner: other(s.turn), reason: 'checkmate' }
      : { over: true, winner: null, reason: 'stalemate' };
  }
  if (s.half >= 100) return { over: true, winner: null, reason: '50-move rule' };
  if (insufficient(s.b)) return { over: true, winner: null, reason: 'not enough pieces' };
  const k = game.keys[game.keys.length - 1];
  if (game.keys.filter(x => x === k).length >= 3) return { over: true, winner: null, reason: 'repetition' };
  return null;
}

// ---------- Computer opponent ----------
const VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

function evaluate(s) {
  // Material plus small bonuses: pieces near the center, pawns that advance. Positive = good for white.
  let score = 0;
  for (let i = 0; i < 64; i++) {
    const p = s.b[i];
    if (!p) continue;
    const t = p.toLowerCase(), w = p !== t, r = i >> 3, c = i & 7;
    const center = (3.5 - Math.abs(r - 3.5)) + (3.5 - Math.abs(c - 3.5));
    let v = VALUE[t];
    if (t === 'n' || t === 'b') v += center * 5;
    if (t === 'p') v += (w ? 6 - r : r - 1) * 6 + (c >= 2 && c <= 5 ? center * 2 : 0);
    if (t === 'q') v += center * 2;
    if (t === 'k') v += (w ? r === 7 : r === 0) ? 15 : -10;
    score += w ? v : -v;
  }
  return score;
}

function orderMoves(s, moves) {
  return moves.map(m => {
    const cap = s.b[m.to];
    m._o = (cap ? 10 * VALUE[cap.toLowerCase()] - VALUE[s.b[m.from].toLowerCase()] / 10 : 0) + (m.promo === 'q' ? 800 : 0);
    return m;
  }).sort((a, b) => b._o - a._o);
}

function quiesce(s, alpha, beta, depth) {
  const stand = (s.turn === 'w' ? 1 : -1) * evaluate(s);
  if (stand >= beta || depth === 0) return stand;
  if (stand > alpha) alpha = stand;
  for (const m of orderMoves(s, legalMoves(s).filter(m => s.b[m.to] || m.promo))) {
    const v = -quiesce(makeMove(s, m), -beta, -alpha, depth - 1);
    if (v >= beta) return v;
    if (v > alpha) alpha = v;
  }
  return alpha;
}

function negamax(s, depth, alpha, beta, ply) {
  const moves = legalMoves(s);
  if (moves.length === 0) return inCheck(s) ? -100000 + ply : 0;
  if (depth === 0) return quiesce(s, alpha, beta, 3);
  let best = -Infinity;
  for (const m of orderMoves(s, moves)) {
    const v = -negamax(makeMove(s, m), depth - 1, -beta, -alpha, ply + 1);
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}

// level: 1 easy, 2 medium, 3 hard
function bestMove(s, level) {
  const depth = level;
  const noise = level === 1 ? 120 : level === 2 ? 15 : 0;
  let best = null, bestV = -Infinity;
  for (const m of orderMoves(s, legalMoves(s))) {
    const v = -negamax(makeMove(s, m), depth - 1, -Infinity, Infinity, 1) + Math.random() * noise;
    if (v > bestV) { bestV = v; best = m; }
  }
  return best && moveStr(best);
}
