'use strict';
(() => {
const $ = (s, r = document) => r.querySelector(s);
const API = 'https://api.github.com';
const CIRCLE = 'M41 9 C30 4 13 9 8 24 C3 40 15 54 31 54 C46 54 56 42 53 26 C51 14 41 7 28 8';
const SLASH = 'M12 50 C24 37 37 22 50 8';
const STAT_FLUSH_AT = 5; // 풀이 기록은 이 개수만큼 모이면 한 번에 커밋

/* ================= utils ================= */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// 서식: **굵게**, __밑줄__ (줄을 넘지 않음, 중첩 가능)
const fmt = s => esc(s).replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>').replace(/__([^\n]+?)__/g, '<u>$1</u>');
const hasMarks = s => /\*\*[^\n]+?\*\*|__[^\n]+?__/.test(s);
const plain = s => String(s || '').replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim();
const fold = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); // 검색: á→a, ñ→n
const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clone = o => (o == null ? o : JSON.parse(JSON.stringify(o)));
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
function b64enc(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64dec(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
const safeStore = name => { try { return window[name]; } catch (e) { return null; } };
const LS = safeStore('localStorage'), SS = safeStore('sessionStorage');
const kv = {
  get(st, k) { try { const v = st && st.getItem(k); return v == null ? null : JSON.parse(v); } catch (e) { return null; } },
  set(st, k, v) { try { st && st.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(st, k) { try { st && st.removeItem(k); } catch (e) {} },
};
let toastT;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2800);
}

/* ================= config (토큰만 기기에 저장) ================= */
let repoCfg = kv.get(LS, 'qbank.repo');            // { owner, repo, branch, private }
let token = kv.get(LS, 'qbank.token') || kv.get(SS, 'qbank.token');
let cfg = repoCfg && token ? { ...repoCfg, token } : null;

/* ================= data (메모리에만) ================= */
const files = {
  problems: { path: 'problems.json', data: null, sha: null, loaded: false },
  stats: { path: 'stats.json', data: null, sha: null, loaded: false },
};
let pending = {}; // 아직 커밋 안 된 풀이 기록: id -> { tries, correct, last, lastAt }

// 파일 형식 <-> 앱 내부 형식. 파일의 answer는 1부터 시작하는 보기 번호.
function fromFile(data) {
  const arr = data && Array.isArray(data.problems) ? data.problems : [];
  const seen = new Set();
  return arr.map((raw, i) => {
    const p = raw && typeof raw === 'object' ? raw : {};
    const choices = Array.isArray(p.choices) ? p.choices.map(c => String(c ?? '')) : [];
    let id = String(p.id || ('h' + hash(String(p.question || '') + '#' + i)));
    while (seen.has(id)) id += '_';
    seen.add(id);
    const n = parseInt(p.answer, 10);
    return {
      id, question: String(p.question || ''), choices,
      answer: n >= 1 && n <= choices.length ? n - 1 : 0,
      explanation: String(p.explanation || ''),
      createdAt: Number(p.createdAt) || 0, updatedAt: Number(p.updatedAt) || 0,
    };
  });
}
function toFile(list) {
  return {
    version: 2,
    problems: list.map(p => ({
      id: p.id, question: p.question, choices: p.choices, answer: p.answer + 1,
      explanation: p.explanation, createdAt: p.createdAt, updatedAt: p.updatedAt,
    })),
  };
}
const upsert = (list, p) => { const i = list.findIndex(x => x.id === p.id); if (i >= 0) list[i] = p; else list.push(p); return list; };
const playable = p => p.choices.length >= 2;
const statsFrom = d => (d && d.stats && typeof d.stats === 'object' ? d.stats : {});
function mergeStats(base, delta) {
  const out = { ...base };
  for (const [id, d] of Object.entries(delta)) {
    const b = out[id] || {};
    const newer = d.lastAt >= (b.lastAt || 0);
    out[id] = {
      tries: (b.tries || 0) + d.tries, correct: (b.correct || 0) + d.correct,
      last: newer ? d.last : (b.last || null), lastAt: newer ? d.lastAt : (b.lastAt || 0),
    };
  }
  return out;
}
function statOf(id) {
  const b = statsFrom(files.stats.data)[id] || {}, d = pending[id];
  let last = b.last || null, lastAt = b.lastAt || 0;
  if (d && d.lastAt >= lastAt) { last = d.last; lastAt = d.lastAt; }
  return { tries: (b.tries || 0) + (d ? d.tries : 0), correct: (b.correct || 0) + (d ? d.correct : 0), last, lastAt };
}
const pendingCount = () => Object.values(pending).reduce((a, d) => a + d.tries, 0);

const state = {
  items: [], num: new Map(), ready: false, loadError: '',
  view: 'bank', query: '', openId: null,
  setup: { scope: 'all', shuffle: true }, session: null,
};
function recompute() {
  state.items = fromFile(files.problems.data);
  state.num = new Map(state.items.map((p, i) => [p.id, i + 1]));
}

/* ================= GitHub Contents API ================= */
class GhError extends Error { constructor(kind, msg, status) { super(msg); this.kind = kind; this.status = status; } }
const repoPath = c => `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}`;
async function api(path, { method = 'GET', body, raw = false, c = cfg } = {}) {
  try {
    return await fetch(API + path, {
      method, cache: 'no-store',
      headers: {
        Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        Authorization: `Bearer ${c.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new GhError('network', '네트워크에 연결할 수 없어요.');
  }
}
async function fail(res) {
  let msg = '';
  try { msg = (await res.json()).message || ''; } catch (e) {}
  const s = res.status;
  if (s === 401) return new GhError('auth', '토큰이 만료됐거나 올바르지 않아요. 설정에서 토큰을 다시 입력해 주세요.', s);
  if (s === 429 || (s === 403 && res.headers.get('x-ratelimit-remaining') === '0')) return new GhError('rate', 'GitHub API 요청 한도에 걸렸어요. 잠시 후 다시 시도해 주세요.', s);
  if (s === 403) return new GhError('perm', '토큰에 이 저장소의 Contents 쓰기 권한이 없어요.', s);
  if (s === 404) return new GhError('notfound', '저장소나 브랜치를 찾을 수 없어요. 이름과 토큰의 저장소 접근 범위를 확인해 주세요.', s);
  if (s >= 500) return new GhError('server', 'GitHub 서버 오류예요. 잠시 후 다시 시도해 주세요.', s);
  return new GhError('other', `GitHub 요청이 실패했어요 (HTTP ${s}${msg ? ': ' + msg : ''}).`, s);
}
const refQ = () => (cfg.branch ? `?ref=${encodeURIComponent(cfg.branch)}` : '');
async function readFile(key) {
  const f = files[key];
  const res = await api(`${repoPath(cfg)}/contents/${f.path}${refQ()}`);
  if (res.status === 404) return { data: null, sha: null };
  if (!res.ok) throw await fail(res);
  const meta = await res.json();
  if (Array.isArray(meta) || meta.type !== 'file') throw new GhError('other', `${f.path}가 파일이 아니에요.`);
  let text;
  if (meta.encoding === 'base64' && meta.content) text = b64dec(meta.content);
  else if (meta.size === 0) text = '';
  else { // 1MB 넘는 파일은 raw로 다시 받는다
    const r2 = await api(`${repoPath(cfg)}/contents/${f.path}${refQ()}`, { raw: true });
    if (!r2.ok) throw await fail(r2);
    text = await r2.text();
  }
  if (!text.trim()) return { data: null, sha: meta.sha };
  try { return { data: JSON.parse(text), sha: meta.sha }; }
  catch (e) { throw new GhError('parse', `${f.path}의 JSON 형식이 올바르지 않아요. 저장소에서 파일을 확인해 주세요.`); }
}
async function writeFile(key, data, sha, message) {
  const body = { message, content: b64enc(JSON.stringify(data, null, 2) + '\n') };
  if (sha) body.sha = sha;
  if (cfg.branch) body.branch = cfg.branch;
  const res = await api(`${repoPath(cfg)}/contents/${files[key].path}`, { method: 'PUT', body });
  if (res.ok) { const j = await res.json(); return { ok: true, sha: j.content.sha }; }
  if (res.status === 409 || res.status === 422) return { ok: false, status: res.status }; // sha 불일치
  throw await fail(res);
}
// 최신 파일에 변경을 적용해 커밋. sha가 어긋나면 다시 받아서 재시도.
async function commit(key, mutate, message) {
  const f = files[key];
  let base = f.loaded ? { data: f.data, sha: f.sha } : await readFile(key);
  let status = 0;
  for (let i = 0; i < 4; i++) {
    const next = mutate(clone(base.data));
    const r = await writeFile(key, next, base.sha, message);
    if (r.ok) { f.data = next; f.sha = r.sha; f.loaded = true; return; }
    status = r.status;
    await sleep(400 * (i + 1) + Math.random() * 300);
    base = await readFile(key);
  }
  throw new GhError('conflict', `저장이 계속 거절됐어요 (HTTP ${status}). 잠시 후 다시 시도해 주세요.`, status);
}

/* ================= sync ================= */
let lock = Promise.resolve();
function exclusive(fn) { const run = lock.then(fn); lock = run.catch(() => {}); return run; }
let syncState = 'idle', syncMsg = '', lastSync = 0;
function setSync(s, msg = '') { syncState = s; syncMsg = msg; renderSync(); }
function renderSync() {
  const b = $('#syncBtn');
  let label, st = syncState;
  if (!cfg) { label = '연결 안 됨'; st = 'error'; }
  else if (syncState === 'loading') label = '불러오는 중…';
  else if (syncState === 'saving') label = '저장 중…';
  else if (syncState === 'error') label = '동기화 오류';
  else { const n = pendingCount(); label = n ? `기록 대기 ${n}` : '동기화됨'; }
  b.textContent = label; b.dataset.state = st; b.title = syncMsg;
  if (!$('#settings').hidden) renderSettingsInfo();
}
function load() {
  if (!cfg) return Promise.resolve();
  return exclusive(async () => {
    setSync('loading');
    if (!state.ready) render();
    try {
      const [p, s] = await Promise.all([readFile('problems'), readFile('stats')]);
      Object.assign(files.problems, p, { loaded: true });
      Object.assign(files.stats, s, { loaded: true });
      state.loadError = ''; lastSync = Date.now();
      setSync('ok');
    } catch (e) {
      if (!files.problems.loaded) state.loadError = e.message;
      setSync('error', e.message);
      if (files.problems.loaded) toast(e.message);
    } finally {
      state.ready = true; recompute(); render();
    }
  });
}
async function mutateProblems(fn, message) {
  setSync('saving');
  try {
    await exclusive(() => commit('problems', d => toFile(fn(fromFile(d))), message));
    lastSync = Date.now(); setSync('ok');
  } catch (e) {
    setSync('error', e.message);
    throw e;
  } finally {
    recompute(); render();
  }
}
function flushStats() {
  if (!cfg) return Promise.resolve();
  return exclusive(async () => {
    const ids = Object.keys(pending);
    if (!ids.length) return;
    const snap = clone(pending);
    const n = Object.values(snap).reduce((a, d) => a + d.tries, 0);
    setSync('saving');
    try {
      await commit('stats', d => ({ version: 1, stats: mergeStats(statsFrom(d), snap) }), `풀이 기록 ${n}건`);
      for (const id of ids) { // 커밋하는 동안 새로 쌓인 기록은 남긴다
        const cur = pending[id], s = snap[id];
        if (!cur) continue;
        const t = cur.tries - s.tries;
        if (t <= 0) delete pending[id];
        else pending[id] = { tries: t, correct: cur.correct - s.correct, last: cur.last, lastAt: cur.lastAt };
      }
      lastSync = Date.now(); setSync('ok');
    } catch (e) {
      setSync('error', e.message);
      toast('풀이 기록을 저장하지 못했어요. 다음 기회에 다시 시도할게요.');
    }
    if (state.view === 'bank') renderBank();
  });
}
function recordStat(id, ok) {
  const d = pending[id] || { tries: 0, correct: 0 };
  pending[id] = { tries: d.tries + 1, correct: d.correct + (ok ? 1 : 0), last: ok ? 'o' : 'x', lastAt: Date.now() };
  renderSync();
  if (pendingCount() >= STAT_FLUSH_AT) flushStats();
}
const label = p => plain(p.question).slice(0, 40);

/* ================= views ================= */
const els = { bank: $('#bank'), solve: $('#solve'), toolbar: $('#toolbar'), list: $('#list'), empty: $('#empty'), q: $('#q') };
const connectHTML = () => `<div class="empty"><p>${repoCfg && !token ? '토큰을 다시 입력해 주세요.' : '문제를 저장할 GitHub 저장소를 연결해 주세요.'}</p><button class="btn primary" data-action="settings">${repoCfg && !token ? '토큰 입력' : '연결하기'}</button></div>`;
function setView(v) {
  state.view = v;
  els.bank.hidden = v !== 'bank'; els.solve.hidden = v !== 'solve';
  document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.view === v)));
  if (v === 'bank') renderBank();
  else if (!state.session || state.session.phase === 'setup') renderSetup();
  window.scrollTo(0, 0);
}
function render() {
  if (state.view === 'bank') renderBank();
  else if (!state.session || state.session.phase === 'setup') renderSetup();
  renderSync();
}
function choicesHTML(p) {
  return `<ol class="dchoices">${p.choices.map((c, i) => {
    const a = i === p.answer;
    return `<li class="${a ? 'is-answer' : ''}"><span class="bubble${a ? ' filled' : ''}">${i + 1}</span><span class="rich">${fmt(c)}</span><span class="tag">${a ? '정답' : ''}</span></li>`;
  }).join('')}</ol>`;
}

/* bank */
function renderBank() {
  els.toolbar.hidden = !cfg || !state.ready || (!!state.loadError && !state.items.length);
  if (!cfg) { els.list.innerHTML = ''; els.empty.innerHTML = connectHTML(); return; }
  if (!state.ready) { els.list.innerHTML = ''; els.empty.innerHTML = '<p class="muted empty">불러오는 중…</p>'; return; }
  if (!state.items.length) {
    els.list.innerHTML = '';
    els.empty.innerHTML = state.loadError
      ? `<div class="empty"><p>문제를 불러오지 못했어요. ${esc(state.loadError)}</p><div class="row-actions"><button class="btn primary" data-action="reload">다시 불러오기</button><button class="btn" data-action="settings">설정</button></div></div>`
      : '<div class="empty"><p>아직 등록한 문제가 없어요.</p><button class="btn primary" data-action="new">첫 문제 등록하기</button></div>';
    return;
  }
  const q = fold(state.query.trim());
  const hay = p => fold(plain([p.question, p.explanation, ...p.choices].join('\n')));
  const list = q ? state.items.filter(p => hay(p).includes(q)) : state.items;
  els.empty.innerHTML = list.length ? '' : '<p class="muted empty">검색 결과가 없어요.</p>';
  els.list.innerHTML = list.map(itemHTML).join('');
}
function itemHTML(p) {
  const open = state.openId === p.id;
  const st = statOf(p.id);
  const score = st.tries ? `${st.correct}/${st.tries}` : '';
  const flags = (st.last === 'x' ? '<span class="lastx">최근 오답</span>' : '') + (playable(p) ? '' : '<span class="lastx">보기가 부족해요</span>');
  return `<li class="item" data-id="${esc(p.id)}">
    <button class="item-head" data-action="toggle" aria-expanded="${open}">
      <span class="num">${state.num.get(p.id)}</span>
      <span>${flags ? `<span class="meta">${flags}</span>` : ''}<span class="preview">${fmt(p.question.replace(/\s+/g, ' '))}</span></span>
      <span class="score"${score ? ` title="${st.tries}번 풀어 ${st.correct}번 맞힘"` : ''}>${score}</span>
    </button>
    ${open ? `<div class="item-body">${detailHTML(p)}</div>` : ''}
  </li>`;
}
function detailHTML(p) {
  let h = `<div class="rich serif qtext">${fmt(p.question)}</div>${choicesHTML(p)}`;
  if (p.explanation) h += `<div class="explain"><h4>해설</h4><div class="rich">${fmt(p.explanation)}</div></div>`;
  return h + '<div class="row-actions"><button class="btn small" data-action="edit">수정</button><button class="btn small danger" data-action="delete">삭제</button></div>';
}
function deleteProblem(btn, id, after) {
  const p = state.items.find(x => x.id === id);
  if (!p) return;
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1'; btn.textContent = '한 번 더 누르면 삭제';
    setTimeout(() => { if (btn.isConnected && btn.dataset.armed === '1') { delete btn.dataset.armed; btn.textContent = '삭제'; } }, 3000);
    return;
  }
  btn.dataset.armed = 'busy'; btn.disabled = true; btn.textContent = '삭제 중…';
  mutateProblems(list => list.filter(x => x.id !== id), `문제 삭제: ${label(p)}`)
    .then(() => { if (state.openId === id) state.openId = null; toast('삭제했어요'); after && after(); renderBank(); })
    .catch(e => { toast(e.message); if (btn.isConnected) { btn.disabled = false; delete btn.dataset.armed; btn.textContent = '삭제'; } });
}
els.bank.addEventListener('click', e => {
  const a = e.target.closest('[data-action]');
  if (!a) return;
  const id = a.closest('.item')?.dataset.id;
  switch (a.dataset.action) {
    case 'new': openEditor(); break;
    case 'settings': openSettings(); break;
    case 'reload': load(); break;
    case 'toggle': state.openId = state.openId === id ? null : id; renderBank(); break;
    case 'edit': openEditor(state.items.find(p => p.id === id)); break;
    case 'delete': deleteProblem(a, id); break;
  }
});
els.q.addEventListener('input', () => { state.query = els.q.value; renderBank(); });

/* solve: setup */
function poolFor(st) {
  return state.items.filter(p => {
    if (!playable(p)) return false;
    if (st.scope === 'all') return true;
    const s = statOf(p.id);
    return st.scope === 'wrong' ? s.last === 'x' : !s.tries;
  });
}
function renderSetup() {
  const st = state.setup;
  if (!cfg) { els.solve.innerHTML = connectHTML(); return; }
  if (!state.ready) { els.solve.innerHTML = '<p class="muted empty">불러오는 중…</p>'; return; }
  if (!state.items.length) {
    els.solve.innerHTML = '<div class="empty"><p>풀 문제가 없어요. 먼저 문제를 등록해 주세요.</p><button class="btn primary" data-action="new">문제 등록하기</button></div>';
    return;
  }
  const pool = poolFor(st);
  const why = st.scope === 'wrong' ? '최근에 틀린 문제가 없어요.' : st.scope === 'new' ? '안 푼 문제가 없어요.' : '';
  els.solve.innerHTML = `<div class="setup">
    <div class="field"><span>범위</span><div class="seg" role="radiogroup" aria-label="범위">
      ${[['all', '전체'], ['wrong', '틀린 문제'], ['new', '안 푼 문제']].map(([k, l]) => `<button role="radio" aria-checked="${st.scope === k}" data-scope="${k}">${l}</button>`).join('')}
    </div></div>
    <label class="check"><input type="checkbox" id="shuffle" ${st.shuffle ? 'checked' : ''}>순서 섞기</label>
    <div class="start-row"><span class="count">${pool.length}문제</span><button class="btn primary" data-action="start" ${pool.length ? '' : 'disabled'}>풀기 시작</button></div>
    ${pool.length ? '' : `<p class="muted">${why}</p>`}
  </div>`;
}

/* solve: session */
function startSession(ids) {
  ids = ids || poolFor(state.setup).map(p => p.id);
  if (state.setup.shuffle) shuffle(ids);
  state.session = { phase: 'q', queue: ids, idx: 0, results: [], sel: null, revealed: false, graded: null };
  renderQuestion(); window.scrollTo(0, 0);
}
const current = () => state.items.find(p => p.id === state.session.queue[state.session.idx]);
function renderQuestion(focusSel) {
  const s = state.session;
  let p = current();
  while ((!p || !playable(p)) && s.idx < s.queue.length - 1) { s.idx++; p = current(); }
  if (!p || !playable(p)) return renderSummary();
  const total = s.queue.length, g = s.graded;
  const mark = g === null ? '' : `<svg viewBox="0 0 60 60" aria-hidden="true"><path pathLength="1" d="${g ? CIRCLE : SLASH}"/></svg>`;
  const choices = p.choices.map((c, i) => {
    let cls = 'choice', tag = '';
    if (s.revealed) {
      if (i === p.answer) { cls += ' is-answer'; tag = '정답'; }
      else if (i === s.sel) { cls += ' is-wrong'; tag = '내 답'; }
    }
    return `<button class="${cls}" role="radio" aria-checked="${s.sel === i}" data-i="${i}"${s.revealed ? ' aria-disabled="true"' : ''}><span class="bubble">${i + 1}</span><span class="rich">${fmt(c)}</span><span class="tag">${tag}</span></button>`;
  }).join('');
  const actions = !s.revealed
    ? `<button class="btn ghost" data-action="idk">모르겠어요</button><button class="btn primary" data-action="check"${s.sel == null ? ' disabled' : ''}>정답 확인</button>`
    : `<button class="btn primary" data-action="next">${s.idx + 1 >= total ? '결과 보기' : '다음 문제'}</button>`;
  els.solve.innerHTML = `<div class="progress"><span class="pnum">${s.idx + 1} / ${total}</span><button class="link" data-action="quit">그만 풀기</button></div>
    <div class="bar"><i></i></div>
    <article class="paper">
      <div class="qhead"><span class="qnum" aria-label="${state.num.get(p.id)}번">${state.num.get(p.id)}${mark}</span>${g === null ? '' : `<span class="verdict">${g ? '맞았어요' : '틀렸어요'}</span>`}</div>
      <div class="rich serif qtext">${fmt(p.question)}</div>
      <div class="choices" role="radiogroup" aria-label="보기">${choices}</div>
      ${s.revealed && p.explanation ? `<div class="explain"><h4>해설</h4><div class="rich">${fmt(p.explanation)}</div></div>` : ''}
    </article>
    <div class="actions">${actions}</div>`;
  $('.bar i', els.solve).style.width = `${((s.idx + (g === null ? 0 : 1)) / total) * 100}%`; // CSP: inline style 속성 대신 CSSOM
  if (focusSel != null) $(`.choice[data-i="${focusSel}"]`, els.solve)?.focus();
  else if (s.revealed) $('.actions .btn.primary', els.solve)?.focus({ preventScroll: true });
}
function select(i) { const s = state.session; if (s.revealed) return; s.sel = i; renderQuestion(i); }
function check(idk) {
  const s = state.session, p = current();
  if (!p || s.revealed) return;
  if (idk) s.sel = null; else if (s.sel == null) return;
  const ok = !idk && s.sel === p.answer;
  s.revealed = true; s.graded = ok; s.results.push({ id: p.id, ok });
  recordStat(p.id, ok);
  renderQuestion();
}
function next() {
  const s = state.session;
  s.idx++; s.sel = null; s.revealed = false; s.graded = null;
  if (s.idx >= s.queue.length) renderSummary(); else renderQuestion();
  window.scrollTo(0, 0);
}
function renderSummary() {
  const s = state.session; s.phase = 'done';
  flushStats();
  const total = s.results.length, ok = s.results.filter(r => r.ok).length;
  const wrong = s.results.filter(r => !r.ok).map(r => r.id);
  const nums = wrong.map(id => state.num.get(id)).filter(Boolean);
  els.solve.innerHTML = total ? `<div class="summary">
      <p class="score-big">${ok} / ${total}</p>
      <p class="muted">${total}문제 중 ${ok}문제를 맞혔어요.${nums.length ? ` 틀린 문제는 ${nums.join(', ')}번이에요.` : ''}</p>
      <div class="actions">${wrong.length ? `<button class="btn primary" data-action="retry">틀린 ${wrong.length}문제 다시 풀기</button>` : ''}<button class="btn" data-action="home">처음으로</button></div>
    </div>`
    : '<div class="summary"><p class="muted">푼 문제가 없어요.</p><div class="actions"><button class="btn primary" data-action="home">처음으로</button></div></div>';
}
function quit() {
  const s = state.session;
  if (s && s.phase === 'q' && s.results.length) renderSummary();
  else { state.session = null; renderSetup(); }
  window.scrollTo(0, 0);
}
els.solve.addEventListener('click', e => {
  const t = e.target, s = state.session;
  if (s && s.phase === 'q') {
    const ch = t.closest('.choice');
    if (ch) { select(+ch.dataset.i); return; }
  } else {
    const sc = t.closest('[data-scope]');
    if (sc) { state.setup.scope = sc.dataset.scope; renderSetup(); return; }
  }
  const a = t.closest('[data-action]');
  if (!a) return;
  switch (a.dataset.action) {
    case 'start': startSession(); break;
    case 'new': openEditor(); break;
    case 'settings': openSettings(); break;
    case 'check': check(false); break;
    case 'idk': check(true); break;
    case 'next': next(); break;
    case 'quit': quit(); break;
    case 'home': state.session = null; renderSetup(); window.scrollTo(0, 0); break;
    case 'retry': startSession(s.results.filter(r => !r.ok).map(r => r.id)); break;
  }
});
els.solve.addEventListener('change', e => { if (e.target.id === 'shuffle') state.setup.shuffle = e.target.checked; });

/* ================= overlays ================= */
function showOverlay(el) { el.hidden = false; document.body.classList.add('locked'); }
function hideOverlay(el) {
  el.hidden = true;
  if ($('#editor').hidden && $('#settings').hidden) document.body.classList.remove('locked');
}

/* editor */
const ed = { el: $('#editor'), id: null, base: null, choices: [], answer: null, dirty: false, armed: false, busy: false, field: null, shift: false };
const FMT_FIELDS = '#edQ, #edExp, #edChoices input';
function openEditor(p) {
  if (!cfg) { openSettings(); return; }
  ed.id = p ? p.id : null; ed.base = p || null;
  ed.choices = p && p.choices.length ? [...p.choices] : ['', '', '', ''];
  while (ed.choices.length < 2) ed.choices.push('');
  ed.answer = p && p.choices.length ? p.answer : null;
  $('#edTitle').textContent = p ? `${state.num.get(p.id)}번 문제 수정` : '새 문제';
  $('#edQ').value = p ? p.question : '';
  $('#edExp').value = p ? p.explanation : '';
  const del = $('#edDelete');
  del.hidden = !p; del.disabled = false; del.textContent = '삭제'; delete del.dataset.armed;
  $('#edSaveNext').hidden = !!p;
  $('#edErr').textContent = ''; ed.dirty = false; ed.armed = false; ed.field = null; ed.shift = false; setBusy(false);
  renderKeys();
  renderChoices(); renderPreview();
  showOverlay(ed.el);
  $('#editor .sheet-body').scrollTop = 0;
  setTimeout(() => $('#edQ').focus({ preventScroll: true }), 40);
}
function renderChoices() {
  const few = ed.choices.length <= 2;
  $('#edChoices').innerHTML = ed.choices.map((c, i) => `<div class="ed-choice">
      <button type="button" class="bubble${ed.answer === i ? ' filled' : ''}" data-ans="${i}" aria-pressed="${ed.answer === i}" aria-label="${i + 1}번을 정답으로">${i + 1}</button>
      <input type="text" data-ci="${i}" value="${esc(c)}" placeholder="보기 ${i + 1}" autocomplete="off">
      <button type="button" class="icon" data-rm="${i}" aria-label="보기 ${i + 1} 삭제"${few ? ' disabled' : ''}>✕</button>
    </div>`).join('');
  $('#edAddChoice').hidden = ed.choices.length >= 6;
}
// 서식 표기가 들어 있을 때만 렌더링 결과를 보여 준다
function renderPreview() {
  const q = $('#edQ').value;
  const show = hasMarks(q) || ed.choices.some(hasMarks);
  $('#edPreviewWrap').hidden = !show;
  if (show) $('#edPreview').innerHTML = `<div class="rich serif qtext">${fmt(q)}</div>${choicesHTML({ choices: ed.choices.filter(c => c.trim()), answer: -1 })}`;
}
// 선택 영역을 mark로 감싸거나, 이미 감싸져 있으면 벗긴다
function applyFmt(el, mark) {
  if (!el) return;
  const v = el.value, L = mark.length;
  let s = el.selectionStart ?? v.length, e = el.selectionEnd ?? v.length;
  while (s < e && /\s/.test(v[s])) s++;
  while (e > s && /\s/.test(v[e - 1])) e--;
  if (s >= L && v.slice(s - L, s) === mark && v.slice(e, e + L) === mark) {
    el.setRangeText(v.slice(s, e), s - L, e + L, 'select');
  } else if (e - s > 2 * L && v.slice(s, s + L) === mark && v.slice(e - L, e) === mark) {
    el.setRangeText(v.slice(s + L, e - L), s, e, 'select');
  } else {
    el.setRangeText(mark + v.slice(s, e) + mark, s, e, 'end');
    el.setSelectionRange(s + L, e + L);
  }
  el.focus();
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
// 커서 위치(선택 영역이 있으면 그 자리)에 글자를 넣는다
function insertText(el, text) {
  if (!el) return;
  const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? el.value.length;
  el.setRangeText(text, s, e, 'end');
  el.focus();
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function renderKeys() {
  ed.el.querySelectorAll('[data-ch]').forEach(b => { b.textContent = ed.shift ? b.dataset.ch.toUpperCase() : b.dataset.ch; });
  ed.el.querySelector('[data-shift]').setAttribute('aria-pressed', String(ed.shift));
}
const fmtTarget = () => (ed.field && ed.field.isConnected ? ed.field : $('#edQ'));
function setBusy(b) {
  ed.busy = b;
  $('#edSave').disabled = b; $('#edSaveNext').disabled = b;
  $('#edSave').textContent = b ? '저장 중…' : '저장';
}
function tryCloseEditor() {
  if (ed.busy) return;
  if (ed.dirty && !ed.armed) {
    ed.armed = true; $('#edErr').textContent = '저장하지 않은 내용이 있어요. 닫으려면 한 번 더 누르세요.';
    setTimeout(() => { ed.armed = false; }, 4000);
    return;
  }
  hideOverlay(ed.el);
}
async function saveEditor(andNext) {
  if (ed.busy) return;
  const err = m => { $('#edErr').textContent = m; };
  const question = $('#edQ').value.trim();
  const explanation = $('#edExp').value.trim();
  if (!question) return err('문제를 입력해 주세요.');
  const rows = ed.choices.map((c, i) => ({ t: c.trim(), a: i === ed.answer })).filter(r => r.t);
  if (rows.length < 2) return err('보기를 두 개 이상 입력해 주세요.');
  const answer = rows.findIndex(r => r.a);
  if (answer < 0) return err(ed.answer == null ? '정답인 보기의 번호를 눌러 표시해 주세요.' : '정답으로 고른 보기가 비어 있어요.');
  const now = Date.now(), base = ed.base;
  const p = {
    id: ed.id || newId(), question, choices: rows.map(r => r.t), answer, explanation,
    createdAt: base ? base.createdAt || now : now, updatedAt: now,
  };
  err(''); setBusy(true);
  try {
    await mutateProblems(list => upsert(list, p), `${base ? '문제 수정' : '문제 추가'}: ${label(p)}`);
  } catch (e) {
    setBusy(false);
    return err(`저장하지 못했어요. ${e.message}`);
  }
  setBusy(false);
  if (andNext) { openEditor(); toast('저장했어요. 다음 문제를 입력하세요.'); }
  else { hideOverlay(ed.el); toast(base ? '수정했어요' : '저장했어요'); }
}
ed.el.addEventListener('focusin', e => { if (e.target.matches(FMT_FIELDS)) ed.field = e.target; });
ed.el.addEventListener('input', e => {
  ed.dirty = true;
  if (e.target.dataset.ci != null) ed.choices[+e.target.dataset.ci] = e.target.value;
  if (e.target.id === 'edQ' || e.target.dataset.ci != null) renderPreview();
});
ed.el.addEventListener('click', e => {
  const t = e.target;
  if (t === ed.el) { tryCloseEditor(); return; }
  const f = t.closest('[data-fmt]');
  if (f) { applyFmt(fmtTarget(), f.dataset.fmt === 'b' ? '**' : '__'); return; }
  const k = t.closest('[data-ch]');
  if (k) {
    insertText(fmtTarget(), ed.shift ? k.dataset.ch.toUpperCase() : k.dataset.ch);
    if (ed.shift) { ed.shift = false; renderKeys(); } // 대문자는 한 글자만
    return;
  }
  if (t.closest('[data-shift]')) { ed.shift = !ed.shift; renderKeys(); return; }
  const a = t.closest('[data-ans]');
  if (a) { ed.answer = +a.dataset.ans; ed.dirty = true; renderChoices(); return; }
  const r = t.closest('[data-rm]');
  if (r) {
    const i = +r.dataset.rm;
    ed.choices.splice(i, 1);
    if (ed.answer === i) ed.answer = null; else if (ed.answer != null && ed.answer > i) ed.answer--;
    ed.dirty = true; renderChoices(); renderPreview();
  }
});
// 도구 모음 버튼을 눌러도 입력란의 포커스(모바일 키보드)와 선택 영역이 유지되도록
ed.el.querySelectorAll('.fmtbar button').forEach(b => {
  b.addEventListener('pointerdown', e => e.preventDefault());
  b.addEventListener('mousedown', e => e.preventDefault());
});
$('#edAddChoice').addEventListener('click', () => { ed.choices.push(''); renderChoices(); $(`[data-ci="${ed.choices.length - 1}"]`).focus(); });
$('#edClose').addEventListener('click', tryCloseEditor);
$('#edSave').addEventListener('click', () => saveEditor(false));
$('#edSaveNext').addEventListener('click', () => saveEditor(true));
$('#edDelete').addEventListener('click', e => deleteProblem(e.currentTarget, ed.id, () => hideOverlay(ed.el)));

/* settings */
const st = { el: $('#settings') };
function parseRepo(s) {
  s = String(s).trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  const m = s.match(/^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}
function renderSettingsInfo() {
  if (!cfg) return;
  const parts = [`${cfg.owner}/${cfg.repo}${cfg.branch ? ` (${cfg.branch})` : ''}에 연결돼 있어요.`];
  if (cfg.private === false) parts.push('공개 저장소라서 문제 데이터가 누구에게나 보여요.');
  if (lastSync) parts.push(`마지막 동기화 ${new Date(lastSync).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}.`);
  const n = pendingCount();
  if (n) parts.push(`아직 커밋하지 않은 풀이 기록 ${n}건이 있어요.`);
  if (syncState === 'error' && syncMsg) parts.push(syncMsg);
  $('#stInfo').textContent = parts.join(' ');
}
function openSettings() {
  const known = cfg || repoCfg;
  $('#stRepo').value = known ? `${known.owner}/${known.repo}` : '';
  $('#stBranch').value = known && known.branch ? known.branch : '';
  $('#stToken').value = '';
  $('#stToken').placeholder = cfg ? '저장된 토큰을 쓰려면 비워 두세요' : 'github_pat_…';
  $('#stRemember').checked = cfg ? !!kv.get(LS, 'qbank.token') : true;
  const msg = $('#stMsg'); msg.className = 'err';
  msg.textContent = !cfg && repoCfg ? '토큰을 다시 입력해 주세요.' : '';
  $('#stConnected').hidden = !cfg;
  $('#stSave').textContent = cfg ? '저장' : '연결';
  $('#stSave').disabled = false;
  renderSettingsInfo();
  showOverlay(st.el);
  setTimeout(() => ($('#stRepo').value ? $('#stToken') : $('#stRepo')).focus({ preventScroll: true }), 40);
}
async function saveSettings() {
  const msg = $('#stMsg'), btn = $('#stSave');
  const r = parseRepo($('#stRepo').value);
  msg.className = 'err';
  if (!r) { msg.textContent = '저장소를 "아이디/저장소" 형식으로 입력해 주세요.'; return; }
  const tok = $('#stToken').value.trim() || (cfg ? cfg.token : '');
  if (!tok) { msg.textContent = '토큰을 입력해 주세요.'; return; }
  const next = { ...r, branch: $('#stBranch').value.trim(), token: tok };
  btn.disabled = true; msg.className = 'err muted'; msg.textContent = '연결을 확인하는 중…';
  try {
    const res = await api(repoPath(next), { c: next });
    if (!res.ok) throw await fail(res);
    const info = await res.json();
    if (cfg && pendingCount()) await flushStats();
    const changed = !cfg || cfg.owner !== next.owner || cfg.repo !== next.repo || (cfg.branch || '') !== next.branch;
    repoCfg = { owner: next.owner, repo: next.repo, branch: next.branch, private: !!info.private };
    kv.set(LS, 'qbank.repo', repoCfg);
    if ($('#stRemember').checked) { kv.set(LS, 'qbank.token', tok); kv.del(SS, 'qbank.token'); }
    else { kv.set(SS, 'qbank.token', tok); kv.del(LS, 'qbank.token'); }
    token = tok; cfg = { ...repoCfg, token };
    if (changed) {
      for (const f of Object.values(files)) Object.assign(f, { data: null, sha: null, loaded: false });
      pending = {}; state.ready = false; state.loadError = ''; state.openId = null; state.session = null;
      recompute();
    }
    hideOverlay(st.el);
    toast(info.private ? '연결했어요' : '연결했어요. 공개 저장소라서 데이터가 누구에게나 보여요.');
    if (changed) load(); else render();
  } catch (e) {
    msg.className = 'err';
    msg.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}
async function logout(btn) {
  btn.disabled = true;
  await flushStats();
  kv.del(LS, 'qbank.token'); kv.del(SS, 'qbank.token'); kv.del(LS, 'qbank.repo');
  cfg = null; token = null; repoCfg = null;
  for (const f of Object.values(files)) Object.assign(f, { data: null, sha: null, loaded: false });
  pending = {}; state.ready = false; state.loadError = ''; state.session = null; state.openId = null;
  recompute();
  btn.disabled = false;
  hideOverlay(st.el); setSync('idle'); render();
  toast('이 기기에서 연결을 해제했어요');
}
st.el.addEventListener('click', e => { if (e.target === st.el) hideOverlay(st.el); });
$('#stClose').addEventListener('click', () => hideOverlay(st.el));
$('#stSave').addEventListener('click', saveSettings);
$('#stSync').addEventListener('click', async () => { await flushStats(); await load(); renderSettingsInfo(); });
$('#stLogout').addEventListener('click', e => logout(e.currentTarget));
st.el.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('input[type=text],input[type=password]')) { e.preventDefault(); saveSettings(); } });
$('#syncBtn').addEventListener('click', openSettings);

/* ================= global ================= */
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => setView(t.dataset.view)));
document.addEventListener('keydown', e => {
  if (!st.el.hidden) { if (e.key === 'Escape') hideOverlay(st.el); return; }
  if (!ed.el.hidden) {
    const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
    if (e.key === 'Escape') tryCloseEditor();
    else if (mod && e.key === 'Enter') { e.preventDefault(); saveEditor(false); }
    else if (mod && (k === 'b' || k === 'u') && e.target.matches(FMT_FIELDS)) { e.preventDefault(); applyFmt(e.target, k === 'b' ? '**' : '__'); }
    return;
  }
  const s = state.session;
  if (state.view !== 'solve' || !s || s.phase !== 'q') return;
  if (e.target.matches('textarea,input')) return;
  if (/^[1-9]$/.test(e.key)) {
    const p = current();
    if (p && !s.revealed && +e.key <= p.choices.length) select(+e.key - 1);
    return;
  }
  if (e.key === 'Enter' && !e.target.closest('button')) {
    const b = $('.actions .btn.primary', els.solve);
    if (b && !b.disabled) { e.preventDefault(); b.click(); }
  }
});
// 앱이 가려질 때 모아 둔 풀이 기록을 커밋하고, 다시 보일 때 다른 기기의 변경을 받아온다
document.addEventListener('visibilitychange', () => {
  if (!cfg) return;
  if (document.visibilityState === 'hidden') flushStats();
  else if (Date.now() - lastSync > 60000 && ed.el.hidden) load();
});
window.addEventListener('pagehide', () => { flushStats(); });
function fromHash() { const h = location.hash.slice(1); if (h === 'solve' || h === 'bank') setView(h); }
window.addEventListener('hashchange', fromHash);

render();
fromHash();
if (cfg) load(); else openSettings();
})();
