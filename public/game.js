(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const minus = (v) => String(v).replace(/-/g, '−');
  const pad2 = (n) => String(n).padStart(2, '0');
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const range = (n) => Array.from({ length: n }, (_, i) => i);
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  const PREFIX = 'solvesum:v1:';
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem(PREFIX + k);
        return v == null ? d : JSON.parse(v);
      } catch { return d; }
    },
    set(k, v) {
      try { localStorage.setItem(PREFIX + k, JSON.stringify(v)); } catch { /* storage unavailable */ }
    },
    del(k) {
      try { localStorage.removeItem(PREFIX + k); } catch { /* storage unavailable */ }
    },
  };

  function seedFrom(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h | 0;
  }

  // mulberry32, with its state exposed so a game in progress can be saved and resumed.
  function makeRng(state) {
    const rng = () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    rng.state = () => state;
    return rng;
  }
  const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  function shuffled(arr, rng) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ---------------------------------------------------------------------------
  // Rules
  // ---------------------------------------------------------------------------
  const MIN_N = 2;
  const MAX_N = 10;
  const DAILY_N = 5;
  const SHUFFLES = 3;
  const HINT_COST = 2;
  const LINE_POINTS = 10;
  const swapBudget = (n) => 10 + 6 * n;
  const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const LOG_EMOJI = { 0: '⬜', 1: '🟩', 2: '🟨', 3: '🟧', h: '💡', s: '🔀' };

  // Game ids: "d:2026-09-16" for a daily, "c:K3F9QZ:6" for a coded game.
  function dateKey(d = new Date()) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  const dailyId = () => `d:${dateKey()}`;
  const customId = (code, n) => `c:${code}:${n}`;
  function parseId(id) {
    const [kind, a, b] = String(id).split(':');
    if (kind === 'd' && /^\d{4}-\d{2}-\d{2}$/.test(a)) return { daily: true, date: a, n: DAILY_N };
    const n = Number(b);
    if (kind === 'c' && /^[A-Z0-9]{4,8}$/.test(a) && Number.isInteger(n) && n >= MIN_N && n <= MAX_N) {
      return { daily: false, code: a, n };
    }
    return null;
  }
  const shareCode = (p) => `${p.code}-${p.n}`;
  function parseCode(raw) {
    const m = String(raw).toUpperCase().replace(/\s+/g, '').match(/^([A-Z0-9]{4,8})-(\d{1,2})$/);
    if (!m) return null;
    const id = customId(m[1], Number(m[2]));
    return parseId(id) ? id : null;
  }
  function randomCode() {
    const bytes = new Uint32Array(6);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
  }
  function prettyDate(key, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, opts);
  }
  const SITE = 'https://solvesum.tryonlinux.com/';
  // Shareable link; falls back to the live site when opened from a file.
  function gameUrl(id) {
    const p = parseId(id);
    const base = location.protocol.startsWith('http') ? new URL('./', location.href).href : SITE;
    return p.daily ? base : `${base}?g=${shareCode(p)}`;
  }
  function gameTitle(id) {
    const p = parseId(id);
    return p.daily ? 'Daily puzzle' : `Game ${shareCode(p)}`;
  }
  function gameSub(id) {
    const p = parseId(id);
    return p.daily ? `${prettyDate(p.date)} · ${p.n}×${p.n}` : `${p.n}×${p.n} random board`;
  }

  // Lines are keyed "r0".."r{n-1}" and "c0".."c{n-1}".
  const lineKeys = (n) => [...range(n).map((i) => `r${i}`), ...range(n).map((i) => `c${i}`)];
  const lineCells = (n, key) => {
    const i = Number(key.slice(1));
    return key[0] === 'r' ? range(n).map((c) => i * n + c) : range(n).map((r) => r * n + i);
  };
  const lineSum = (g, key) => lineCells(g.n, key).reduce((s, idx) => s + g.v[idx], 0);
  const targetOf = (g, key) => (key[0] === 'r' ? g.rows : g.cols)[Number(key.slice(1))];
  function setTarget(g, key, t) {
    (key[0] === 'r' ? g.rows : g.cols)[Number(key.slice(1))] = t;
  }
  const solvedLines = (g) => lineKeys(g.n).filter((k) => lineSum(g, k) === targetOf(g, k));
  const lineName = (key) => `${key[0] === 'r' ? 'row' : 'column'} ${Number(key.slice(1)) + 1}`;
  const tileValue = (rng, n) => randInt(rng, -n * n, n * n);

  function neighbours(n, i) {
    const r = Math.floor(i / n);
    const c = i % n;
    const out = [];
    if (r > 0) out.push(i - n);
    if (r < n - 1) out.push(i + n);
    if (c > 0) out.push(i - 1);
    if (c < n - 1) out.push(i + 1);
    return out;
  }
  const isAdjacent = (n, a, b) => neighbours(n, a).includes(b);

  // A target the line can actually reach: pull a few tiles into it from the
  // lines one or two away. Each pull is a straight run of swaps along one
  // column (for a row) or row (for a column), so the target is always solvable
  // from the board it was dealt with.
  function reachableTarget(g, key, rng) {
    const n = g.n;
    const i = Number(key.slice(1));
    const at = key[0] === 'r' ? (line, pos) => g.v[line * n + pos] : (line, pos) => g.v[pos * n + line];
    const current = lineSum(g, key);
    const offsets = [-2, -1, 1, 2].filter((d) => i + d >= 0 && i + d < n);
    for (let attempt = 0; attempt < 32; attempt++) {
      const pulls = randInt(rng, n >= 3 ? 2 : 1, Math.min(n, 4));
      let t = current;
      for (const pos of shuffled(range(n), rng).slice(0, pulls)) {
        const d = offsets[randInt(rng, 0, offsets.length - 1)];
        t += at(i + d, pos) - at(i, pos);
      }
      if (t !== current) return t;
    }
    // Only reached when the nearby tiles all match this line's.
    return current + randInt(rng, 1, n) * (rng() < 0.5 ? -1 : 1);
  }

  function deal(g, rng) {
    g.v = range(g.n * g.n).map(() => tileValue(rng, g.n));
    g.rows = range(g.n).map((i) => reachableTarget(g, `r${i}`, rng));
    g.cols = range(g.n).map((i) => reachableTarget(g, `c${i}`, rng));
  }

  function newGame(id) {
    const { n } = parseId(id);
    const rng = makeRng(seedFrom(`solvesum:${id}`));
    const g = {
      id, n, v: [], rows: [], cols: [], rng: 0,
      score: 0, lines: 0, swaps: swapBudget(n), used: 0,
      shuffles: SHUFFLES, hints: 0, best: 0, log: '',
      done: false, recorded: false, plan: null,
    };
    deal(g, rng);
    g.rng = rng.state();
    return g;
  }

  function validGame(g, id) {
    const p = parseId(id);
    return g && g.id === id && g.n === p.n && Array.isArray(g.v) && g.v.length === g.n * g.n
      && Array.isArray(g.rows) && g.rows.length === g.n && Array.isArray(g.cols) && g.cols.length === g.n
      && Number.isFinite(g.swaps) && Number.isFinite(g.score)
      && (!g.plan || (Array.isArray(g.plan.steps) && g.plan.steps.length > 0 && typeof g.plan.key === 'string'));
  }

  // Swap two tiles and resolve every solved line, including chains set off by
  // the replacement tiles.
  function applySwap(g, a, b) {
    const rng = makeRng(g.rng);
    [g.v[a], g.v[b]] = [g.v[b], g.v[a]];
    const swapped = g.v.slice();
    const steps = [];
    const fresh = new Set();
    let solved = solvedLines(g);
    while (solved.length && steps.length < 12) {
      steps.push(solved);
      for (const key of solved) {
        for (const idx of lineCells(g.n, key)) {
          g.v[idx] = tileValue(rng, g.n);
          fresh.add(idx);
        }
      }
      for (const key of solved) setTarget(g, key, reachableTarget(g, key, rng));
      solved = solvedLines(g);
    }
    const count = steps.reduce((s, x) => s + x.length, 0);
    const points = LINE_POINTS * count * count;
    g.rng = rng.state();
    g.swaps -= 1;
    g.used += 1;
    g.score += points;
    g.lines += count;
    g.best = Math.max(g.best, count);
    g.log += String(Math.min(count, 3));
    if (g.swaps <= 0) g.done = true;
    return { swapped, steps, count, points, fresh };
  }

  const samePair = (p, a, b) => (p[0] === a && p[1] === b) || (p[0] === b && p[1] === a);

  // Cheapest way to solve one line by sliding tiles straight into it along the
  // crossing lines. A slide only touches its own crossing line, so any mix of
  // slides at different positions is valid; a DP over positions (keyed by how
  // much the line's sum has changed) finds the cheapest mix that hits the target.
  function slidePlan(g, key) {
    const n = g.n;
    const i = Number(key.slice(1));
    const cell = key[0] === 'r' ? (line, pos) => line * n + pos : (line, pos) => pos * n + line;
    const need = targetOf(g, key) - lineSum(g, key);
    let states = new Map([[0, { cost: 0, prev: null }]]);
    for (let pos = 0; pos < n; pos++) {
      const next = new Map(states);
      for (const [delta, st] of states) {
        for (let j = 0; j < n; j++) {
          if (j === i) continue;
          const d = delta + g.v[cell(j, pos)] - g.v[cell(i, pos)];
          const cost = st.cost + Math.abs(j - i);
          const cur = next.get(d);
          if (!cur || cost < cur.cost) next.set(d, { cost, prev: st, pos, from: j });
        }
      }
      states = next;
    }
    const end = states.get(need);
    if (!end || !end.cost) return null;
    const steps = [];
    for (let st = end; st.prev; st = st.prev) {
      const dir = Math.sign(st.from - i);
      for (let k = st.from; k !== i; k -= dir) steps.push([cell(k, st.pos), cell(k - dir, st.pos)]);
    }
    return { key, steps, cost: end.cost };
  }

  // A full route to a solved line: the best single swap if one exists
  // (preferring combos), otherwise the shortest slide plan over all lines.
  function findHint(g) {
    const n = g.n;
    let best = null;
    for (let a = 0; a < n * n; a++) {
      for (const b of [a % n < n - 1 ? a + 1 : -1, a + n < n * n ? a + n : -1]) {
        if (b < 0) continue;
        [g.v[a], g.v[b]] = [g.v[b], g.v[a]];
        const solved = solvedLines(g);
        [g.v[a], g.v[b]] = [g.v[b], g.v[a]];
        if (solved.length > (best ? best.count : 0)) best = { key: solved[0], steps: [[a, b]], count: solved.length };
      }
    }
    if (best) return best;
    for (const key of lineKeys(n)) {
      const plan = slidePlan(g, key);
      if (plan && (!best || plan.cost < best.steps.length)) best = { key, steps: plan.steps, count: 1 };
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // State & persistence
  // ---------------------------------------------------------------------------
  const DEFAULT_SETTINGS = { colors: true, moves: true, sound: false };
  const settings = { ...DEFAULT_SETTINGS, ...store.get('settings', {}) };

  let game = null;
  let selected = null;
  let focusIdx = 0;
  let busy = false;
  let lastFinish = {};
  let newSize = clamp(Number(store.get('lastSize', 6)) || 6, MIN_N, MAX_N);

  function save() {
    store.set(`game:${game.id}`, game);
    store.set('current', game.id);
    const recent = store.get('games', []).filter((x) => x !== game.id);
    recent.unshift(game.id);
    recent.slice(12).forEach((old) => store.del(`game:${old}`));
    store.set('games', recent.slice(0, 12));
  }

  function loadGame(id) {
    const saved = store.get(`game:${id}`, null);
    game = validGame(saved, id) ? saved : newGame(id);
    selected = null;
    focusIdx = 0;
    busy = false;
    const p = parseId(id);
    const search = p.daily ? '' : `?g=${shareCode(p)}`;
    if (location.search !== search) {
      try { history.replaceState(null, '', search || location.pathname); } catch { /* file:// pages can't rewrite the URL */ }
    }
    save();
    buildBoard();
    render();
  }

  function restartGame() {
    store.del(`game:${game.id}`);
    loadGame(game.id);
    say('Fresh start. Same board as before.');
  }

  function recordResult(g) {
    if (g.recorded) return {};
    g.recorded = true;
    const p = parseId(g.id);
    const out = {};

    const daily = store.get('daily', {});
    if (p.daily) {
      if (daily[p.date]) {
        out.replay = daily[p.date].score;
      } else {
        daily[p.date] = { score: g.score, lines: g.lines, best: g.best, log: g.log };
        store.set('daily', daily);
      }
    }

    const bests = store.get('bests', {});
    const prev = bests[g.n];
    if (g.score > 0 && (prev == null || g.score > prev)) {
      bests[g.n] = g.score;
      store.set('bests', bests);
      out.newBest = prev != null;
    }

    const rounds = store.get('rounds', []);
    rounds.unshift({ id: g.id, n: g.n, score: g.score, lines: g.lines, best: g.best, at: Date.now(), replay: out.replay != null });
    store.set('rounds', rounds.slice(0, 40));
    return out;
  }

  function dailyStats() {
    const daily = store.get('daily', {});
    const days = Object.keys(daily).sort();
    const scores = days.map((d) => daily[d].score);
    const dayNum = (key) => {
      const [y, m, d] = key.split('-').map(Number);
      return Math.round(Date.UTC(y, m - 1, d) / 86400000);
    };
    let bestStreak = 0;
    let run = 0;
    days.forEach((d, i) => {
      run = i && dayNum(d) - dayNum(days[i - 1]) === 1 ? run + 1 : 1;
      bestStreak = Math.max(bestStreak, run);
    });
    // The current streak survives until today's puzzle is missed, not just unplayed.
    const today = dayNum(dateKey());
    const last = days.length ? dayNum(days[days.length - 1]) : null;
    const current = last != null && today - last <= 1 ? run : 0;
    return {
      played: days.length,
      streak: current,
      bestStreak,
      best: scores.length ? Math.max(...scores) : 0,
      avg: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0,
    };
  }

  function untilTomorrow() {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const mins = Math.max(1, Math.ceil((next - now) / 60000));
    const h = Math.floor(mins / 60);
    return h ? `${h}h ${pad2(mins % 60)}m` : `${mins}m`;
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  const el = {
    board: $('#board'),
    stage: $('#stage'),
    tiles: $('#tiles'),
    colHeads: $('#colHeads'),
    rowHeads: $('#rowHeads'),
    float: $('#float'),
    hudTitle: $('#hudTitle'),
    hudSub: $('#hudSub'),
    hudScore: $('#hudScore'),
    hudLines: $('#hudLines'),
    hudSwaps: $('#hudSwaps'),
    hintBtn: $('#hintBtn'),
    shuffleBtn: $('#shuffleBtn'),
    shuffleLeft: $('#shuffleLeft'),
    restartBtn: $('#restartBtn'),
    restartLbl: $('#restartLbl'),
    msg: $('#msg'),
    doneBar: $('#doneBar'),
    doneTitle: $('#doneTitle'),
    doneSub: $('#doneSub'),
    footGame: $('#footGame'),
    toast: $('#toast'),
  };

  const tileEls = () => el.tiles.children;

  function headCell() {
    const d = document.createElement('div');
    d.className = 'hdr';
    d.innerHTML = '<span class="hdr-t"></span>';
    return d;
  }

  function buildBoard() {
    const n = game.n;
    el.board.style.setProperty('--n', String(n));
    el.colHeads.replaceChildren(...range(n).map(headCell));
    el.rowHeads.replaceChildren(...range(n).map(headCell));
    el.tiles.replaceChildren(...range(n * n).map((i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tile';
      b.dataset.i = String(i);
      return b;
    }));
    layout();
  }

  const sideBySide = matchMedia('(max-height: 540px) and (orientation: landscape)');

  function layout() {
    const n = game.n;
    const gap = n >= 8 ? 3 : 5;
    const stageW = el.stage.clientWidth - 16;
    const top = el.stage.getBoundingClientRect().top + window.scrollY;
    // Leave room under the board for the buttons unless they sit beside it.
    const below = sideBySide.matches ? 28 : 120;
    const room = Math.max(window.innerHeight - top - below, sideBySide.matches ? 150 : 260);
    const fit = Math.min(stageW, room, 620);
    const cell = clamp(Math.floor((fit - n * gap) / (n + 1)), sideBySide.matches ? 20 : 26, 84);
    el.board.style.setProperty('--gap', `${gap}px`);
    el.board.style.setProperty('--cell', `${cell}px`);
    el.board.style.setProperty('--font', `${clamp(cell * 0.36, 10, 26).toFixed(1)}px`);
  }

  function renderHeads(rows = game.rows, cols = game.cols) {
    const paint = (container, targets, kind) => {
      Array.from(container.children).forEach((d, i) => {
        const key = `${kind}${i}`;
        const target = targets[i];
        d.className = 'hdr';
        if (selected != null && (kind === 'r' ? Math.floor(selected / game.n) : selected % game.n) === i) d.classList.add('focus');
        if (game.plan && game.plan.key === key) d.classList.add('goal');
        d.firstChild.textContent = minus(target);
        if (String(target).length >= 4) d.classList.add('long');
        d.setAttribute('aria-label', `${lineName(key)} target ${target}`);
      });
    };
    paint(el.rowHeads, rows, 'r');
    paint(el.colHeads, cols, 'c');
  }

  function renderTiles(values = game.v) {
    const n = game.n;
    const area = n * n;
    const can = selected != null && settings.moves && !game.done ? neighbours(n, selected) : [];
    Array.from(tileEls()).forEach((b, i) => {
      const v = values[i];
      b.textContent = minus(v);
      let cls = 'tile';
      if (settings.colors && v !== 0) cls += v > 0 ? ' pos' : ' neg';
      if (selected === i) cls += ' selected';
      if (can.includes(i)) cls += ' can-swap';
      if (game.plan && game.plan.steps[0].includes(i)) cls += ' hint';
      if (String(v).length >= 4) cls += ' long';
      b.className = cls;
      b.style.setProperty('--f', (Math.abs(v) / area).toFixed(3));
      b.tabIndex = i === focusIdx ? 0 : -1;
      b.disabled = game.done;
      b.setAttribute('aria-pressed', String(selected === i));
      b.setAttribute('aria-label', `Row ${Math.floor(i / n) + 1}, column ${(i % n) + 1}: ${v}${selected === i ? ', selected' : ''}`);
    });
  }

  let shownScore = null;
  function renderHud() {
    const p = parseId(game.id);
    el.hudTitle.textContent = gameTitle(game.id);
    el.hudSub.textContent = gameSub(game.id);
    el.footGame.textContent = p.daily ? `Daily ${prettyDate(p.date, { month: 'short', day: 'numeric', year: 'numeric' })}` : `Game ${shareCode(p)}`;
    if (shownScore !== null && game.score > shownScore) bump(el.hudScore);
    shownScore = game.score;
    el.hudScore.textContent = String(game.score);
    el.hudLines.textContent = String(game.lines);
    el.hudSwaps.textContent = String(game.swaps);
    el.hudSwaps.classList.toggle('low', game.swaps <= 5);

    el.hintBtn.disabled = game.done || busy || (!game.plan && game.swaps <= HINT_COST);
    el.shuffleBtn.disabled = game.done || busy || game.shuffles <= 0;
    el.shuffleLeft.textContent = `${game.shuffles} left`;
    el.board.classList.toggle('done', game.done);

    el.doneBar.hidden = !game.done;
    if (game.done) {
      el.doneTitle.textContent = p.daily ? 'Daily complete' : 'Out of swaps';
      el.doneSub.textContent = `${game.score} points · ${plural(game.lines, 'line')}${p.daily ? ` · next daily in ${untilTomorrow()}` : ''}`;
    }
  }

  function render() {
    renderHeads();
    renderTiles();
    renderHud();
    if (!el.msg.textContent) say(defaultMsg());
  }

  function defaultMsg() {
    if (game.done) return 'Round over. Start a new game any time.';
    if (selected != null) return 'Now tap a neighbouring tile to swap.';
    if (game.plan) return `Hint: swap the glowing tiles. ${plural(game.plan.steps.length, 'swap')} to solve ${lineName(game.plan.key)}.`;
    return game.used ? 'Tap a tile, then a neighbour to swap.' : 'Tap a tile, then a neighbour to swap. Match a line to its target.';
  }

  function say(text) {
    el.msg.textContent = text;
  }

  function restartAnim(node, cls) {
    node.classList.remove(cls);
    void node.offsetWidth;
    node.classList.add(cls);
  }

  function bump(node) {
    restartAnim(node, 'bump');
  }

  function focusTile(i) {
    focusIdx = i;
    Array.from(tileEls()).forEach((b, j) => { b.tabIndex = j === i ? 0 : -1; });
    tileEls()[i]?.focus({ preventScroll: true });
  }

  function slide(a, b) {
    if (reducedMotion()) return;
    const n = game.n;
    const step = parseFloat(getComputedStyle(el.board).getPropertyValue('--cell')) + parseFloat(getComputedStyle(el.board).getPropertyValue('--gap'));
    const move = (to, from) => {
      const t = tileEls()[to];
      t.style.setProperty('--dx', `${((from % n) - (to % n)) * step}px`);
      t.style.setProperty('--dy', `${(Math.floor(from / n) - Math.floor(to / n)) * step}px`);
      restartAnim(t, 'slide');
    };
    move(a, b);
    move(b, a);
  }

  function markLines(keys) {
    for (const key of keys) {
      for (const idx of lineCells(game.n, key)) restartAnim(tileEls()[idx], 'hit');
      const heads = key[0] === 'r' ? el.rowHeads : el.colHeads;
      restartAnim(heads.children[Number(key.slice(1))], 'hit');
    }
  }

  function floatScore(points, count, chain) {
    el.float.replaceChildren();
    const big = document.createElement('strong');
    big.textContent = `+${points}`;
    el.float.append(big);
    if (count > 1) {
      const tag = document.createElement('span');
      tag.textContent = chain ? `Chain ×${count}` : `Combo ×${count}`;
      el.float.append(tag);
    }
    restartAnim(el.float, 'show');
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  function select(i) {
    selected = i;
    renderTiles();
    renderHeads();
    say(defaultMsg());
    if (i != null) sound('pick');
  }

  function onTile(i) {
    if (busy || game.done) return;
    focusIdx = i;
    if (selected === null) select(i);
    else if (selected === i) select(null);
    else if (isAdjacent(game.n, selected, i)) doSwap(selected, i);
    else select(i);
    focusTile(i);
  }

  function doSwap(a, b) {
    if (busy || game.done) return;
    const rows = game.rows.slice();
    const cols = game.cols.slice();
    const plan = game.plan;
    const followed = plan && samePair(plan.steps[0], a, b);
    const res = applySwap(game, a, b);
    selected = null;
    let planMsg = '';
    if (plan && !followed) {
      game.plan = null;
      planMsg = ' Hint cancelled.';
    } else if (plan) {
      plan.steps.shift();
      const solvedGoal = res.steps.flat().includes(plan.key);
      if (solvedGoal || !plan.steps.length) {
        game.plan = null;
      } else if (res.count) {
        // Another line solved on the way and reshuffled tiles: re-plan for free.
        const again = slidePlan(game, plan.key);
        game.plan = again && { key: plan.key, steps: again.steps, count: 1 };
        planMsg = again ? ` Hint updated: ${plural(again.steps.length, 'swap')} to go.` : ' The board changed, so the hint ended.';
      } else {
        planMsg = ` Hint: ${plural(plan.steps.length, 'more swap')} to solve ${lineName(plan.key)}.`;
      }
    }
    if (game.done) game.plan = null;
    save();

    if (!res.count) {
      renderTiles();
      renderHeads();
      renderHud();
      slide(a, b);
      sound('swap');
      say(game.done ? 'Out of swaps!' : planMsg.trim() || `No line yet. ${plural(game.swaps, 'swap')} left.`);
      if (game.done) finishRound();
      return;
    }

    busy = true;
    renderTiles(res.swapped);
    renderHeads(rows, cols);
    renderHud();
    slide(a, b);
    sound('swap');

    const quick = reducedMotion();
    setTimeout(() => {
      markLines(res.steps[0]);
      floatScore(res.points, res.count, res.steps.length > 1);
      restartAnim(el.tiles, 'shake');
      sound('solve', res.count);
      setTimeout(() => {
        busy = false;
        renderTiles();
        renderHeads();
        renderHud();
        res.fresh.forEach((idx) => restartAnim(tileEls()[idx], 'fresh'));
        res.steps.flat().forEach((key) => {
          const heads = key[0] === 'r' ? el.rowHeads : el.colHeads;
          restartAnim(heads.children[Number(key.slice(1))], 'fresh');
        });
        const names = res.steps[0].map(lineName);
        const what = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
        const chain = res.steps.length > 1 ? ` Chain reaction solved ${plural(res.count - res.steps[0].length, 'more line')}.` : '';
        say(`Solved ${what}! +${res.points}.${chain}${game.done ? ' Out of swaps!' : planMsg}`);
        if (el.tiles.contains(document.activeElement)) focusTile(focusIdx);
        if (game.done) finishRound();
      }, quick ? 0 : 480);
    }, quick ? 0 : 170);
  }

  function useHint() {
    if (busy || game.done) return;
    if (game.plan) {
      say(`Hint: ${plural(game.plan.steps.length, 'swap')} left to solve ${lineName(game.plan.key)}. Follow the glowing tiles.`);
      return;
    }
    if (game.swaps <= HINT_COST) return;
    const found = findHint(game);
    if (!found) {
      say('No line can be solved from here. Try a shuffle. That hint was free.');
      return;
    }
    game.swaps -= HINT_COST;
    game.hints += 1;
    game.log += 'h';
    game.plan = found;
    selected = null;
    save();
    renderTiles();
    renderHeads();
    renderHud();
    sound('pick');
    const len = found.steps.length;
    const room = len > game.swaps ? ` You only have ${plural(game.swaps, 'swap')} left, though.` : '';
    say(len === 1
      ? `Hint: swap the glowing tiles to solve ${found.count > 1 ? plural(found.count, 'line') : lineName(found.key)}.`
      : `Hint: ${len} swaps solve ${lineName(found.key)}. Swap the glowing tiles, and the next pair will light up.${room}`);
  }

  function useShuffle() {
    if (busy || game.done || game.shuffles <= 0) return;
    const rng = makeRng(game.rng);
    deal(game, rng);
    game.rng = rng.state();
    game.shuffles -= 1;
    game.log += 's';
    selected = null;
    game.plan = null;
    save();
    render();
    Array.from(tileEls()).forEach((t) => restartAnim(t, 'fresh'));
    sound('shuffle');
    say(`New board dealt. ${game.shuffles ? `${plural(game.shuffles, 'shuffle')} left.` : 'That was your last shuffle.'}`);
  }

  let restartArmed = 0;
  function onRestart() {
    if (busy) return;
    if (!game.used && !game.hints && game.shuffles === SHUFFLES) {
      restartGame();
      return;
    }
    if (restartArmed) {
      clearTimeout(restartArmed);
      restartArmed = 0;
      el.restartLbl.textContent = 'Restart';
      el.restartBtn.classList.remove('armed');
      restartGame();
      return;
    }
    el.restartLbl.textContent = 'Tap to confirm';
    el.restartBtn.classList.add('armed');
    restartArmed = setTimeout(() => {
      restartArmed = 0;
      el.restartLbl.textContent = 'Restart';
      el.restartBtn.classList.remove('armed');
    }, 3000);
  }

  function finishRound() {
    const res = recordResult(game);
    lastFinish = res;
    save();
    renderHud();
    setTimeout(() => {
      sound('finish');
      open('finish');
      if (res.newBest || (parseId(game.id).daily && res.replay == null && game.score > 0)) confetti(res.newBest ? 140 : 80);
    }, reducedMotion() ? 0 : 650);
  }

  function shareText() {
    const p = parseId(game.id);
    const head = p.daily
      ? `SolveSum Daily · ${prettyDate(p.date, { month: 'short', day: 'numeric', year: 'numeric' })}`
      : `SolveSum ${p.n}×${p.n} · game ${shareCode(p)}`;
    const line = `${game.score} pts · ${plural(game.lines, 'line')} · best swap ×${game.best || 0}`;
    const chars = Array.from(game.log, (c) => LOG_EMOJI[c] || '');
    const rows = [];
    for (let i = 0; i < chars.length; i += 10) rows.push(chars.slice(i, i + 10).join(''));
    return `${head}\n${line}\n${rows.join('\n')}\n${gameUrl(game.id)}`;
  }

  function fillFinish(res = {}) {
    const p = parseId(game.id);
    $('#finTitle').textContent = p.daily ? 'Daily complete' : 'Round complete';
    $('#finScore').textContent = String(game.score);
    const bits = [plural(game.lines, 'line'), `best swap ×${game.best || 0}`];
    if (game.hints) bits.push(plural(game.hints, 'hint'));
    $('#finLine').textContent = bits.join(' · ');
    const badge = $('#finBadge');
    const best = store.get('bests', {})[game.n];
    if (res.newBest) badge.textContent = `New best for ${game.n}×${game.n}!`;
    else if (res.replay != null) badge.textContent = `Replay. Your first result today (${res.replay}) is the one that counts.`;
    else if (best != null && best > game.score) badge.textContent = `Your best on ${game.n}×${game.n} is ${best}.`;
    else badge.textContent = '';
    badge.hidden = !badge.textContent;
    const chars = Array.from(game.log, (c) => LOG_EMOJI[c] || '');
    const rows = [];
    for (let i = 0; i < chars.length; i += 10) rows.push(chars.slice(i, i + 10).join(''));
    $('#finEmoji').textContent = rows.join('\n');
    $('#finNext').textContent = p.daily ? `Next daily puzzle in ${untilTomorrow()}.` : `Share code ${shareCode(p)} to challenge a friend on this board.`;
  }

  // ---------------------------------------------------------------------------
  // Dialogs
  // ---------------------------------------------------------------------------
  function open(name) {
    const dlg = $(`#dlg-${name}`);
    if (name === 'stats') fillStats();
    if (name === 'new') fillNew();
    if (name === 'settings') fillSettings();
    if (name === 'finish') fillFinish(lastFinish);
    $$('dialog[open]').forEach((d) => d !== dlg && d.close());
    if (!dlg.open) dlg.showModal();
  }

  function fillStats() {
    const s = dailyStats();
    const tiles = [
      ['Dailies played', s.played],
      ['Current streak', s.streak],
      ['Best streak', s.bestStreak],
      ['Best daily', s.best],
    ];
    $('#statGrid').innerHTML = tiles.map(([k, v]) => `<div class="stat"><strong>${esc(v)}</strong><span>${esc(k)}</span></div>`).join('');
    const today = store.get('daily', {})[dateKey()];
    $('#statNext').textContent = today
      ? `Today's score: ${today.score}. Next daily in ${untilTomorrow()}.${s.played > 1 ? ` Average ${s.avg}.` : ''}`
      : `Today's daily is waiting.${s.played ? ` Average daily score ${s.avg}.` : ''}`;

    const bests = store.get('bests', {});
    $('#sizeBests').innerHTML = range(MAX_N - MIN_N + 1).map((k) => {
      const n = k + MIN_N;
      const b = bests[n];
      return `<div class="size-best${b == null ? ' none' : ''}"><span>${n}×${n}</span><strong>${b == null ? '—' : esc(b)}</strong></div>`;
    }).join('');

    const rounds = store.get('rounds', []);
    $('#recentRounds').innerHTML = rounds.length ? `
      <div class="table-scroll"><table class="rounds">
        <thead><tr><th>When</th><th>Game</th><th class="num">Lines</th><th class="num">Score</th></tr></thead>
        <tbody>${rounds.slice(0, 15).map((r) => {
          const p = parseId(r.id);
          const when = new Date(r.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
          const name = p ? (p.daily ? `Daily ${r.replay ? '(replay)' : ''}` : `${shareCode(p)}`) : '?';
          return `<tr><td>${esc(when)}</td><td>${esc(name)} <span class="muted">${r.n}×${r.n}</span></td><td class="num">${esc(r.lines)}</td><td class="num"><b>${esc(r.score)}</b></td></tr>`;
        }).join('')}</tbody>
      </table></div>` : '<p class="empty">No finished rounds yet.</p>';
  }

  function fillNew() {
    const d = store.get('daily', {})[dateKey()];
    const saved = store.get(`game:${dailyId()}`, null);
    $('#dailyStatus').textContent = d
      ? `Done today: ${d.score} points. Replays don't count.`
      : saved && saved.used
        ? `In progress: ${saved.score} points, ${plural(saved.swaps, 'swap')} left.`
        : `Same ${DAILY_N}×${DAILY_N} board for everyone today.`;
    $('#playDaily').textContent = saved && saved.used && !saved.done ? 'Resume daily' : 'Play daily';
    $('#sizeValue').textContent = `${newSize}×${newSize}`;
    $('#sizeDown').disabled = newSize <= MIN_N;
    $('#sizeUp').disabled = newSize >= MAX_N;
    const p = parseId(game.id);
    $('#currentGameInfo').textContent = p.daily
      ? `Daily puzzle for ${prettyDate(p.date)}.`
      : `Code ${shareCode(p)}. Anyone with the link gets this board.`;
  }

  function fillSettings() {
    $$('[data-setting]').forEach((input) => { input.checked = !!settings[input.dataset.setting]; });
  }

  // ---------------------------------------------------------------------------
  // Toast, confetti, sound
  // ---------------------------------------------------------------------------
  let toastTimer = 0;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2800);
  }

  function confetti(count) {
    if (reducedMotion()) return;
    const layer = document.createElement('div');
    layer.className = 'confetti';
    const colors = ['#1f6feb', '#16a34a', '#dc2626', '#f5c542', '#8b5cf6'];
    for (let i = 0; i < count; i++) {
      const s = document.createElement('span');
      s.style.setProperty('left', `${Math.random() * 100}%`);
      s.style.setProperty('background', colors[i % colors.length]);
      s.style.setProperty('--x', `${(Math.random() - 0.5) * 240}px`);
      s.style.setProperty('--r', `${(Math.random() - 0.5) * 1080}deg`);
      s.style.setProperty('--d', `${1.6 + Math.random() * 1.6}s`);
      s.style.setProperty('animation-delay', `${Math.random() * 0.4}s`);
      layer.append(s);
    }
    document.body.append(layer);
    setTimeout(() => layer.remove(), 4000);
  }

  let audio = null;
  function tone(freq, start, dur, type = 'sine', vol = 0.05) {
    const t = audio.currentTime + start;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
  function sound(kind, count = 1) {
    if (!settings.sound) return;
    try {
      audio = audio || new AudioContext();
      if (audio.state === 'suspended') audio.resume();
      if (kind === 'pick') tone(660, 0, 0.06, 'triangle', 0.03);
      else if (kind === 'swap') tone(420, 0, 0.08, 'triangle', 0.04);
      else if (kind === 'shuffle') [300, 380, 460].forEach((f, i) => tone(f, i * 0.04, 0.08, 'triangle', 0.03));
      else if (kind === 'solve') [523, 659, 784, 1047, 1319].slice(0, 2 + Math.min(count, 3)).forEach((f, i) => tone(f, i * 0.07, 0.22));
      else if (kind === 'finish') [392, 523, 659, 784].forEach((f, i) => tone(f, i * 0.11, 0.35, 'sine', 0.05));
    } catch { /* audio unavailable */ }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.className = 'offscreen';
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* unsupported */ }
      ta.remove();
      return ok;
    }
  }

  async function share() {
    const text = shareText();
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try { await navigator.share({ text }); return; } catch { /* fall through to copy */ }
    }
    toast((await copyText(text)) ? 'Result copied to clipboard.' : 'Could not copy. Try again.');
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  let drag = null;
  let swallowClick = false;

  el.tiles.addEventListener('pointerdown', (e) => {
    swallowClick = false;
    const t = e.target.closest('.tile');
    if (!t || e.button > 0 || busy || game.done) return;
    drag = { i: Number(t.dataset.i), x: e.clientX, y: e.clientY, id: e.pointerId };
  });
  el.tiles.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    const cell = parseFloat(getComputedStyle(el.board).getPropertyValue('--cell'));
    if (Math.hypot(dx, dy) < cell * 0.4) return;
    const n = game.n;
    const from = drag.i;
    drag = null;
    let to;
    if (Math.abs(dx) > Math.abs(dy)) to = dx > 0 ? (from % n < n - 1 ? from + 1 : -1) : (from % n > 0 ? from - 1 : -1);
    else to = dy > 0 ? from + n : from - n;
    if (to < 0 || to >= n * n) return;
    swallowClick = true;
    focusIdx = to;
    doSwap(from, to);
  });
  const endDrag = () => { drag = null; };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  el.tiles.addEventListener('click', (e) => {
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    const t = e.target.closest('.tile');
    if (t) onTile(Number(t.dataset.i));
  });

  el.tiles.addEventListener('keydown', (e) => {
    const t = e.target.closest('.tile');
    if (!t) return;
    const n = game.n;
    const i = Number(t.dataset.i);
    if (e.key === 'Escape' && selected != null) {
      e.preventDefault();
      select(null);
      return;
    }
    const moves = {
      ArrowLeft: i % n ? i - 1 : -1,
      ArrowRight: i % n < n - 1 ? i + 1 : -1,
      ArrowUp: i - n,
      ArrowDown: i + n,
      Home: i - (i % n),
      End: i - (i % n) + n - 1,
    };
    if (!(e.key in moves)) return;
    e.preventDefault();
    const to = moves[e.key];
    if (to >= 0 && to < n * n) focusTile(to);
  });

  el.tiles.addEventListener('animationend', (e) => {
    if (e.target === el.tiles) el.tiles.classList.remove('shake');
    else e.target.classList.remove('slide', 'hit', 'fresh');
  });
  el.board.addEventListener('animationend', (e) => {
    if (e.target.classList.contains('hdr')) e.target.classList.remove('hit', 'fresh');
  });
  el.hudScore.addEventListener('animationend', () => el.hudScore.classList.remove('bump'));

  el.hintBtn.addEventListener('click', useHint);
  el.shuffleBtn.addEventListener('click', useShuffle);
  el.restartBtn.addEventListener('click', onRestart);

  $$('[data-open]').forEach((b) => b.addEventListener('click', () => open(b.dataset.open)));
  $$('dialog').forEach((dlg) => {
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg || e.target.closest('[data-close]')) dlg.close();
    });
  });

  $('#playDaily').addEventListener('click', () => {
    $('#dlg-new').close();
    loadGame(dailyId());
    say(defaultMsg());
  });
  const setNewSize = (n) => {
    newSize = clamp(n, MIN_N, MAX_N);
    store.set('lastSize', newSize);
    fillNew();
  };
  $('#sizeDown').addEventListener('click', () => setNewSize(newSize - 1));
  $('#sizeUp').addEventListener('click', () => setNewSize(newSize + 1));
  $('#playRandom').addEventListener('click', () => {
    $('#dlg-new').close();
    loadGame(customId(randomCode(), newSize));
    say(defaultMsg());
    toast(`New game ${shareCode(parseId(game.id))}. Share the link to challenge a friend.`);
  });
  $('#codeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#codeInput');
    const id = parseCode(input.value);
    if (!id) {
      toast('Codes look like K3F9QZ-6: letters and digits, a dash, then the grid size (2–10).');
      input.focus();
      return;
    }
    input.value = '';
    $('#dlg-new').close();
    loadGame(id);
    say(defaultMsg());
  });
  $('#copyLink').addEventListener('click', async () => {
    toast((await copyText(gameUrl(game.id))) ? 'Game link copied.' : 'Could not copy the link.');
  });
  $('#shareBtn').addEventListener('click', share);

  $$('[data-setting]').forEach((input) => {
    input.addEventListener('change', () => {
      settings[input.dataset.setting] = input.checked;
      store.set('settings', settings);
      renderTiles();
      renderHeads();
      if (input.dataset.setting === 'sound' && input.checked) sound('solve', 1);
    });
  });

  let resizeFrame = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(layout);
  });

  // A tab left open overnight rolls over to the new daily on return.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const p = parseId(game.id);
    if (p.daily && p.date !== dateKey() && (game.done || !game.used) && !$('dialog[open]')) {
      loadGame(dailyId());
      toast('A new daily puzzle is ready.');
    }
  });

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  function startId() {
    const q = new URLSearchParams(location.search).get('g');
    if (q) {
      const id = parseCode(q);
      if (id) return id;
      setTimeout(() => toast("That game code isn't valid, so here's today's daily."), 300);
      return dailyId();
    }
    // Resume an unfinished coded game; otherwise go to today's daily.
    const current = store.get('current', null);
    const p = current && parseId(current);
    if (p && !p.daily) {
      const saved = store.get(`game:${current}`, null);
      if (validGame(saved, current) && !saved.done) return current;
    }
    return dailyId();
  }

  loadGame(startId());

  if (!store.get('seenHelp', false)) {
    store.set('seenHelp', true);
    open('help');
  }
})();
