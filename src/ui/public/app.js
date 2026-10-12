// The Crucible UI. Plain browser JS, no build step.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (x, d = 1) => `${x.toFixed(d)}%`;
const signed = (x, d = 1) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}`;
const cardUrl = (name) => `https://scryfall.com/search?q=${encodeURIComponent(`!"${name.split(' // ')[0]}"`)}`;
const cardLink = (name, cls = '') => `<a class="${cls}" href="${cardUrl(name)}" target="_blank" rel="noopener" title="Open ${esc(name)} on Scryfall">${esc(name)}</a>`;

const state = { decks: [], gauntletId: null, gauntlet: null, upgrades: null, sort: { key: 'impact', dir: 1 }, sources: {} };

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

let toastTimer;
function toast(msg, error = false) {
  const t = $('toast');
  t.textContent = msg; t.className = 'toast' + (error ? ' error' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), error ? 6000 : 3000);
}

function remember(key, value) { try { localStorage.setItem('crucible.' + key, JSON.stringify(value)); } catch {} }
function recall(key, fallback) { try { const v = localStorage.getItem('crucible.' + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } }

// ------------------------------------------------------------------ setup
async function loadState() {
  const s = await api('/api/state');
  state.decks = s.decks;
  state.formats = s.formats;
  $('meta').textContent = `${s.workers} worker thread${s.workers === 1 ? '' : 's'}`;
  setCollectionStatus(s.collection);

  const sel = $('deckSelect'), current = sel.value;
  sel.innerHTML = '<option value="">Paste a deck below…</option>';
  const byFolder = groupBy(s.decks, d => d.folder);
  const folders = ['mine', ...s.formats.map(f => f.gauntlet), ...Object.keys(byFolder).filter(f => f !== 'mine' && !s.formats.some(x => x.gauntlet === f))];
  for (const folder of folders) {
    if (!byFolder[folder]) continue;
    const og = document.createElement('optgroup');
    og.label = folderLabel(folder);
    for (const d of byFolder[folder]) og.append(new Option(`${d.name} (${formatLabel(d.format)}, ${d.size})`, d.file));
    sel.append(og);
  }
  sel.value = current;
  renderOpponents();
}

function groupBy(xs, f) { const o = {}; for (const x of xs) (o[f(x)] ??= []).push(x); return o; }
const formatLabel = (id) => state.formats?.find(f => f.id === id)?.label ?? id;
const formatOfFolder = (folder) => state.formats?.find(f => f.gauntlet === folder);
function folderLabel(folder) {
  if (folder === 'mine') return 'My decks';
  const f = formatOfFolder(folder);
  return f ? `${f.label} gauntlet` : folder;
}

function setCollectionStatus(c) {
  $('collectionStatus').textContent = c.count
    ? `${c.count.toLocaleString()} cards loaded (updated ${new Date(c.updated).toLocaleDateString()}). Upgrade suggestions only use cards you own.`
    : 'No collection loaded yet. Load the arena_collection.csv export from the project so suggestions only use cards you own.';
}

// Opponents follow the deck's format: its own gauntlet (and your decks of that format) are listed first and
// ticked by default; other formats sit under "Other formats". Your ticks are remembered per format.
const defaultOpponents = (fmt) => state.decks.filter(d => d.folder === formatGauntlet(fmt)).map(d => d.file);
const formatGauntlet = (fmt) => state.formats?.find(f => f.id === fmt)?.gauntlet;

function renderOpponents() {
  const fmt = state.format ?? 'standard';
  const chosen = new Set(recall(`opponents.${fmt}`, defaultOpponents(fmt)));
  const groups = [];
  const gauntlet = formatGauntlet(fmt);
  const same = state.decks.filter(d => d.folder === gauntlet);
  const mineSame = state.decks.filter(d => d.folder === 'mine' && d.format === fmt);
  if (same.length) groups.push([`${formatLabel(fmt)} gauntlet`, same, true]);
  if (mineSame.length) groups.push([`My ${formatLabel(fmt)} decks`, mineSame, true]);
  const others = state.decks.filter(d => !same.includes(d) && !mineSame.includes(d));
  const box = $('opponents');
  const group = ([label, decks]) => `<div class="opp-group"><label class="check"><input type="checkbox" data-group> ${esc(label)}</label>
      <div class="list">${decks.map(d => `<label class="check"><input type="checkbox" value="${esc(d.file)}" ${chosen.has(d.file) ? 'checked' : ''}> ${esc(d.name)}</label>`).join('')}</div></div>`;
  const otherGroups = Object.entries(groupBy(others, d => d.folder === 'mine' ? `My ${formatLabel(d.format)} decks` : folderLabel(d.folder)));
  box.innerHTML = groups.map(group).join('')
    + (otherGroups.length ? `<details class="other-formats" ${others.some(d => chosen.has(d.file)) ? 'open' : ''}><summary>Other formats</summary>${otherGroups.map(group).join('')}</details>` : '');
  $('oppHint').textContent = same.length
    ? `Like against like: this ${formatLabel(fmt)} deck faces the ${formatLabel(fmt)} gauntlet by default.`
    : `There is no ${formatLabel(fmt)} gauntlet yet; tick any decks to play against.`;
  syncGroupBoxes();
}

function syncGroupBoxes() {
  for (const g of $('opponents').querySelectorAll('.opp-group')) {
    const all = [...g.querySelectorAll('.list input')], on = all.filter(i => i.checked).length;
    const head = g.querySelector('[data-group]');
    head.checked = on === all.length; head.indeterminate = on > 0 && on < all.length;
  }
}

$('opponents').addEventListener('change', (e) => {
  if (e.target.dataset.group !== undefined) {
    for (const i of e.target.closest('.opp-group').querySelectorAll('.list input')) i.checked = e.target.checked;
  }
  syncGroupBoxes();
  remember(`opponents.${state.format ?? 'standard'}`, selectedOpponents());
});
const selectedOpponents = () => [...$('opponents').querySelectorAll('.list input:checked')].map(i => i.value);

/** Switches the page to a deck format: opponents, and whether upgrades must be Standard-legal. */
function setFormat(fmt) {
  if (state.format === fmt) return;
  state.format = fmt;
  $('standardOnly').checked = state.formats?.find(f => f.id === fmt)?.standardLegal ?? true;
  renderOpponents();
}

// ------------------------------------------------------------------ deck editor
$('deckSelect').addEventListener('change', async () => {
  const file = $('deckSelect').value;
  remember('deck', file);
  if (!file) return;
  const { text } = await api(`/api/deck?file=${encodeURIComponent(file)}`);
  $('deckText').value = text;
  inspect();
});

let inspectTimer;
$('deckText').addEventListener('input', () => { clearTimeout(inspectTimer); inspectTimer = setTimeout(inspect, 350); });

/** Display name for the deck in the editor: the saved deck's file name, unless the text has a Name line. */
function deckName() {
  const d = state.decks.find(x => x.file === $('deckSelect').value);
  return d ? d.name : 'My deck';
}

async function inspect() {
  const text = $('deckText').value;
  const box = $('deckInfo');
  if (!text.trim()) { box.innerHTML = ''; return; }
  try {
    const d = await api('/api/inspect', { text, name: deckName() });
    setFormat(d.format);
    const pips = d.colors.length ? `<span class="pips">${d.colors.map(c => `<span class="pip ${c}" title="${c}"></span>`).join('')}</span>` : '';
    const sizeOk = d.format === 'standard' ? d.size >= 60 : d.size === d.expectedSize;
    const sizeNote = sizeOk ? '' : ` <span class="warn">(${d.formatLabel} decks are ${d.format === 'standard' ? 'at least ' : ''}${d.expectedSize})</span>`;
    const lead = d.commander ? `${d.formatLabel} deck led by ${cardLink(d.commander)}` : `${d.formatLabel} deck`;
    box.innerHTML = `<strong>${esc(d.name)}</strong>: ${lead}, ${d.size} cards${sizeNote}${pips}
      ${d.missing.length ? `<div class="warn">Not in the card data, so left out: ${d.missing.map(esc).join(', ')}</div>` : ''}
      ${d.illegal.length ? `<div class="warn">Not legal in ${d.formatLabel}: ${d.illegal.map(n => cardLink(n)).join(', ')}</div>` : ''}
      ${d.duplicates.length ? `<div class="warn">${d.formatLabel} is singleton, but these have more than one copy: ${d.duplicates.map(esc).join(', ')}</div>` : ''}
      ${d.unmodeled.length ? `<details><summary>${d.unmodeled.length} of ${d.distinct} cards are only partly modeled by the engine</summary><ul>${d.unmodeled.map(u => `<li>${cardLink(u.name)}: ${u.notes.map(esc).join('; ')}</li>`).join('')}</ul></details>` : ''}`;
  } catch (e) { box.innerHTML = `<span class="warn">${esc(e.message)}</span>`; }
}

$('saveDeck').addEventListener('click', async () => {
  const text = $('deckText').value;
  if (!text.trim()) return toast('Paste a deck first.', true);
  const guess = text.match(/^\s*Name\s+(.+)$/mi)?.[1] ?? '';
  const name = prompt('Save as (saved to decks/mine):', guess);
  if (!name) return;
  try {
    const { file } = await api('/api/save', { name, text });
    await loadState();
    $('deckSelect').value = file; remember('deck', file);
    toast(`Saved to decks/${file}`);
  } catch (e) { toast(e.message, true); }
});

$('collectionFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const { count } = await api('/api/collection', { text: await f.text() });
    toast(`Collection loaded: ${count.toLocaleString()} cards`);
    loadState();
  } catch (err) { toast(err.message, true); }
  e.target.value = '';
});

for (const id of ['games', 'turns', 'seed', 'cuts', 'perCut', 'confirm']) {
  const el = $(id); el.value = recall(id, el.value);
  el.addEventListener('change', () => remember(id, el.value));
}

// ------------------------------------------------------------------ streaming jobs
function watch(id, onUpdate) {
  state.sources[id]?.close();
  const es = new EventSource(`/api/jobs/${id}/events`);
  state.sources[id] = es;
  es.onmessage = (m) => {
    const job = JSON.parse(m.data);
    onUpdate(job);
    if (job.status !== 'running') { es.close(); delete state.sources[id]; }
  };
  es.onerror = () => { if (es.readyState === EventSource.CLOSED) delete state.sources[id]; };
}

// ------------------------------------------------------------------ gauntlet
$('run').addEventListener('click', async () => {
  const text = $('deckText').value;
  if (!text.trim()) return toast('Pick or paste a deck first.', true);
  const opponents = selectedOpponents();
  if (!opponents.length) return toast('Tick at least one opponent.', true);
  try {
    const { id } = await api('/api/gauntlet', { text, name: deckName(), opponents, games: +$('games').value, maxTurns: +$('turns').value, seed: +$('seed').value });
    state.gauntletId = id; state.upgrades = null;
    $('swaps').innerHTML = ''; $('upgradeStatus').textContent = '';
    $('empty').hidden = true; $('gauntletPanel').hidden = false; $('cardsPanel').hidden = true; $('upgradePanel').hidden = true;
    setRunning(true);
    watch(id, renderGauntlet);
  } catch (e) { toast(e.message, true); }
});

$('cancel').addEventListener('click', () => state.gauntletId && api(`/api/jobs/${state.gauntletId}/cancel`, {}));

function setRunning(on) {
  $('run').disabled = on; $('run').textContent = on ? 'Running…' : 'Run gauntlet';
  $('cancel').hidden = !on;
}

function progressBar(done, total, running) {
  return `<div class="bar ${running ? 'running' : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}">
    <div class="fill" style="width:${(100 * done / Math.max(1, total)).toFixed(1)}%"></div><span class="count">${done} / ${total}</span></div>`;
}
function resultBar(wr, ci) {
  return `<div class="bar result ${wr < 50 ? 'losing' : ''}" title="Win rate ${pct(wr)}, 95% range ${pct(ci[0], 0)} to ${pct(ci[1], 0)}">
    <div class="fill" style="width:${wr.toFixed(1)}%"></div><div class="half"></div>
    <div class="ci" style="left:${ci[0].toFixed(1)}%;width:${(ci[1] - ci[0]).toFixed(1)}%"></div></div>`;
}

function renderGauntlet(job) {
  if (job.id !== state.gauntletId) return;
  state.gauntlet = job;
  const running = job.status === 'running';
  $('gauntletTitle').textContent = `${job.deck.name} against ${job.matchups.length} opponent${job.matchups.length === 1 ? '' : 's'}`;
  const done = job.matchups.reduce((a, m) => a + m.done, 0), total = job.matchups.reduce((a, m) => a + m.games, 0);
  $('gauntletStatus').textContent = running ? `Playing ${done.toLocaleString()} of ${total.toLocaleString()} games`
    : job.status === 'done' ? `${total.toLocaleString()} games in ${((job.finished - job.started) / 1000).toFixed(1)}s, ${job.deck.formatLabel} rules`
    : job.status === 'cancelled' ? 'Stopped' : `Error: ${job.error}`;

  const rows = job.matchups.map(m => {
    const r = m.result;
    return `<div class="mu">
      <div class="mu-name" title="${esc(m.name)}">${esc(m.name)}${r ? `<span class="mu-sub">${pct(r.onPlayWR, 0)} on the play, ${pct(r.onDrawWR, 0)} on the draw, ${r.avgTurns.toFixed(1)} turns</span>` : ''}</div>
      ${r ? resultBar(r.wr, r.ci) : progressBar(m.done, m.games, running)}
      <div class="mu-val num">${r ? pct(r.wr, 0) : ''}</div></div>`;
  });
  if (job.overall) rows.push(`<div class="mu overall"><div class="mu-name">All opponents<span class="mu-sub">95% range ${pct(job.overall.ci[0], 0)} to ${pct(job.overall.ci[1], 0)}</span></div>
      ${resultBar(job.overall.wr, job.overall.ci)}<div class="mu-val num">${pct(job.overall.wr, 1)}</div></div>`);
  else rows.push(`<div class="mu overall"><div class="mu-name">All opponents</div>${progressBar(done, total, running)}<div class="mu-val num"></div></div>`);
  $('matchups').innerHTML = rows.join('');

  if (!running) setRunning(false);
  if (job.status === 'done') {
    $('cardsPanel').hidden = false; $('upgradePanel').hidden = false;
    renderCards();
  }
}

// ------------------------------------------------------------------ card table
const COLS = [
  { key: 'name', label: 'Card' },
  { key: 'copies', label: 'Copies', num: true },
  { key: 'seen', label: 'Games drawn', num: true },
  { key: 'seenWR', label: 'Win % when drawn', num: true },
  { key: 'impact', label: 'Impact', num: true },
  { key: 'castRate', label: 'Cast when drawn', num: true },
];
$('showLands').addEventListener('change', renderCards);

function renderCards() {
  const job = state.gauntlet;
  if (!job?.cards) return;
  const games = job.overall.games, minSeen = Math.max(20, games * 0.03);
  const { key, dir } = state.sort;
  const cards = job.cards.filter(c => $('showLands').checked || !c.isLand)
    .sort((a, b) => (typeof a[key] === 'string' ? a[key].localeCompare(b[key]) : a[key] - b[key]) * dir);
  const max = Math.max(10, ...cards.filter(c => !c.isCommander).map(c => Math.abs(c.impact)));
  const head = `<thead><tr>${COLS.map(c => `<th data-key="${c.key}" ${c.key === key ? `aria-sort="${dir > 0 ? 'ascending' : 'descending'}"` : ''}>${c.label}</th>`).join('')}</tr></thead>`;
  const body = cards.map(c => {
    const thin = c.seen < minSeen;
    const w = (50 * Math.min(Math.abs(c.impact), max) / max).toFixed(1);
    return `<tr class="${thin ? 'thin' : ''}">
      <td>${cardLink(c.name)}${c.isCommander ? '<span class="badge">commander</span>' : ''}${c.modeled ? '' : '<span class="badge warn" title="The engine ignores or approximates part of this card, so its numbers are less reliable">partly modeled</span>'}${thin ? '<span class="badge" title="Drawn in too few games to judge">few games</span>' : ''}</td>
      <td class="num">${c.copies}</td>
      <td class="num">${c.seen.toLocaleString()}</td>
      <td class="num">${c.seen ? pct(100 * c.seenWR, 0) : '–'}</td>
      <td class="num">${c.isCommander ? '–' : `<div class="impact"><div class="track"><div class="seg ${c.impact >= 0 ? 'pos' : 'neg'}" style="width:${w}%"></div></div><span>${signed(c.impact)}</span></div>`}</td>
      <td class="num">${c.isCommander ? '–' : c.seen ? pct(100 * c.castRate, 0) : '–'}</td></tr>`;
  }).join('');
  $('cardTable').innerHTML = head + `<tbody>${body}</tbody>`;
}

$('cardTable').addEventListener('click', (e) => {
  const th = e.target.closest('th');
  if (!th) return;
  const key = th.dataset.key;
  state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : (key === 'name' || key === 'impact' ? 1 : -1) };
  renderCards();
});

// ------------------------------------------------------------------ upgrades
$('findUpgrades').addEventListener('click', async () => {
  if (!state.gauntlet || state.gauntlet.status !== 'done') return toast('Run the gauntlet first.', true);
  try {
    const { id } = await api('/api/upgrades', {
      baselineId: state.gauntletId, cuts: +$('cuts').value, perCut: +$('perCut').value, confirm: +$('confirm').value,
      standardOnly: $('standardOnly').checked, modeledOnly: $('modeledOnly').checked,
    });
    state.upgradesId = id;
    $('findUpgrades').disabled = true; $('cancelUpgrades').hidden = false;
    watch(id, renderUpgrades);
  } catch (e) { toast(e.message, true); }
});
$('cancelUpgrades').addEventListener('click', () => state.upgradesId && api(`/api/jobs/${state.upgradesId}/cancel`, {}));

function verdict(s) {
  const margin = 1.96 * s.se;
  if (s.delta > margin) return { cls: 'up', text: 'likely better' };
  if (s.delta < -margin) return { cls: 'down', text: 'likely worse' };
  return { cls: s.delta >= 0 ? 'up' : 'down', text: `within noise (±${margin.toFixed(1)})` };
}

function renderUpgrades(job) {
  if (job.id !== state.upgradesId) return;
  state.upgrades = job;
  const running = job.status === 'running';
  const opps = state.gauntlet.matchups.length;
  const phaseText = job.phase === 'screening' ? `Screening ${job.swaps.length} swaps at ${job.screenGames} games per opponent`
    : job.phase === 'confirming' ? `Replaying the finalists at ${job.fullGames} games per opponent` : '';
  $('upgradeStatus').textContent = running ? phaseText
    : job.status === 'done' ? (job.message ?? `Tested ${job.swaps.length} swaps against ${opps} opponents in ${((job.finished - job.started) / 1000).toFixed(0)}s. Current list: ${pct(job.baselineWR)}.`)
    : job.status === 'cancelled' ? 'Stopped' : `Error: ${job.error}`;

  const item = (s) => {
    const shown = s.delta !== undefined ? s.delta : s.screenDelta;
    let side = '';
    if (s.stage === 'confirmed') {
      const v = verdict(s);
      side = `<span class="delta num ${v.cls}">${signed(s.delta)}<span class="verdict">${v.text}</span></span>
        <button class="ghost apply" type="button" data-cut="${esc(s.cut)}" data-add="${esc(s.add)}" data-copies="${s.copies}">Apply to deck</button>`;
    } else if (shown !== undefined) {
      side = `<span class="delta num ${shown >= 0 ? 'up' : 'down'}" title="Quick screen only">${signed(shown)}<span class="verdict">quick screen</span></span>`;
    }
    const showBar = s.stage === 'screening' || s.stage === 'confirming' || (running && s.stage === 'queued');
    return `<div class="swap ${s.stage === 'skipped' ? 'skipped' : ''}">
      <div class="what">Cut ${s.copies} ${cardLink(s.cut, 'out')}, add ${s.copies} ${cardLink(s.add)}</div>
      <div class="detail">${esc(s.add)}: ${esc(s.rarity)}, you own ${s.owned}${s.addModeled ? '' : ', partly modeled'}</div>
      <div class="side">${side}</div>
      ${showBar ? progressBar(s.done, s.total, s.stage !== 'queued') : ''}</div>`;
  };
  const confirmed = job.swaps.filter(s => s.stage === 'confirmed').sort((a, b) => b.delta - a.delta);
  const active = job.swaps.filter(s => s.stage === 'confirming');
  const rest = job.swaps.filter(s => !['confirmed', 'confirming'].includes(s.stage))
    .sort((a, b) => (b.screenDelta ?? -1e9) - (a.screenDelta ?? -1e9));
  let html = '';
  if (job.cuts.length) html += `<p class="hint">Weakest cards tried: ${job.cuts.map(c => `${cardLink(c.name)} (${signed(c.impact)})`).join(', ')}</p>`;
  if (confirmed.length || active.length) html += `<div class="group-title">Full gauntlet results</div>` + [...confirmed, ...active].map(item).join('');
  if (rest.length) html += `<div class="group-title">${job.phase === 'screening' ? 'Screening' : 'Screened out'}</div>` + rest.map(item).join('');
  $('swaps').innerHTML = html;
  if (!running) { $('findUpgrades').disabled = false; $('cancelUpgrades').hidden = true; }
}

$('swaps').addEventListener('click', async (e) => {
  const b = e.target.closest('button.apply');
  if (!b) return;
  try {
    const { text } = await api('/api/apply-swap', { text: $('deckText').value, cut: b.dataset.cut, add: b.dataset.add, copies: +b.dataset.copies });
    $('deckText').value = text;
    inspect();
    b.disabled = true; b.textContent = 'Applied';
    toast(`Swapped in ${b.dataset.add}. Run the gauntlet again to make it the new baseline, then save the deck.`);
  } catch (err) { toast(err.message, true); }
});

// ------------------------------------------------------------------ start
loadState().then(async () => {
  const last = recall('deck', '');
  if (last && state.decks.some(d => d.file === last)) {
    $('deckSelect').value = last;
    $('deckSelect').dispatchEvent(new Event('change'));
  }
}).catch(e => toast(`Could not reach the Crucible server: ${e.message}`, true));
