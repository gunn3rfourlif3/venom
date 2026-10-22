/* Venom ward ledger.
   No build step and no framework: the API is read-only and the page is a
   few hundred lines, so a bundler would be more machinery than the job. */

const $ = (id) => document.getElementById(id);

const state = {
  user: null,
  wards: [],
  targets: new Map(),
  filters: { box: null, cls: null, munic: '' },
  openWard: null,
};

/* Null is a real answer: eo_act_votes is null until the declaration, and
   reliability is null for a zone that has never deployed. Zero and unknown
   mean opposite things here, so the interface must not collapse them. */
const NO_VALUE = '—';

const num = (v) => (v === null || v === undefined ? NO_VALUE : Math.round(v).toLocaleString('en-ZA'));
const pct = (v, dp = 1) => (v === null || v === undefined ? NO_VALUE : `${(v * 100).toFixed(dp)}%`);
const dec = (v, dp = 2) => (v === null || v === undefined ? NO_VALUE : Number(v).toFixed(dp));
const date = (v) => (v ? new Date(v).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' }) : NO_VALUE);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* Stored uppercase for the database's convenience, not the reader's. */
const sentence = (s) => (s ? s.charAt(0) + s.slice(1).toLowerCase() : s);

/* Every request the app makes goes through here, so counting them here is
   what makes one progress bar able to speak for the whole app rather than
   each screen having to remember to say it is busy. The counter, not a
   boolean: two requests in flight and one finishing must not read as idle. */
let inFlight = 0;

function setBusy(delta) {
  inFlight = Math.max(0, inFlight + delta);
  const bar = document.getElementById('progress');
  if (!bar) return;
  const busy = inFlight > 0;
  bar.classList.toggle('is-busy', busy);
  bar.setAttribute('aria-hidden', String(!busy));
  document.documentElement.classList.toggle('is-fetching', busy);
}

async function api(path, options) {
  setBusy(1);
  const started = performance.now();
  try {
    const res = await fetch(path, { credentials: 'same-origin', ...options });
    /* Every request times itself, so the readout is the real round trip
       rather than a number that sits there looking reassuring. On election
       day it is the first thing to look at when the board feels slow: it
       separates "the server is struggling" from "my connection is". */
    setLatency(performance.now() - started);
    if (res.status === 401) { showSignIn(); throw new Error('unauthenticated'); }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
    return await res.json();
  } catch (error) {
    setLatency(null);
    throw error;
  } finally {
    setBusy(-1);
  }
}

/** The topbar latency readout. Slow is a status, so it is coloured; fast is
 *  not news, so it is not. */
function setLatency(ms) {
  const el = document.getElementById('sys-lat');
  if (!el) return;
  if (ms == null) { el.textContent = '—'; el.className = 'v is-bad'; return; }
  const rounded = Math.round(ms);
  el.textContent = `${rounded}ms`;
  el.className = rounded > 2000 ? 'v is-bad' : rounded > 700 ? 'v is-warn' : 'v';
}

/** Marks a region as loading while a promise runs. Used where a wait has a
 *  place on screen — the ward list, a panel — so the bar says "something is
 *  happening" and the region says "this thing". */
async function whileLoading(elementId, work) {
  const el = document.getElementById(elementId);
  el?.classList.add('is-loading');
  el?.setAttribute('aria-busy', 'true');
  try {
    return await work();
  } finally {
    el?.classList.remove('is-loading');
    el?.setAttribute('aria-busy', 'false');
  }
}

/* ----------------------------------------------------------- sign in */

function showSignIn(message) {
  $('app').hidden = true;
  $('signin').hidden = false;
  const box = $('signin-error');
  box.hidden = !message;
  box.textContent = message ?? '';
}

$('signin-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    state.user = await api('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: $('email').value, password: $('password').value }),
    });
    $('signin').hidden = true;
    $('app').hidden = false;
    await start();
  } catch (error) {
    showSignIn(error.message === 'Invalid credentials'
      ? 'That email and password do not match an active account.'
      : error.message);
  }
});

$('signout').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  location.reload();
});

/* The three headline figures now live on the overview, which fetches them
   with everything else in one round trip. The old standalone statement strip
   and its loader are gone with it: one screen, one read. */

/* ----------------------------------------------------------- ledger */

async function loadWards() {
  // Two thousand rows over two requests takes a couple of seconds, and the
  // sidebar counts cannot be computed until both land. Until then the
  // filters are shown as placeholders rather than as zeros, because a zero
  // beside "Recruit" is a claim and a placeholder is not.
  document.querySelector('.filters')?.classList.add('is-waiting');
  return whileLoading('view-wards', async () => {
    const [wards, targets] = await Promise.all([
      api('/api/wards?limit=1000'),
      api('/api/targets?limit=1000'),
    ]);
    state.wards = wards.data;
    state.targets = new Map(targets.data.map((t) => [t.ward_id, t]));

    const municipalities = [...new Set(state.wards.map((w) => w.municipality))].sort();
    $('filter-munic').innerHTML = '<option value="">All</option>' +
      municipalities.map((m) => `<option>${esc(m)}</option>`).join('');

    document.querySelector('.filters')?.classList.remove('is-waiting');
    renderChips();
    renderLedger();
  });
}

function countBy(key, value) {
  return state.wards.filter((w) => (key === 'box'
    ? w.recommended_box === value
    : state.targets.get(w.ward_id)?.target_class === value)).length;
}

/* What each of the four means, in the words of the person using it rather
   than the words of the view that computes it. These are not restatements of
   the rule - the rule is the 2x2 above them - they are the instruction. */
const BOX_MEANING = {
  Recruit:  'Winnable, and nobody is standing. Find a candidate first.',
  Contest:  'Winnable, candidate in place. Put people and money here.',
  Hold:     'Not winnable, but we hold it. Defend, do not invest.',
  Abandon:  'Not winnable and nobody standing. Spend the day elsewhere.',
};

const CLASS_MEANING = {
  'ACT NOW': 'Close, and complaints are rising.',
  'WATCH': 'Close, but quiet for now.',
  'PRESSURE ONLY': 'Complaints are rising, but the ward is not close.',
  'QUIET': 'Neither close nor complaining.',
};

function renderChips() {
  const classes = ['ACT NOW', 'WATCH', 'PRESSURE ONLY', 'QUIET'];

  // The 2x2 cells are the filter. A chip row beside the grid would be the
  // same four buttons twice, and the grid is the half that explains itself.
  for (const [box, meaning] of Object.entries(BOX_MEANING)) {
    const cell = document.querySelector(`.matrix .chip[data-box="${box}"]`);
    if (!cell) continue;
    const n = countBy('box', box);
    cell.classList.toggle('is-on', state.filters.box === box);
    cell.title = meaning;
    cell.innerHTML = `${esc(box)}<span class="chip-n">${n}</span>`;
  }
  $('filter-box').innerHTML = state.filters.box
    ? `<p class="filter-note is-chosen">${esc(BOX_MEANING[state.filters.box])}</p>`
    : '';

  $('filter-class').innerHTML = classes.map((c) =>
    `<button class="chip${state.filters.cls === c ? ' is-on' : ''}" data-value="${esc(c)}"
       title="${esc(CLASS_MEANING[c] ?? '')}">${esc(sentence(c))}<span class="chip-n">${countBy('cls', c)}</span></button>`).join('');
}

document.querySelector('.matrix').addEventListener('click', (e) => {
  const cell = e.target.closest('.chip[data-box]'); if (!cell) return;
  const v = cell.dataset.box;
  state.filters.box = state.filters.box === v ? null : v;
  renderChips(); renderLedger();
});

function visibleWards() {
  return state.wards.filter((w) => {
    const target = state.targets.get(w.ward_id);
    if (state.filters.box && w.recommended_box !== state.filters.box) return false;
    if (state.filters.cls && target?.target_class !== state.filters.cls) return false;
    if (state.filters.munic && w.municipality !== state.filters.munic) return false;
    return true;
  });
}

function renderLedger() {
  const rows = visibleWards();
  $('filter-count').textContent =
    `${rows.length} of ${state.wards.length} wards`;
  $('ledger-empty').hidden = rows.length > 0;

  $('ledger').innerHTML = rows.map((w) => {
    const t = state.targets.get(w.ward_id);
    const urgent = w.gap_flag === 'URGENT';
    const band = t?.pressure_band ?? 'QUIET';
    const declineNeg = Number(w.rival_decline_share) < 0;
    const eoNeg = Number(w.eo_est_votes) < 0;
    return `
      <button class="line${urgent ? ' is-urgent' : ''}${state.openWard === w.ward_id ? ' is-open' : ''}"
              data-ward="${esc(w.ward_id)}"
              aria-label="Ward ${esc(w.ward_id)}, ${esc(w.municipality)}, ${esc(w.recommended_box)}">
        <span class="mark"></span>
        <span class="rank">${w.priority_rank ?? NO_VALUE}</span>
        <span class="ward">${esc(w.ward_id)}</span>
        <span class="munic">${esc(w.municipality)}</span>
        <span class="box box-${esc(w.recommended_box)}">${esc(w.recommended_box)}</span>
        <span class="press press-${esc(band)}">${esc(band.toLowerCase())}</span>
        <span class="num${declineNeg ? ' is-negative' : ''}${w.rival_decline_share === null ? ' is-null' : ''}">${pct(w.rival_decline_share, 1)}</span>
        <span class="num${eoNeg ? ' is-negative' : ''}">${num(w.eo_est_votes)}</span>
      </button>`;
  }).join('');
}

$('filter-box').addEventListener('click', (e) => {
  const btn = e.target.closest('.chip'); if (!btn) return;
  const v = btn.dataset.value;
  state.filters.box = state.filters.box === v ? null : v;
  renderChips(); renderLedger();
});
$('filter-class').addEventListener('click', (e) => {
  const btn = e.target.closest('.chip'); if (!btn) return;
  const v = btn.dataset.value;
  state.filters.cls = state.filters.cls === v ? null : v;
  renderChips(); renderLedger();
});
$('filter-munic').addEventListener('change', (e) => {
  state.filters.munic = e.target.value;
  renderLedger();
});
$('ledger').addEventListener('click', (e) => {
  const line = e.target.closest('.line'); if (!line) return;
  openDossier(line.dataset.ward);
});

/* ---------------------------------------------------------- dossier */

async function openDossier(wardId) {
  state.openWard = wardId;
  renderLedger();
  $('dossier').hidden = false;
  $('scrim').hidden = false;
  $('dossier-body').innerHTML = '<p class="sub">Loading.</p>';

  const { data: d } = await api(`/api/wards/${encodeURIComponent(wardId)}`);
  const kv = (pairs) => `<dl class="kv">${pairs
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;

  const issues = d.issues.length ? `<div class="rows">${d.issues.map((i) => `
    <div class="row-item">
      <strong>${esc(i.category)}</strong>, ${esc(i.severity.toLowerCase())}
      ${i.resolved_at ? '<span class="meta"> — resolved</span>' : ''}
      <div>${esc(i.summary)}</div>
      <div class="meta">Seen ${date(i.first_seen)} to ${date(i.last_seen)}</div>
    </div>`).join('')}</div>` : '<p class="tag">No grievances recorded.</p>';

  const decisions = d.decisions.length ? `<div class="rows">${d.decisions.map((x) => `
    <div class="row-item">
      <strong>${esc(x.headline)}</strong>
      <div>${esc(x.rationale)}</div>
      <div class="meta">${date(x.taken_on)}, ${esc(x.taken_by ?? 'unknown')}
        ${x.unevidenced_flag ? '<span class="flagged">— no evidence attached</span>'
                             : `— ${x.evidence_items} evidence item${x.evidence_items === 1 ? '' : 's'}`}</div>
    </div>`).join('')}</div>` : '<p class="tag">No decisions recorded.</p>';

  const documents = d.documents.length ? `<div class="rows">${d.documents.map((x) => `
    <div class="row-item"><strong>${esc(x.title)}</strong>
      <div class="meta">${esc(x.kind)}, ${esc(x.sensitivity.toLowerCase())}, ${date(x.document_date)}</div>
    </div>`).join('')}</div>` : '<p class="tag">No documents linked.</p>';

  $('dossier-body').innerHTML = `
    <h2>${esc(d.ward_id)}</h2>
    <p class="sub">${esc(d.municipality)}${d.zone ? `, ${esc(d.zone)}` : ''}</p>
    <p class="reading">${esc(d.target_reading ?? '')}</p>

    <h3>Standing</h3>
    ${kv([
      ['Recommended', esc(d.recommended_box)],
      ['Priority rank', d.priority_rank ?? NO_VALUE],
      ['Target', esc(sentence(d.target_class ?? NO_VALUE))],
      ['Contestable', d.is_contestable ? 'yes' : 'no'],
    ])}

    <h3>Arithmetic</h3>
    ${kv([
      ['Registered voters', num(d.registered_voters)],
      ['Our share of the pool', pct(d.our_pool_share)],
      ['Rival share 2021', pct(d.rival_share_2021)],
      ['Rival share 2024', pct(d.rival_share_2024)],
      ['Rival decline', pct(d.rival_decline_share, 1)],
      ['Headroom', num(d.headroom)],
      ['Activation gap', `${dec(d.activation_gap)} points`],
    ])}

    <h3>Ledger</h3>
    ${kv([
      ['Potential', num(d.a_potential_votes)],
      ['Eroding', num(d.l_eroding_votes)],
      ['Expected outcome', num(d.eo_est_votes)],
      ['Declared result', num(d.eo_act_votes)],
    ])}

    <h3>Capacity</h3>
    ${kv([
      ['Claimed, weekday', num(d.m1_weekday)],
      ['Delivered last time', num(d.m3_last_actual)],
      ['Reliability', d.reliability_ratio === null ? 'never deployed' : dec(d.reliability_ratio)],
      ['Plan with', num(d.m1_discounted)],
      ['Cost per body', d.cost_per_body_planned === null ? NO_VALUE : `R${dec(d.cost_per_body_planned, 0)}`],
    ])}

    <h3>Liabilities</h3>
    ${kv([
      ['Candidate', d.candidate_shortage ? 'none confirmed' : 'confirmed'],
      ['People short', num(d.people_shortage)],
      ['Stations covered', `${num(d.stations_covered)} of ${num(d.stations_total)}`],
      ['Pledges secured', num(d.pledges_total)],
    ])}

    <h3>Pressure</h3>
    ${kv([
      ['Band', esc(d.pressure_band ?? NO_VALUE)],
      ['Open grievances', num(d.open_issues)],
      ['Serious', num(d.serious_issues)],
      ['Unplanned outages', num(d.unplanned_outages)],
    ])}
    ${issues}

    <h3>Decisions</h3>
    ${decisions}

    <h3>Documents</h3>
    ${documents}
  `;
}

function closeDossier() {
  $('dossier').hidden = true;
  $('scrim').hidden = true;
  state.openWard = null;
  renderLedger();
}
$('dossier-close').addEventListener('click', closeDossier);
$('scrim').addEventListener('click', closeDossier);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDossier(); });


/* ------------------------------------------------------- sentiment */

/* The canonical order, then anything else the data actually contains. A
   fixed list silently dropped categories a source did produce — the screen
   said "11 issues tracked" above a grid showing eight. */
const CATEGORY_ORDER = ['Water','Electricity','Refuse','Roads','Housing',
                        'Sanitation','Safety','Health','Transport','Billing','Other'];

const orderedCategories = (rows) => {
  const present = new Set(rows.map((r) => r.category));
  return [...CATEGORY_ORDER.filter((c) => present.has(c)),
          ...[...present].filter((c) => !CATEGORY_ORDER.includes(c)).sort()];
};
const BAND_ORDER = ['Strongly negative','Negative','Mixed','Positive','Strongly positive'];
const BAND_VAR = {
  'Strongly negative': '--div-neg-2', 'Negative': '--div-neg-1',
  'Mixed': '--div-mid', 'Positive': '--div-pos-1', 'Strongly positive': '--div-pos-2',
};

const tip = () => $('tip');
function showTip(event, html) {
  const t = tip();
  t.innerHTML = html;
  t.hidden = false;
  const pad = 14;
  const r = t.getBoundingClientRect();
  let x = event.clientX + pad;
  let y = event.clientY + pad;
  if (x + r.width > window.innerWidth - 8) x = event.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = event.clientY - r.height - pad;
  t.style.left = `${Math.max(8, x)}px`;
  t.style.top = `${Math.max(8, y)}px`;
}
function hideTip() { tip().hidden = true; }

/** Attaches hover to every mark carrying data-tip. A chart in a browser is
 *  interactive by nature; shipping one without a hover layer wastes it. */
function bindTips(root) {
  root.querySelectorAll('[data-tip]').forEach((el) => {
    el.addEventListener('mousemove', (e) => showTip(e, el.dataset.tip));
    el.addEventListener('mouseleave', hideTip);
    el.addEventListener('focus', (e) => showTip(
      { clientX: el.getBoundingClientRect().left, clientY: el.getBoundingClientRect().top },
      el.dataset.tip));
    el.addEventListener('blur', hideTip);
  });
}

const seqStep = (t) => {
  // seven steps, low -> high; low sits nearest the surface
  const i = Math.max(1, Math.min(7, Math.ceil(t * 7) || 1));
  return `var(--seq-${i})`;
};

function renderHeatmap(area) {
  const municipalities = [...new Set(area.map((r) => r.municipality))].sort();
  const cats = orderedCategories(area);
  const byKey = new Map(area.map((r) => [`${r.municipality}|${r.category}`, r]));
  const max = Math.max(1, ...area.map((r) => Number(r.mentions)));

  const left = 150, top = 26, cw = 84, ch = 38, gap = 2;
  const w = left + cats.length * cw;
  const h = top + municipalities.length * ch + 6;

  const cells = municipalities.map((m, row) => cats.map((c, col) => {
    const r = byKey.get(`${m}|${c}`);
    const n = r ? Number(r.mentions) : 0;
    const t = n / max;
    const x = left + col * cw, y = top + row * ch;
    // The figure sits on its own cell, so the ink has to beat the cell it sits
    // on, not the page. Measured both ways across the ramp: the dark ink wins
    // steps 1-4, the surface wins 5-7. Worst case either side of that line is
    // 4.4:1 light / 3.8:1 dark; ink-2 on step 3 was 2.9:1, which is why the
    // mid-blue cells read as smudges. Exact values live in the table view.
    const step = Math.max(1, Math.min(7, Math.ceil(t * 7) || 1));
    const label = n ? `<text x="${x + cw / 2 - 1}" y="${y + ch / 2 + 4}" text-anchor="middle"
        font-size="11.5" fill="${step >= 5 ? 'var(--surface)' : 'var(--ink)'}"
        style="pointer-events:none">${n.toLocaleString('en-ZA')}</text>` : '';
    const tipHtml = r
      ? `<b>${esc(m)}</b><br>${esc(c)}<br>${n.toLocaleString('en-ZA')} mentions across ${r.wards} wards<br>net sentiment ${dec(r.net_sentiment)}, mostly ${esc(r.dominant_tone.toLowerCase())}`
      : `<b>${esc(m)}</b><br>${esc(c)}<br>no signal`;
    return `<rect class="cell" x="${x}" y="${y}" width="${cw - gap}" height="${ch - gap}" rx="2"
       fill="${n ? seqStep(t) : 'var(--rule-hair)'}" tabindex="0"
       data-tip="${esc(tipHtml).replace(/&lt;/g, '<').replace(/&gt;/g, '>')}"/>${label}`;
  }).join('')).join('');

  const rowLabels = municipalities.map((m, row) =>
    `<text x="${left - 12}" y="${top + row * ch + ch / 2 + 4}" text-anchor="end"
       font-size="12" fill="var(--ink-2)">${esc(m)}</text>`).join('');
  const colLabels = cats.map((c, col) =>
    `<text x="${left + col * cw + (cw - gap) / 2}" y="${top - 10}" text-anchor="middle"
       font-size="11.5" fill="var(--ink-3)">${esc(c)}</text>`).join('');

  $('sent-heatmap').innerHTML =
    `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img"
       aria-label="Mentions by municipality and issue category">${colLabels}${rowLabels}${cells}</svg>`;

  $('sent-heatmap-legend').innerHTML =
    `<span>fewer</span>` +
    [1,2,3,4,5,6,7].map((i) => `<span><i style="background:var(--seq-${i})"></i></span>`).join('') +
    `<span>more, to ${max.toLocaleString('en-ZA')}</span>`;
  bindTips($('sent-heatmap'));
}

function renderBands(bands) {
  const municipalities = [...new Set(bands.map((r) => r.municipality))].sort();
  const byMun = new Map();
  for (const r of bands) {
    if (!byMun.has(r.municipality)) byMun.set(r.municipality, new Map());
    byMun.get(r.municipality).set(r.band, Number(r.share));
  }

  const left = 150, top = 8, rowH = 34, barH = 18, half = 300, gap = 2;
  const gutter = 96;   // "100% negative" at 11.5px needs ~84; the old 60 clipped it
  const w = left + half * 2 + gutter;
  const h = top + municipalities.length * rowH + 26;
  const mid = left + half;

  const rows = municipalities.map((m, i) => {
    const shares = byMun.get(m) ?? new Map();
    const y = top + i * rowH + (rowH - barH) / 2;
    // negative arm grows leftward from the centre, positive rightward,
    // and Mixed straddles so the centre line means "nothing either way"
    const neg = ['Negative', 'Strongly negative'];
    const pos = ['Positive', 'Strongly positive'];
    const mixed = shares.get('Mixed') ?? 0;

    let segs = '';
    let x = mid - (mixed * half) / 2;
    segs += seg(x, y, (mixed * half), 'Mixed', m, mixed);
    let cursor = x;
    for (const b of neg) {
      const sv = shares.get(b) ?? 0;
      const wpx = sv * half;
      cursor -= wpx;
      segs += seg(cursor, y, wpx, b, m, sv);
    }
    cursor = x + mixed * half;
    for (const b of pos) {
      const sv = shares.get(b) ?? 0;
      const wpx = sv * half;
      segs += seg(cursor, y, wpx, b, m, sv);
      cursor += wpx;
    }
    const negTotal = neg.reduce((a, b) => a + (shares.get(b) ?? 0), 0);
    return `<text x="${left - 12}" y="${y + barH / 2 + 4}" text-anchor="end"
        font-size="12" fill="var(--ink-2)">${esc(m)}</text>${segs}` +
      `<text x="${w - 8}" y="${y + barH / 2 + 4}" text-anchor="end" font-size="11.5"
        fill="var(--ink-2)">${pct(negTotal, 0)} negative</text>`;

    function seg(sx, sy, sw, band, mun, share) {
      if (sw <= 0.4) return '';
      const t = `<b>${esc(mun)}</b><br>${esc(band)}<br>${pct(share, 1)} of mentions`;
      return `<rect class="seg" x="${sx + gap / 2}" y="${sy}" width="${Math.max(0.5, sw - gap)}"
         height="${barH}" rx="1.5" fill="var(${BAND_VAR[band]})" tabindex="0"
         data-tip="${t}"/>`;
    }
  }).join('');

  $('sent-bands').innerHTML =
    `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img"
       aria-label="Share of mentions by sentiment band, per municipality">
       <line x1="${mid}" y1="${top - 2}" x2="${mid}" y2="${h - 22}"
         stroke="var(--axis)" stroke-width="1"/>
       ${rows}
       <text x="${mid}" y="${h - 6}" text-anchor="middle" font-size="11"
         fill="var(--ink-3)">mixed</text></svg>`;

  $('sent-bands-legend').innerHTML = BAND_ORDER.map((b) =>
    `<span><i style="background:var(${BAND_VAR[b]})"></i>${esc(b)}</span>`).join('');
  bindTips($('sent-bands'));
}

function renderTrend(trend) {
  const cats = orderedCategories(trend);
  const weeks = [...new Set(trend.map((r) => r.week_start))].sort();
  const max = Math.max(1, ...trend.map((r) => Number(r.mentions)));
  const w = 220, h = 66, padX = 4, padY = 8;

  $('sent-trend').innerHTML = cats.map((c) => {
    const series = weeks.map((wk) => {
      const row = trend.find((r) => r.category === c && r.week_start === wk);
      return { wk, n: row ? Number(row.mentions) : 0, net: row ? row.net_sentiment : null };
    });
    const total = series.reduce((a, b) => a + b.n, 0);
    const x = (i) => padX + (i * (w - padX * 2)) / Math.max(1, series.length - 1);
    const y = (n) => h - padY - (n / max) * (h - padY * 2);
    const line = series.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(d.n).toFixed(1)}`).join(' ');
    const dots = series.map((d, i) =>
      `<circle class="dot" cx="${x(i).toFixed(1)}" cy="${y(d.n).toFixed(1)}" r="4.5"
         fill="var(--seq-5)" stroke="var(--surface)" stroke-width="2" tabindex="0"
         data-tip="<b>${esc(c)}</b><br>week of ${date(d.wk)}<br>${d.n.toLocaleString('en-ZA')} mentions<br>net sentiment ${dec(d.net)}"/>`).join('');
    return `<div class="sm-panel">
      <div class="sm-head"><span class="sm-name">${esc(c)}</span>
        <span class="sm-total">${total.toLocaleString('en-ZA')}</span></div>
      <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img"
        aria-label="${esc(c)}: ${total} mentions over ${series.length} weeks">
        <line x1="0" y1="${h - padY}" x2="${w}" y2="${h - padY}" stroke="var(--grid)"/>
        <path d="${line}" fill="none" stroke="var(--seq-5)" stroke-width="2"
          stroke-linejoin="round" stroke-linecap="round"/>
        ${dots}
      </svg></div>`;
  }).join('');
  bindTips($('sent-trend'));
}

function renderSentimentTable(area) {
  const rows = [...area].sort((a, b) => Number(b.mentions) - Number(a.mentions));
  $('sent-table').innerHTML = `<table>
    <thead><tr><th>Municipality</th><th>Issue</th><th class="n">Wards</th>
      <th class="n">Mentions</th><th class="n">Net sentiment</th><th>Mostly</th>
      <th class="n">Confidence</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${esc(r.municipality)}</td><td>${esc(r.category)}</td>
      <td class="n">${r.wards}</td>
      <td class="n">${Number(r.mentions).toLocaleString('en-ZA')}</td>
      <td class="n">${dec(r.net_sentiment)}</td>
      <td>${esc(r.dominant_tone)}</td>
      <td class="n">${dec(r.confidence)}</td></tr>`).join('')}</tbody></table>`;
}

/** An empty screen that says nothing is a bug, not a state. Each one names
 *  what is missing, why, and the command that fills it. */
function emptyState(title, why, command) {
  return `<div class="nothing">
      <h3>${esc(title)}</h3>
      <p>${esc(why)}</p>
      ${command ? `<code class="nothing-cmd">${esc(command)}</code>` : ''}
    </div>`;
}

let sentimentSource = null;

async function loadSentiment() {
  return whileLoading('view-sentiment', () => renderSentiment());
}

async function renderSentiment() {
  const q = sentimentSource ? `?source=${encodeURIComponent(sentimentSource)}` : '';
  const { data } = await api(`/api/sentiment${q}`);
  const s = data.summary;
  sentimentSource = data.chosen;

  // The feeds on offer, with what each measures. A real feed outranks the
  // synthetic one in the view that produces this list, so the screen opens
  // on real data as soon as any exists.
  $('sent-sources').innerHTML = (data.sources ?? []).map((src) => `
    <button class="src-pick${src.source_id === data.chosen ? ' is-on' : ''}"
            data-source="${esc(src.source_id)}">
      <span class="src-pick-name">${esc(src.label)}</span>
      <span class="src-pick-meta">${num(src.mentions)} mentions &middot; ${
        esc(String(src.geo_level).toLowerCase())} level</span>
    </button>`).join('');

  // Nothing at all in the table is a different situation from a connected
  // feed reading zero, and the screen used to show the same thing for both:
  // a row of zeros under a banner implying a feed was already attached.
  const hasSignal = Number(s?.signals ?? 0) > 0;
  $('view-sentiment').classList.toggle('is-empty', !hasSignal);

  if (!hasSignal) {
    $('sent-provenance').innerHTML = emptyState(
      'No sentiment signal loaded',
      'The tables exist but hold no rows. npm run migrate builds the schema '
      + 'and deliberately does not insert invented data, so the demonstration '
      + 'signal has to be loaded on purpose. Run this from the project folder:',
      'npm run seed');
    $('sent-kpis').innerHTML = '';
    for (const id of ['sent-heatmap', 'sent-bands', 'sent-trend', 'sent-table',
                      'sent-heatmap-legend', 'sent-bands-legend']) {
      const el = $(id); if (el) el.innerHTML = '';
    }
    return;
  }

  const chosen = (data.sources ?? []).find((x) => x.source_id === data.chosen);
  $('sent-sub').textContent = s.geo_level === 'MUNICIPALITY'
    ? 'Measured per municipality. Not broken down by ward, because this source does not know wards.'
    : 'Measured per ward.';

  $('sent-provenance').innerHTML = s.synthetic
    ? '<b>Synthetic data.</b> Every figure under this feed was generated for development and describes no real area. Nothing here may be read as what anyone actually thinks.'
    : `<b>${esc(chosen?.label ?? 'Connected feed')}.</b> This measures ${
        esc(chosen?.measures ?? 'signal from a connected source')}. Headlines are counted and scored, never stored. `
      + `Average classifier confidence ${dec(s?.confidence)}, which is the lexicon baseline being honest about itself.`;

  $('sent-kpis').innerHTML = [
    ['Mentions', num(s?.mentions)],
    [s?.geo_level === 'MUNICIPALITY' ? 'Municipalities' : 'Wards with signal',
     num(s?.geo_level === 'MUNICIPALITY' ? s?.places : s?.wards)],
    ['Issues tracked', num(s?.categories)],
    ['Net sentiment', dec(s?.net_sentiment), Number(s?.net_sentiment) < 0],
    ['Last observed', date(s?.last_observed)],
  ].map(([label, value, neg]) =>
    `<div class="kpi"><span class="kpi-value${neg ? ' is-negative' : ''}">${esc(value)}</span>
      <span class="kpi-label">${esc(label)}</span></div>`).join('');

  renderHeatmap(data.area);
  renderBands(data.bands);
  renderTrend(data.trend);
  renderSentimentTable(data.area);
}

/* ------------------------------------------------------ other views */

async function loadDecisions(q) {
  const { data } = await api(`/api/decisions${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  $('decision-list').innerHTML = data.length ? data.map((d) => `
    <article class="card-line${d.unevidenced_flag ? ' is-flagged' : ''}">
      <h3>${esc(d.headline)}</h3>
      <p>${esc(d.rationale)}</p>
      <p class="meta">${date(d.taken_on)}, ${esc(d.taken_by ?? 'unknown')},
        ${esc(d.scope.toLowerCase())}${d.ward_id ? ` ${esc(d.ward_id)}` : d.municipality ? ` ${esc(d.municipality)}` : ''}
        ${d.unevidenced_flag ? '<span class="flagged">— no evidence attached</span>'
                             : `— ${d.evidence_items} evidence item${d.evidence_items === 1 ? '' : 's'}`}
        ${d.outcome ? `<br>Outcome: ${esc(d.outcome)}` : `<br>Open for ${d.days_open} days`}</p>
    </article>`).join('') : '<p class="empty">No decisions recorded yet.</p>';
}
$('decision-q').addEventListener('input', (e) => {
  clearTimeout(window.__dq);
  window.__dq = setTimeout(() => loadDecisions(e.target.value.trim()), 220);
});

async function loadFloat() {
  try {
    const { data } = await api('/api/float');
    $('float-list').innerHTML = data.length ? data.map((f) => `
      <article class="card-line">
        <h3>${esc(f.zone)}, week ending ${date(f.week_ending)}</h3>
        <p class="meta">Issued R${num(f.issued)}, accounted R${num(f.accounted)},
          gap R${num(f.shrinkage_actual)} (${dec(f.shrinkage_pct)}%)</p>
        <p class="meta">Acknowledged by ${esc(f.acknowledged_by)}, recorded by ${esc(f.recorded_by ?? 'unknown')}</p>
        <div class="bar"><span style="width:${Math.min(100, Math.max(0, Number(f.shrinkage_pct) || 0))}%"></span></div>
      </article>`).join('') : '<p class="empty">No float entries recorded yet.</p>';
  } catch (error) {
    $('float-list').innerHTML =
      `<p class="empty">The float ledger is open to treasurers and administrators. Your account is a ${esc(state.user?.role ?? 'viewer')}.</p>`;
  }
}

const ACCESS_NOTE = {
  OPEN: 'public endpoint, no credential',
  KEYED: 'free, but needs a registered client',
  METERED: 'billed per item returned',
  LICENSED: 'manual download under licence',
  CLOSED: 'not available to us',
};

async function loadHealth() {
  const { data } = await api('/api/ingest-health');
  const register = data.register ?? [];
  const ingest = data.ingest ?? [];

  // The register first: what Venom may read, and why. Half of these entries
  // exist to record a door that is shut, which is worth a line on screen so
  // nobody goes looking for it twice.
  $('source-register').innerHTML = register.map((s) => `
    <article class="source ${s.status === 'Closed' ? 'is-closed' : ''}">
      <div class="source-head">
        <h3>${esc(s.label)}</h3>
        <span class="source-status status-${esc(s.status.replace(/\s+/g, '-').toLowerCase())}">${esc(s.status)}</span>
      </div>
      <p class="source-access">${esc(s.access)} &mdash; ${esc(ACCESS_NOTE[s.access] ?? '')}${
        s.kind === 'SOCIAL' ? ' &middot; aggregate only, no posts stored' : ''}</p>
      ${s.measures ? `<p class="source-measures">Tells you ${esc(s.measures)}.</p>` : ''}
      <p class="source-notes">${esc(s.notes)}</p>
      <p class="meta">${
        s.last_ok_at ? `Last succeeded ${new Date(s.last_ok_at).toLocaleString('en-ZA')}` : 'Never succeeded'
      }${s.last_items_kept != null ? ` &middot; ${num(s.last_items_kept)} kept` : ''
      }${Number(s.cost_usd_30d) > 0 ? ` &middot; $${Number(s.cost_usd_30d).toFixed(2)} in 30 days` : ''
      }${s.failures ? ` &middot; ${s.failures} failed run${s.failures === 1 ? '' : 's'}` : ''}</p>
      ${s.last_error ? `<p class="source-error">${esc(s.last_error)}</p>` : ''}
      ${s.terms_url ? `<p class="meta"><a href="${esc(s.terms_url)}" target="_blank" rel="noopener">Terms</a></p>` : ''}
    </article>`).join('');

  $('health-list').innerHTML = ingest.length ? ingest.map((s) => `
    <article class="card-line">
      <h3>${esc(s.source)}</h3>
      <p class="meta">Last fetched ${s.last_fetch_at ? new Date(s.last_fetch_at).toLocaleString('en-ZA') : 'never'},
        last promoted ${s.last_promote_at ? new Date(s.last_promote_at).toLocaleString('en-ZA') : 'never'},
        ${s.errors_total} error${s.errors_total === 1 ? '' : 's'}, ${s.pending} pending</p>
    </article>`).join('')
    : '<p class="empty">No election data ingested yet. Run the baseline fetch once IEC credentials are issued.</p>';
}

/* ------------------------------------------------------------ views */

const VIEWS = ['logistics', 'slips', 'overview', 'wards', 'sentiment', 'decisions',
               'viewshed', 'float', 'health', 'settings'];

function showView(view) {
  document.querySelectorAll('.views button').forEach((b) =>
    b.classList.toggle('is-current', b.dataset.view === view));
  for (const name of VIEWS) $(`view-${name}`).hidden = name !== view;

  // The projection holds a WebGL context and an animation loop; leaving it
  // running behind a hidden pane burns a core for nothing.
  if (view !== 'viewshed') window.VenomViewshed?.hide();

  if (view === 'logistics') loadLogistics();
  if (view === 'slips') loadSlips();
  if (view === 'overview') loadOverview();
  if (view === 'sentiment') loadSentiment();
  if (view === 'decisions') loadDecisions();
  if (view === 'float') loadFloat();
  if (view === 'health') loadHealth();
  if (view === 'viewshed') loadViewshed();
  if (view === 'settings') loadControlPanel();
}

/* -------------------------------------------------------- overview */

const ISSUE_MAX_BARS = 8;

async function loadOverview() {
  let data;
  try {
    ({ data } = await api('/api/overview'));
  } catch (error) {
    $('ov-sub').textContent = `Could not read the overview: ${error.message}`;
    return;
  }

  const c = data.campaign;
  if (!c) {
    $('ov-sub').textContent = 'Nothing ingested yet. Run the baseline fetch once IEC credentials are issued.';
    return;
  }

  const potential = Number(c.a_total_votes);
  const eroding = Number(c.l_total_votes);
  const eo = Number(c.eo_est_votes);

  $('ov-sub').textContent =
    `${num(c.wards_total)} wards in Gauteng. ${num(c.wards_declared)} declared. `
    + `leakage charged against ${LEAKAGE_WORDS[c.leakage_basis] ?? c.leakage_basis}`;

  const eoEl = $('ov-eo');
  eoEl.textContent = num(eo);
  eoEl.classList.toggle('is-negative', eo < 0);

  // The bar is the subtraction: the whole width is what could be had, the
  // dimmed part is what is being lost, the accent is what survives it.
  const keep = potential > 0 ? Math.max(0, Math.min(1, eo / potential)) : 0;
  $('ov-bar').innerHTML =
    `<i class="is-keep" style="width:${(keep * 100).toFixed(1)}%"></i>`
    + `<i class="is-lose" style="width:${((1 - keep) * 100).toFixed(1)}%"></i>`;
  $('ov-legend').innerHTML =
    `<span><b>${num(potential)}</b>could be had</span>`
    + `<span><b>&minus;${num(eroding)}</b>eroding</span>`
    + `<span><b>${num(eo)}</b>expected</span>`;

  $('ov-stats').innerHTML = [
    ['Without a candidate', num(c.wards_no_candidate), Number(c.wards_no_candidate) > 0],
    ['People short', num(c.people_gap_total), Number(c.people_gap_total) > 0],
    ['Wards with signal', num(data.sentiment?.wards ?? 0), false],
    ['Act now', num(data.act_now.length), false],
  ].map(([label, value, bad]) =>
    `<div class="stat"><span class="stat-value${bad ? ' is-negative' : ''}">${esc(value)}</span>
       <span class="stat-label">${esc(label)}</span></div>`).join('');

  // Act now
  $('ov-act-note').textContent = data.act_now.length
    ? 'highest priority first' : '';
  $('ov-act').innerHTML = data.act_now.length ? data.act_now.map((w) => `
    <button class="rank-row${w.pressure_band === 'HIGH' ? ' is-urgent' : ''}" data-ward="${esc(w.ward_id)}">
      <i aria-hidden="true"></i>
      <span class="rank-ward"><b>${esc(w.ward_id)}</b><span>${esc(w.municipality)}</span></span>
      <span class="pill">${esc(w.recommended_box ?? '—')}</span>
      <span class="rank-num">${num(w.eo_est_votes)}</span>
    </button>`).join('')
    : emptyState('Nothing marked act-now',
        'No ward is both close enough to win and under rising complaint '
        + 'pressure, on the current thresholds. Those live in the control panel.',
        null);

  // Pressure by issue
  const issues = data.issues.slice(0, ISSUE_MAX_BARS);
  const issueMax = Math.max(1, ...issues.map((i) => Number(i.mentions)));
  $('ov-issues-note').textContent = data.sentiment?.synthetic
    ? 'synthetic data' : `${num(data.sentiment?.mentions ?? 0)} mentions`;
  $('ov-issues').innerHTML = issues.length ? issues.map((i) => `
    <div class="qbar">
      <span class="qbar-label">${esc(i.category)}</span>
      <span class="qbar-track"><span class="qbar-fill${Number(i.net) < -0.3 ? ' is-warn' : ''}"
        style="width:${((Number(i.mentions) / issueMax) * 100).toFixed(1)}%"></span></span>
      <span class="qbar-num">${num(i.mentions)}</span>
    </div>`).join('')
    : emptyState('No sentiment signal',
        'The schema is built but no signal has been loaded. The demonstration '
        + 'data is loaded on purpose, not by the migrator:', 'npm run seed');

  // Municipal finance, newest audited year
  const muni = data.municipal.slice(0, 8);
  const muniMax = Math.max(1, ...muni.map((m) => Number(m.value)));
  $('ov-municipal').innerHTML = muni.length ? muni.map((m) => `
    <div class="qbar">
      <span class="qbar-label">${esc(m.municipality.replace(/^City of /, ''))}
        <span class="qbar-sub">${esc(m.category ?? '')}</span></span>
      <span class="qbar-track"><span class="qbar-fill"
        style="width:${((Number(m.value) / muniMax) * 100).toFixed(1)}%"></span></span>
      <span class="qbar-num">R${(Number(m.value) / 1e9).toFixed(1)}bn</span>
    </div>`).join('')
    : emptyState('No Treasury figures yet',
        'Municipal Money is open and needs no credentials. This pulls the '
        + 'Gauteng municipality list and their audited service revenue:',
        'npm run sources:official -- 2023 2024');

  // Sources
  const live = data.sources.filter((s) => s.status === 'Live').length;
  $('ov-src-note').textContent = `${live} of ${data.sources.length} connected`;
  $('ov-sources').innerHTML = data.sources.map((s) => `
    <div class="src-row">
      <span>${esc(s.label)}</span>
      <span class="src-when">${s.last_ok_at
        ? new Date(s.last_ok_at).toLocaleDateString('en-ZA') : 'never'}</span>
      <span class="pill${s.status === 'Live' ? ' is-good' : s.status === 'Failing' ? ' is-warn' : ''}">
        <span class="pill-dot"></span>${esc(s.status.toLowerCase())}</span>
    </div>`).join('');
}

const LEAKAGE_WORDS = {
  ALL: 'all 2024 voters', POOL_SHARE: 'our share of the pool', OWN_VOTE: 'our own voters',
};

$('ov-act').addEventListener('click', (e) => {
  const row = e.target.closest('.rank-row');
  if (row) { showView('wards'); openDossier(row.dataset.ward); }
});

/* ---------------------------------------------------- control panel */

let cpValues = {};
let cpFields = [];

function cpDirty() {
  const form = $('cp-form');
  return cpFields.filter((f) => {
    const el = form.elements[f.key];
    if (!el) return false;
    return String(el.value) !== String(cpValues[f.key]);
  });
}

function cpRefreshState() {
  const dirty = cpDirty();
  for (const field of cpFields) {
    const wrap = document.getElementById(`cp-wrap-${field.key}`);
    if (wrap) wrap.classList.toggle('is-dirty', dirty.some((d) => d.key === field.key));
  }
  const state = $('cp-state');
  state.textContent = dirty.length === 0
    ? 'No changes'
    : `${dirty.length} change${dirty.length === 1 ? '' : 's'} not saved`;
  state.classList.toggle('is-dirty', dirty.length > 0);
  $('cp-save').disabled = dirty.length === 0 || state.dataset.readonly === 'true';
  $('cp-reset').disabled = dirty.length === 0;
}

async function loadControlPanel() {
  const { data } = await api('/api/control-panel');
  cpFields = data.fields;
  cpValues = data.values;

  const groups = [...new Set(cpFields.map((f) => f.group))];
  $('cp-groups').innerHTML = groups.map((group) => `
    <div class="cp-group">
      <div class="panel-head"><h2>${esc(group)}</h2></div>
      <div class="cp-fields">
        ${cpFields.filter((f) => f.group === group).map(cpFieldHtml).join('')}
      </div>
    </div>`).join('');

  const readonly = state.user?.role !== 'admin';
  $('cp-state').dataset.readonly = String(readonly);
  if (readonly) {
    for (const el of $('cp-form').elements) el.disabled = true;
    $('cp-state').textContent = `Read only — your account is a ${state.user?.role ?? 'viewer'}.`;
  }
  cpRefreshState();
}

function cpFieldHtml(f) {
  const value = cpValues[f.key];
  const control = f.kind === 'choice'
    ? `<select name="${esc(f.key)}" id="cp-${esc(f.key)}">${f.choices.map((c) =>
        `<option value="${esc(c.value)}"${String(value) === c.value ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select>`
    : `<input type="number" name="${esc(f.key)}" id="cp-${esc(f.key)}"
         value="${esc(String(value ?? ''))}" min="${f.min ?? ''}" max="${f.max ?? ''}"
         step="${f.step ?? 'any'}" inputmode="decimal">`;

  const chosen = f.kind === 'choice'
    ? f.choices.find((c) => c.value === String(value))
    : null;

  return `<div class="cp-field" id="cp-wrap-${esc(f.key)}">
      <label for="cp-${esc(f.key)}">${esc(f.label)}</label>
      ${control}
      <p class="cp-help">${esc(f.help)}</p>
      ${chosen ? `<p class="cp-choice-help" id="cp-chosen-${esc(f.key)}">${esc(chosen.help)}</p>` : ''}
    </div>`;
}

$('cp-form').addEventListener('input', (e) => {
  // A choice field explains itself as it changes, so the consequence is
  // visible before the save rather than after it.
  const field = cpFields.find((f) => f.key === e.target.name);
  if (field?.kind === 'choice') {
    const note = document.getElementById(`cp-chosen-${field.key}`);
    const chosen = field.choices.find((c) => c.value === e.target.value);
    if (note && chosen) note.textContent = chosen.help;
  }
  cpRefreshState();
});

$('cp-reset').addEventListener('click', () => { loadControlPanel(); });

$('cp-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const dirty = cpDirty();
  if (dirty.length === 0) return;

  const patch = {};
  for (const f of dirty) {
    const raw = $('cp-form').elements[f.key].value;
    patch[f.key] = f.kind === 'choice' ? raw : Number(raw);
  }

  $('cp-save').disabled = true;
  $('cp-state').textContent = 'Saving…';
  for (const f of cpFields) {
    document.getElementById(`cp-wrap-${f.key}`)?.classList.remove('is-bad');
    document.getElementById(`cp-err-${f.key}`)?.remove();
  }

  try {
    const response = await fetch('/api/control-panel', {
      method: 'PUT', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });

    if (response.status === 422) {
      const { problems } = await response.json();
      for (const p of problems) {
        const wrap = document.getElementById(`cp-wrap-${p.key}`);
        if (!wrap) continue;
        wrap.classList.add('is-bad');
        wrap.insertAdjacentHTML('beforeend',
          `<p class="cp-error" id="cp-err-${esc(p.key)}">${esc(p.message)}</p>`);
      }
      $('cp-state').textContent = 'Not saved — see the fields marked below.';
      $('cp-save').disabled = false;
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const { data } = await response.json();
    cpValues = data;
    $('cp-state').textContent = 'Saved. The model has been recomputed.';
    cpRefreshState();
    // Everything downstream reads these numbers, so the overview is wrong
    // until it is read again.
    if (!$('view-overview').hidden) loadOverview();
  } catch (error) {
    $('cp-state').textContent = `Not saved: ${error.message}`;
    $('cp-save').disabled = false;
  }
});

document.querySelector('.views').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]'); if (!btn) return;
  showView(btn.dataset.view);
});

/* -------------------------------------------------------- viewshed */

let viewshedModule = null;
async function loadViewshed() {
  // Loaded on demand: three.js is far larger than the rest of this app put
  // together, and most sessions never open this screen.
  if (!viewshedModule) viewshedModule = await import('/viewshed.js');
  await viewshedModule.show();
}

$('vs-exag').addEventListener('input', (e) => {
  $('vs-exag-out').textContent = `×${e.target.value}`;
});
$('vs-exag').addEventListener('change', (e) => {
  viewshedModule?.setExaggeration(Number(e.target.value));
});

/* ----------------------------------------------------------- theme */

const THEMES = ['dark', 'light', 'system'];
const THEME_LABEL = { dark: 'Dark', light: 'Light', system: 'System' };

function resolveTheme(choice) {
  if (choice !== 'system') return choice;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function applyTheme(choice) {
  document.documentElement.setAttribute('data-theme', resolveTheme(choice));
  $('theme-text').textContent = THEME_LABEL[choice];
  $('theme').setAttribute('aria-label', `Theme: ${THEME_LABEL[choice]}`);
  try { localStorage.setItem('venom-theme', choice); } catch { /* private window */ }
}

let themeChoice = 'dark';
try { themeChoice = localStorage.getItem('venom-theme') || 'dark'; } catch { /* ignore */ }
if (!THEMES.includes(themeChoice)) themeChoice = 'dark';
applyTheme(themeChoice);

$('theme').addEventListener('click', () => {
  themeChoice = THEMES[(THEMES.indexOf(themeChoice) + 1) % THEMES.length];
  applyTheme(themeChoice);
  // Charts read their colours from tokens at draw time, so anything already
  // on screen has to be redrawn rather than recoloured.
  if (!$('view-sentiment').hidden) loadSentiment();
  if (!$('view-viewshed').hidden) viewshedModule?.show();
});

matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (themeChoice === 'system') applyTheme('system');
});

/* ---------------------------------------------------------- search */

const SEARCH_KIND = { ward: 'Ward', document: 'Document', decision: 'Decision' };

let searchTimer = null;
let searchRows = [];
let searchActive = -1;

function closeSearch() {
  $('search-results').hidden = true;
  $('search-input').setAttribute('aria-expanded', 'false');
  searchActive = -1;
}

function renderSearch(rows) {
  searchRows = rows;
  searchActive = -1;
  const box = $('search-results');
  if (rows.length === 0) {
    box.innerHTML = '<p class="search-empty">Nothing matches.</p>';
  } else {
    box.innerHTML = rows.map((r, i) => `
      <button class="search-hit" role="option" id="search-hit-${i}" data-index="${i}"
              aria-selected="false">
        <span class="search-kind">${esc(SEARCH_KIND[r.kind] ?? r.kind)}</span>
        <span class="search-title">${esc(r.title)}</span>
        <span class="search-sub">${esc(r.subtitle ?? '')}</span>
      </button>`).join('');
  }
  box.hidden = false;
  $('search-input').setAttribute('aria-expanded', 'true');
}

function moveSearch(delta) {
  if (searchRows.length === 0) return;
  searchActive = (searchActive + delta + searchRows.length) % searchRows.length;
  document.querySelectorAll('.search-hit').forEach((el, i) => {
    const on = i === searchActive;
    el.classList.toggle('is-active', on);
    el.setAttribute('aria-selected', String(on));
    if (on) el.scrollIntoView({ block: 'nearest' });
  });
  $('search-input').setAttribute('aria-activedescendant',
    searchActive >= 0 ? `search-hit-${searchActive}` : '');
}

async function openHit(row) {
  closeSearch();
  $('search-input').value = '';
  if (row.kind === 'ward') { showView('wards'); await openDossier(row.id); }
  if (row.kind === 'decision') showView('decisions');
  if (row.kind === 'document') showView('decisions');
}

$('search-input').addEventListener('input', (e) => {
  const q = e.target.value.trim();
  clearTimeout(searchTimer);
  if (q.length < 2) { closeSearch(); return; }
  // Debounced: a query per keystroke would run the ward scan on every letter.
  searchTimer = setTimeout(async () => {
    try {
      const { data } = await api(`/api/search?q=${encodeURIComponent(q)}&limit=20`);
      renderSearch(data);
    } catch { closeSearch(); }
  }, 180);
});

$('search').addEventListener('submit', (e) => {
  e.preventDefault();
  const row = searchRows[searchActive >= 0 ? searchActive : 0];
  if (row) openHit(row);
});

$('search-results').addEventListener('click', (e) => {
  const hit = e.target.closest('.search-hit');
  if (hit) openHit(searchRows[Number(hit.dataset.index)]);
});

$('search-input').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); moveSearch(1); }
  if (e.key === 'ArrowUp') { e.preventDefault(); moveSearch(-1); }
  if (e.key === 'Escape') { closeSearch(); e.target.blur(); }
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('#search')) closeSearch();
});

// '/' focuses search, the convention everywhere text is searched.
document.addEventListener('keydown', (e) => {
  const typing = /^(input|textarea|select)$/i.test(e.target.tagName) || e.target.isContentEditable;
  if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) {
    e.preventDefault(); $('search-input').focus();
  }
  if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault(); $('search-input').focus();
  }
});

/* ------------------------------------------------------------- live */

function connectLive() {
  const source = new EventSource('/api/live');
  const el = $('live');
  source.addEventListener('ready', () => {
    el.className = 'live is-live'; $('live-text').textContent = 'live';
  });
  // The push carries an identifier, never a value: read back through the
  // same queries used on load so the screen cannot drift from the database.
  source.addEventListener('extract_stale', () => { loadOverview(); loadWards(); });
  source.addEventListener('ward_changed', () => { loadWards(); });
  source.onerror = () => {
    el.className = 'live is-down'; $('live-text').textContent = 'reconnecting';
  };
}

/* ------------------------------------------------------------ start */

async function start() {
  $('who').textContent = `${state.user.display_name ?? state.user.user_id}, ${state.user.role}`;
  // Overview first: it is the screen that is showing. The ledger loads
  // behind it so switching to Wards is instant.
  await loadOverview();
  loadWards();
  connectLive();
}

(async function boot() {
  try {
    const me = await api('/api/me');
    state.user = me;
    $('signin').hidden = true;
    $('app').hidden = false;
    await start();
  } catch {
    showSignIn();
  }
})();


$('sent-sources').addEventListener('click', (e) => {
  const pick = e.target.closest('.src-pick'); if (!pick) return;
  sentimentSource = pick.dataset.source;
  loadSentiment();
});

/* ------------------------------------------------------- logistics */

const PRESENCE = {
  UNSTAFFED:    { cls: 'is-bad',     word: 'Unstaffed',    rank: 0, row: 'needs-action' },
  NO_REPORT:    { cls: 'is-unknown', word: 'No report',    rank: 1, row: 'needs-watch' },
  STALE:        { cls: 'is-warn',    word: 'Stale',        rank: 2, row: 'needs-watch' },
  UNDERSTAFFED: { cls: 'is-warn',    word: 'Understaffed', rank: 3, row: 'needs-watch' },
  NO_PLAN:      { cls: 'is-unknown', word: 'No plan',      rank: 4, row: '' },
  STAFFED:      { cls: 'is-good',    word: 'Staffed',      rank: 5, row: '' },
};
const SUPPLY = {
  SUPPLY_BROKEN:  { cls: 'is-bad',     word: 'Broken' },
  SUPPLY_PARTIAL: { cls: 'is-warn',    word: 'Partial' },
  SUPPLY_PENDING: { cls: 'is-warn',    word: 'In transit' },
  // Not 'OK'. Nothing was dispatched to this ward, which is an absence of
  // information rather than a delivery that went well.
  SUPPLY_NONE:    { cls: 'is-unknown', word: 'None sent' },
  SUPPLY_OK:      { cls: 'is-good',    word: 'Arrived' },
};

let logiFilter = '';

/** num() is the house formatter but returns the no-value dash for null; the
 *  tiles also pass an already-formatted string like "87.5%", which must not
 *  go through Math.round. */
const fmt = (v) => (typeof v === 'string' ? v : num(v));

/** "14m", "3h 20m", "—". A duration nobody has to divide by 60 themselves. */
function since(minutes) {
  if (minutes == null) return '—';
  const m = Math.round(Number(minutes));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

const pill = (cls, word) => `<span class="pill ${cls}">${esc(word)}</span>`;

async function loadLogistics() {
  let data;
  try {
    /* Three states, and they ask the server three different questions.
       A named flag asks for that flag; "all" asks for everything; the
       default — Exceptions — asks for only the stations where something has
       happened, so the rows the screen would discard are never sent. */
    const query = logiFilter === 'all' ? ''
      : logiFilter ? `?presence=${encodeURIComponent(logiFilter)}`
        : '?mode=exceptions';
    ({ data } = await api(`/api/logistics${query}`));
  } catch (error) {
    $('lg-sub').textContent = `Could not read the ground: ${error.message}`;
    return;
  }

  const r = data.rollup;
  if (!r || Number(r.stations_total) === 0) {
    $('lg-sub').textContent =
      'No voting stations are loaded yet. Run `npm run sources:register` to build the register.';
    $('lg-tiles').innerHTML = '';
    $('lg-rows').innerHTML = '';
    return;
  }

  /* The marshal roster: who automated ingest will accept a report from.
   Fetched separately from the board for the same reason as alerts — an
   administrative list must never be able to stop the operational screen
   from rendering. */
async function loadRoster() {
  const host = $('lg-roster-list');
  const count = $('lg-roster-count');
  if (!host) return;
  let data;
  try { ({ data } = await api('/api/roster')); }
  catch { if (count) count.textContent = 'could not read the roster'; return; }

  const rows = data || [];
  const on = rows.filter((r) => r.enabled).length;
  if (count) {
    count.textContent = rows.length === 0
      ? 'nobody on the roster yet'
      : `${fmt(on)} enabled${rows.length > on ? `, ${fmt(rows.length - on)} off` : ''}`;
  }

  if (rows.length === 0) {
    /* The empty state is load-bearing here. An empty roster is not a blank
       screen, it is a system that will refuse every report that arrives —
       so it says so rather than showing nothing. */
    host.innerHTML = `<p class="viz-sub">
      Until somebody is on this list, every message to the reporting number
      is refused. The paste form above still works, because a person filing
      on behalf of the ground is authenticated by their own sign-in.</p>`;
    return;
  }

  const shown = rows.slice(0, 40);
  host.innerHTML = `
    <table class="logi-table">
      <thead><tr><th>Name</th><th>Number</th><th>Last heard</th><th>State</th>
        <th>Slip link</th></tr></thead>
      <tbody>
        ${shown.map((r, i) => `<tr>
          <td data-k="Name">${esc(r.display_name)}</td>
          <td data-k="Number"><span class="id">…${esc(String(r.phone).slice(-4))}</span></td>
          <td data-k="Last heard">${r.last_message_at
            ? esc(since((Date.now() - new Date(r.last_message_at).getTime()) / 60000))
            : '—'}</td>
          <td data-k="State">${r.enabled
            ? pill('is-good', 'enabled') : pill('is-unknown', 'off')}</td>
          <td data-k="Slip link">${r.capture_token
            ? `<button class="btn roster-copy" data-i="${i}">Copy</button>`
            : (r.has_link ? '<span class="viz-sub">issued</span>'
                          : '<span class="viz-sub">—</span>')}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    ${rows.length > shown.length
      ? `<p class="viz-sub">…and ${fmt(rows.length - shown.length)} more.</p>` : ''}`;

  /* The token is never printed on screen. HQ screens are shared and left
     open; a live upload credential sitting in a table is the same mistake as
     printing full phone numbers, which this panel already avoids. The button
     puts the link on the clipboard so it can be pasted straight into the
     marshal's WhatsApp thread. */
  host.querySelectorAll('.roster-copy').forEach((el) => {
    el.addEventListener('click', async () => {
      const r = shown[Number(el.dataset.i)];
      const link = `${location.origin}/slip.html#t=${r.capture_token}`;
      try {
        await navigator.clipboard.writeText(link);
        el.textContent = 'Copied';
      } catch {
        /* Clipboard access is refused on an insecure origin and in some
           embedded browsers. Falling back to a prompt is ugly but leaves the
           operator with the link rather than a button that did nothing. */
        window.prompt(`Link for ${r.display_name}:`, link);
      }
      setTimeout(() => { el.textContent = 'Copy'; }, 2000);
    });
  });
}

/* Only the last four digits are ever shown. HQ needs to recognise a marshal,
   not to read a phone book off a screen left open on a desk — the same
   reasoning as v_ingest_exceptions. */

$('lg-roster-add')?.addEventListener('click', async () => {
  const text = $('lg-roster-paste')?.value ?? '';
  const note = $('lg-roster-note');
  if (text.trim() === '') { if (note) note.textContent = 'Nothing pasted.'; return; }

  const button = $('lg-roster-add');
  button.disabled = true;
  if (note) note.textContent = 'Adding…';
  try {
    const { data } = await api('/api/roster', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const refused = data.refused || [];
    if (note) {
      const parts = [`${fmt(data.added)} added`];
      /* "already on roster" is not a failure, but it is not an addition
         either. Re-pasting a list is normal; saying so stops the count
         being read as growth. */
      if (data.updated > 0) parts.push(`${fmt(data.updated)} already on roster`);
      if (refused.length) parts.push(`${fmt(refused.length)} refused`);
      note.textContent = parts.join(', ');
    }
    if (data.added > 0 || data.updated > 0) $('lg-roster-paste').value = '';
    await loadRoster();

    /* Refusals are named, not counted. "2 refused" tells the operator
       nothing they can act on; the line that failed and why does.
       Rendered AFTER loadRoster, because loadRoster replaces this element's
       contents — writing the refusals first meant they appeared and were
       wiped in the same tick, leaving a count and no detail. */
    if (refused.length > 0) {
      $('lg-roster-list').insertAdjacentHTML('afterbegin',
        `<div class="roster-refused">
          <strong>${fmt(refused.length)} line${refused.length === 1 ? '' : 's'} not added</strong>
          ${refused.map((r) => `<div><code>${esc(r.line)}</code> — ${esc(r.reason)}</div>`).join('')}
        </div>`);
    }
  } catch (error) {
    if (note) note.textContent = `Failed: ${error.message}`;
  } finally {
    button.disabled = false;
  }
});

/* Open alerts. Fetched separately from the board so that a slow or failing
   alerts query cannot stop the logistics screen from rendering - the screen
   is more important than the banner on it. */
async function loadAlerts() {
  const host = $('lg-alerts');
  if (!host) return;
  let data;
  try { ({ data } = await api('/api/alerts?limit=20')); }
  catch { host.hidden = true; return; }

  const list = data.alerts || [];
  if (list.length === 0) { host.hidden = true; host.innerHTML = ''; return; }
  host.hidden = false;

  const serious = list.filter((a) => a.severity === 'serious').length;
  /* A band, not a second table. The engine already caps what it raises;
     this caps what is shown, for the same reason - past half a dozen, a
     longer list stops adding anything and starts pushing the board off
     screen. The count in the header stays truthful about the total. */
  const SHOW = 6;
  const shown = list.slice(0, SHOW);
  const more = list.length - shown.length;
  host.innerHTML = `
    <div class="panel-head">
      <h2 class="viz-title" style="margin:0">Open alerts</h2>
      <span class="viz-sub" style="margin:0">${fmt(list.length)} unacknowledged${
        serious ? `, ${fmt(serious)} serious` : ''}</span>
    </div>
    <ul class="alert-list">
      ${shown.map((a) => `
        <li class="alert-item ${a.severity === 'serious' ? 'is-serious' : 'is-warn'}">
          <span class="ak">${esc(a.kind.replace(/_/g, ' ').toLowerCase())}</span>
          <span class="ab">${esc(a.body)}</span>
          <span class="at">${esc(since((Date.now() - new Date(a.raised_at).getTime()) / 60000))}</span>
          ${a.delivery_error
            ? '<span class="pill is-bad" title="' + esc(a.delivery_error) + '">not delivered</span>'
            : ''}
          <button class="btn ack" data-ack="${a.alert_id}">Ack</button>
        </li>`).join('')}
    </ul>
    ${more > 0 ? `<p class="viz-sub">…and ${fmt(more)} more open. `
      + `Acknowledge these to see the rest.</p>` : ''}`;
}

$('lg-alerts')?.addEventListener('click', async (e) => {
  const id = e.target?.dataset?.ack;
  if (!id) return;
  e.target.disabled = true;
  try { await api(`/api/alerts/${id}/ack`, { method: 'POST' }); await loadAlerts(); }
  catch (error) { e.target.disabled = false; toast?.(`Could not acknowledge: ${error.message}`); }
});

/* Silence, by municipality, as a band rather than as rows.
     Only drawn while silence is widespread: once most stations are
     reporting, a silent one IS an exception and belongs in the table with
     the others, so the band gets out of the way. */
  function renderSilence(areas, blind, total) {
    const host = $('lg-silence');
    if (!host) return;
    const widespread = total > 0 && blind / total > 0.25 && blind > 50;
    if (!widespread || areas.length === 0) { host.hidden = true; host.innerHTML = ''; return; }
    host.hidden = false;

    const top = areas.slice(0, 12);
    const rest = areas.length - top.length;
    host.innerHTML = `
      <div class="panel-head">
        <h2 class="viz-title" style="margin:0">Not heard from yet</h2>
        <span class="viz-sub" style="margin:0">${fmt(blind)} of ${fmt(total)} stations</span>
      </div>
      <p class="viz-sub">
        Listing these individually would put ${fmt(blind)} identical rows on
        screen, so they are counted by municipality instead. The table below
        shows only stations where something has actually happened.</p>
      <div class="silence-grid">
        ${top.map((a) => {
          const pct = a.stations > 0 ? Math.round((a.silent / a.stations) * 100) : 0;
          return `<div class="silence-item">
            <span class="sa">${esc(a.municipality)}</span>
            <span class="sb"><b>${fmt(a.silent)}</b> of ${fmt(a.stations)}</span>
            <span class="sbar" aria-hidden="true"><i style="width:${pct}%"></i></span>
          </div>`;
        }).join('')}
      </div>
      ${rest > 0 ? `<p class="viz-sub">…and ${fmt(rest)} more municipalities.</p>` : ''}`;
  }

  /* The headline sentence. Deliberately a sentence: "412 of 23,699 stations
     have not been heard from" is a thing somebody can repeat down a phone,
     and a row of numbers is not. */
  setRailStats(r.stations_total, data.provinces);
  const blind = Number(r.stations_blind);
  $('lg-sub').textContent =
    `${fmt(r.stations_total)} stations. ${fmt(blind)} not heard from, `
    + `${fmt(r.stations_unstaffed)} with nobody there, `
    + `${fmt(r.active_high_problems)} serious problems open.`;

  // --- status strip
  const t = data.thresholds || {};
  const rate = data.rate || {};
  const lastMin = rate.last_message_at
    ? (Date.now() - new Date(rate.last_message_at).getTime()) / 60000 : null;
  const silence = Number(t.ingest_silence_minutes ?? 20);
  const live = lastMin == null ? 'is-down' : lastMin > silence ? 'is-stale' : 'is-live';
  const liveWord = lastMin == null ? 'NO REPORTS YET'
    : lastMin > silence ? 'INGEST QUIET' : 'INGEST LIVE';

  $('lg-statline').innerHTML = `
    <div><span class="k">Ingest</span>
      <span class="v"><span class="pulse ${live}"></span>${liveWord}</span></div>
    <div><span class="k">Last report</span><span class="v">${since(lastMin)}</span></div>
    <div><span class="k">Filed this hour</span>
      <span class="v">${fmt(rate.filed_1h ?? 0)}</span></div>
    <div><span class="k">Refused</span>
      <span class="v ${Number(rate.refused_1h) > 0 ? 'is-warn' : ''}">${fmt(rate.refused_1h ?? 0)}</span></div>
    <div><span class="k">Stale after</span><span class="v">${fmt(t.report_stale_minutes ?? '—')}m</span></div>`;

  // --- tiles. Order is severity, not alphabet.
  const tile = (n, label, cls) =>
    `<div class="tile ${cls}"><span class="n">${fmt(n)}</span><span class="l">${label}</span></div>`;
  $('lg-tiles').innerHTML = [
    tile(r.stations_unstaffed, 'Unstaffed', Number(r.stations_unstaffed) > 0 ? 'is-alarm' : 'is-ok'),
    tile(r.supply_breaks, 'Supply breaks', Number(r.supply_breaks) > 0 ? 'is-alarm' : 'is-ok'),
    tile(r.stations_blind, 'Not heard from', Number(blind) > 0 ? 'is-warn' : 'is-ok'),
    tile(r.active_high_problems, 'Serious problems', Number(r.active_high_problems) > 0 ? 'is-alarm' : 'is-ok'),
    tile(`${r.staffed_pct ?? 0}%`, 'Staffed', 'is-quiet'),
  ].join('');

  // --- table
  const rows = (data.stations || []).slice();
  rows.sort((a, b) => {
    const pa = PRESENCE[a.presence_flag]?.rank ?? 9;
    const pb = PRESENCE[b.presence_flag]?.rank ?? 9;
    if (pa !== pb) return pa - pb;
    if ((a.severity === 'high') !== (b.severity === 'high')) return a.severity === 'high' ? -1 : 1;
    return String(a.station_id).localeCompare(String(b.station_id));
  });

  /* THE EXCEPTIONS VIEW DELIBERATELY DOES NOT LIST SILENCE.
     Before the first reporting cycle every station is NO_REPORT, so listing
     them put 19,803 identical rows on screen - an exception that applies to
     everything is not an exception (GOTCHAS.md G4). Silence is summarised
     by municipality above the table instead, and individual rows are kept
     for stations where something has actually happened: somebody reported
     and the news was bad, or supply failed.
     Asking for "No report" explicitly still lists them, because then it is
     what the operator went looking for. */
  const shown = logiFilter === 'all'
    ? rows
    : logiFilter
      ? rows.filter((s) => s.presence_flag === logiFilter)
      : rows.filter((s) =>
        (s.presence_flag !== 'STAFFED' && s.presence_flag !== 'NO_REPORT')
        || s.supply_flag === 'SUPPLY_BROKEN'
        || s.severity === 'high');

  renderSilence(data.silence || [], blind, Number(r.stations_total));
  loadAlerts();
  loadRoster();

  /* Three different numbers here, and conflating them is how a screen
     lies: `shown` is what passed the client filter, `rows.length` is what
     this page of the API returned, and `matching` is how many exist. When
     the server capped the page, say so - "400 of 400" on a register of
     23,699 reads as "that is all of them". */
  const matching = Number(data.matching ?? rows.length);
  const capped = matching > rows.length;
  $('lg-table-note').textContent = shown.length === 0
    ? 'Nothing needs attention right now.'
    : capped
      ? `Showing the worst ${fmt(shown.length)} of ${fmt(matching)} stations matching.`
      : `${fmt(shown.length)} of ${fmt(matching)} stations, worst first.`;

  $('lg-rows').innerHTML = shown.map((s) => {
    const p = PRESENCE[s.presence_flag] || { cls: 'is-unknown', word: s.presence_flag, row: '' };
    const sup = SUPPLY[s.supply_flag] || { cls: 'is-unknown', word: s.supply_flag };
    const serious = s.severity === 'high';
    return `<tr class="${p.row}">
      <td data-k="Station"><span class="id">${esc(s.station_id)}</span>
        <span class="sub">${esc(s.name || '')}</span></td>
      <td data-k="Ward">${esc(s.ward_id || '—')}
        <span class="sub">${esc(s.municipality || '')}</span></td>
      <td data-k="Presence">${pill(p.cls, p.word)}</td>
      <td data-k="Supply">${pill(sup.cls, sup.word)}</td>
      <td data-k="People" class="num">${s.people_now ?? 0}${
        s.expected_people ? `<span class="sub">of ${s.expected_people}</span>` : ''}</td>
      <td data-k="Queue">${esc(s.queue || 'unknown')}</td>
      <td data-k="Problem">${s.problem
        ? `${serious ? pill('is-bad', 'Serious') + ' ' : ''}${esc(s.problem)}` : '—'}</td>
      <td data-k="Last report" class="num">${since(s.minutes_since_report)}</td>
    </tr>`;
  }).join('');
}

/* --- intake: parse, show, then file. Never file what was not shown. */

let parsedLines = [];

/* The filter row. Delegated, like the rest of the shell's controls, so the
   buttons survive the table being re-rendered under them. */
document.addEventListener('click', (e) => {
  const b = e.target.closest('#lg-filter button');
  if (!b) return;
  logiFilter = b.dataset.flag ?? '';
  document.querySelectorAll('#lg-filter button').forEach((x) =>
    x.classList.toggle('is-on', x === b));
  loadLogistics();
});

document.addEventListener('click', (e) => {
  if (e.target.closest('#lg-check')) { e.preventDefault(); logiCheck(); }
  if (e.target.closest('#lg-file'))  { e.preventDefault(); logiFile(); }
});

async function logiCheck() {
  const text = $('lg-paste').value.trim();
  if (!text) return;
  $('lg-file').disabled = true;
  let data;
  try {
    ({ data } = await api('/api/booth-reports/parse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    }));
  } catch (error) {
    $('lg-parse-note').textContent = `Could not check: ${error.message}`;
    return;
  }

  parsedLines = (data.lines || []).filter((l) => l.error === null);
  $('lg-parse-note').textContent =
    `${data.ok} ready, ${data.bad} to fix.`;
  $('lg-file').disabled = data.ok === 0;

  $('lg-parse').innerHTML = (data.lines || []).map((l) => `
    <div class="parse-row ${l.error ? 'is-error' : ''}">
      <span class="ln">${l.line}</span>
      <span>${l.error
        ? esc(l.raw)
        : `<strong>${esc(l.stationId)}</strong> ${esc(l.stationName || '')} — `
          + `${esc(l.queue || '')}${l.peopleOnSite != null ? `, ${l.peopleOnSite} on site` : ''}`
          + `${l.problem ? `, ${esc(l.problem)}` : ''}`}</span>
      <span class="why">${l.error ? esc(l.error) : ''}</span>
    </div>`).join('');
}

async function logiFile() {
  const by = $('lg-by').value.trim();
  if (!by) { $('lg-parse-note').textContent = 'Your name is needed — it goes on every report.'; return; }
  if (parsedLines.length === 0) return;

  $('lg-file').disabled = true;
  try {
    const { data } = await api('/api/booth-reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reportedBy: by,
        reports: parsedLines.map((l) => ({
          stationId: l.stationId, queue: l.queue, problem: l.problem,
          severity: l.severity, peopleOnSite: l.peopleOnSite,
        })),
      }),
    });
    const refused = data.refused?.length ?? 0;
    $('lg-parse-note').textContent =
      `Filed ${data.written}.${refused ? ` ${refused} refused.` : ''}`;
    $('lg-paste').value = '';
    $('lg-parse').innerHTML = '';
    parsedLines = [];
    await loadLogistics();
  } catch (error) {
    $('lg-parse-note').textContent = `Could not file: ${error.message}`;
    $('lg-file').disabled = false;
  }
}

/* The rail is a drawer below 760px. Closing on navigation matters: tapping
   a view and being left staring at the menu you just used is the most
   common phone-nav fault there is. */
document.addEventListener('click', (e) => {
  const rail = $('rail');
  if (!rail) return;
  if (e.target.closest('#railtoggle')) {
    const open = rail.classList.toggle('is-open');
    $('railtoggle')?.setAttribute('aria-expanded', String(open));
    return;
  }
  if (e.target.closest('.views button[data-view]')) {
    rail.classList.remove('is-open');
    $('railtoggle')?.setAttribute('aria-expanded', 'false');
    return;
  }
  if (rail.classList.contains('is-open') && !e.target.closest('#rail')) {
    rail.classList.remove('is-open');
    $('railtoggle')?.setAttribute('aria-expanded', 'false');
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('rail')?.classList.remove('is-open');
});

/* Rail footer figures. Read once from the logistics payload rather than
   given their own request, since that screen already knows the register's
   size. */
function setRailStats(stationsTotal, provinces) {
  const el = $('rs-stations');
  if (el && stationsTotal != null) el.textContent = num(stationsTotal);

  /* The scope line used to be the literal word "Gauteng" in the markup.
     The register is national now, so a hardcoded province is simply a
     wrong label on a screen somebody trusts. It reads from the data: one
     province names it, several say how many. */
  const where = !provinces || provinces.length === 0 ? null
    : provinces.length === 1 ? provinces[0]
      : `${provinces.length} provinces`;
  const scope = $('scope');
  if (scope && where) scope.innerHTML = `${esc(where)}<br>2026 municipal elections`;
  const region = $('rs-region');
  if (region && where) region.textContent = where;
}


/* ---------------------------------------------------------------- slips
 *
 * Transcription and coverage.
 *
 * The one rule the screen must not break: on a second pass the operator
 * never sees the first pass's numbers. They get the party NAMES — which are
 * printed on the photograph in front of them, so this gives nothing away —
 * and empty boxes. Showing the first set would turn a check into a
 * confirmation, and two people agreeing because one copied the other is
 * indistinguishable from two people agreeing because the slip says so.
 */

let slipNow = null;          // the slip currently on screen

function slipRow(party = '', votes = '', locked = false) {
  return `<tr>
    <td data-k="Party"><input class="sl-party" value="${esc(party)}"
      ${locked ? 'readonly' : ''} placeholder="Party as written"></td>
    <td data-k="Votes"><input class="sl-num" type="number" min="0"
      inputmode="numeric" value="${esc(votes)}"></td>
    <td><button type="button" class="btn sl-del" title="Remove this line">&times;</button></td>
  </tr>`;
}

function slipBindRows() {
  $('sl-rows').querySelectorAll('.sl-del').forEach((b) => {
    b.addEventListener('click', () => { b.closest('tr').remove(); slipRecheck(); });
  });
  $('sl-rows').querySelectorAll('input').forEach((i) =>
    i.addEventListener('input', slipRecheck));
}

/* Live arithmetic, shown but never enforced. The slip on the door is the
   record; if it does not add up, that is a finding, not a typo to be
   corrected into agreement. Blocking submission here would quietly destroy
   exactly the evidence this system exists to capture. */
function slipRecheck() {
  let sum = 0;
  $('sl-rows').querySelectorAll('.sl-num').forEach((i) => { sum += Number(i.value) || 0; });
  const spoilt = Number($('sl-spoilt').value) || 0;
  const total = Number($('sl-total').value) || 0;
  const el = $('sl-check');
  if (!total) { el.textContent = `Party votes so far: ${fmt(sum)}`; el.className = 'sl-check viz-sub'; return; }
  const diff = sum + spoilt - total;
  el.textContent = diff === 0
    ? `Adds up: ${fmt(sum)} + ${fmt(spoilt)} spoilt = ${fmt(total)}.`
    : `Does not add up — out by ${fmt(Math.abs(diff))}. File it as the slip reads; this is recorded, not corrected.`;
  el.className = diff === 0 ? 'sl-check is-ok' : 'sl-check is-off';
}

async function loadSlipWork() {
  const { data } = await api('/api/transcribe/next');
  slipNow = data.slip;
  $('sl-queue').textContent = data.remaining
    ? `${fmt(data.remaining)} awaiting a pass` : 'queue clear';

  if (!slipNow) { $('sl-card').hidden = true; $('sl-empty').hidden = false; return; }
  $('sl-empty').hidden = true;
  $('sl-card').hidden = false;

  const note = $('sl-passnote');
  if (slipNow.pass === 1) {
    note.className = 'sl-pass is-first';
    note.textContent = 'PASS 1 — you are the first person to read this slip. Type exactly what is printed.';
  } else {
    note.className = 'sl-pass is-second';
    note.textContent = 'PASS 2 — the first reading is hidden from you on purpose. '
      + 'Type what you see; do not try to match anyone.';
  }

  $('sl-img').src = `/api/slip/${slipNow.slipId}/image`;
  /* Full resolution in a new tab. The capped height makes most slips
     readable; the ones that are not are exactly the ones worth enlarging. */
  $('sl-img').onclick = () => window.open(`/api/slip/${slipNow.slipId}/image`, '_blank', 'noopener');
  $('sl-where').textContent =
    `${slipNow.stationId} · ${slipNow.stationName} · ${slipNow.municipality} · ${slipNow.ballot.replace(/_/g, ' ')}`;

  /* Pass 2 gets the names, locked, and blank numbers. Pass 1 gets three
     empty lines to start. */
  $('sl-rows').innerHTML = slipNow.pass === 2 && slipNow.parties.length
    ? slipNow.parties.map((p) => slipRow(p, '', true)).join('')
    : slipRow() + slipRow() + slipRow();
  $('sl-spoilt').value = '';
  $('sl-total').value = '';
  $('sl-note').textContent = '';
  slipBindRows();
  slipRecheck();
}

async function loadSlipOverview() {
  const { data } = await api('/api/slips/overview');
  const t = data.totals || {};
  $('sl-sub').textContent =
    `${fmt(t.photographed || 0)} of ${fmt(t.expected || 0)} slips photographed · ${fmt(t.verified || 0)} verified`;

  const d = data.disagreements || [];
  $('sl-dispute-count').textContent = d.length ? `${fmt(d.length)} to resolve` : 'none';
  const recon = data.reconciliation || [];
  $('sl-dispute-list').innerHTML = (d.length === 0 && recon.length === 0)
    ? '<p class="viz-sub">Nothing disputed.</p>'
    : `${d.length ? `<table class="logi-table">
        <thead><tr><th>Station</th><th>Ballot</th><th>Party</th><th>Pass 1</th><th>Pass 2</th></tr></thead>
        <tbody>${d.map((r) => `<tr>
          <td data-k="Station"><span class="id">${esc(r.station_id)}</span></td>
          <td data-k="Ballot">${esc(String(r.ballot).replace(/_/g, ' '))}</td>
          <td data-k="Party">${esc(r.party)}</td>
          <td data-k="Pass 1">${r.pass_1 === null ? '<em>missing</em>' : fmt(r.pass_1)}</td>
          <td data-k="Pass 2">${r.pass_2 === null ? '<em>missing</em>' : fmt(r.pass_2)}</td>
        </tr>`).join('')}</tbody></table>` : ''}
       ${recon.length ? `<p class="viz-sub" style="margin-top:12px">Slips that do not add up:</p>
        <table class="logi-table">
        <thead><tr><th>Station</th><th>Ballot</th><th>Pass</th><th>Party total</th><th>Spoilt</th><th>Cast</th><th>Out by</th></tr></thead>
        <tbody>${recon.map((r) => `<tr>
          <td data-k="Station"><span class="id">${esc(r.station_id)}</span></td>
          <td data-k="Ballot">${esc(String(r.ballot).replace(/_/g, ' '))}</td>
          <td data-k="Pass">${esc(r.pass)}</td>
          <td data-k="Party total">${fmt(r.party_total)}</td>
          <td data-k="Spoilt">${r.spoilt === null ? '—' : fmt(r.spoilt)}</td>
          <td data-k="Cast">${r.total_votes_cast === null ? '—' : fmt(r.total_votes_cast)}</td>
          <td data-k="Out by">${fmt(r.discrepancy)}</td>
        </tr>`).join('')}</tbody></table>` : ''}`;

  const cov = data.coverage || [];
  $('sl-cov-sub').textContent = cov.length ? `${fmt(cov.length)} municipalities reporting` : 'nothing yet';
  $('sl-cov-list').innerHTML = cov.length === 0
    ? '<p class="viz-sub">No slips received yet.</p>'
    : `<table class="logi-table">
      <thead><tr><th>Municipality</th><th>Province</th><th>Expected</th><th>Photographed</th><th>Verified</th><th>Outstanding</th></tr></thead>
      <tbody>${cov.map((r) => `<tr>
        <td data-k="Municipality">${esc(r.municipality)}</td>
        <td data-k="Province">${esc(r.province)}</td>
        <td data-k="Expected">${fmt(r.slips_expected)}</td>
        <td data-k="Photographed">${fmt(r.photographed)} <span class="viz-sub">(${esc(r.pct_photographed ?? 0)}%)</span></td>
        <td data-k="Verified">${fmt(r.verified)}</td>
        <td data-k="Outstanding">${fmt(r.outstanding)}</td>
      </tr>`).join('')}</tbody></table>`;
}

async function loadSlips() {
  try { await Promise.all([loadSlipWork(), loadSlipOverview()]); }
  catch (err) { $('sl-sub').textContent = err.message; }
}

/* The totals are part of the sum, so they must recheck like any vote field.
   Without this the arithmetic line never leaves "Party votes so far" and the
   does-it-add-up check — the whole point of asking for the totals — silently
   never runs. */
$('sl-spoilt')?.addEventListener('input', slipRecheck);
$('sl-total')?.addEventListener('input', slipRecheck);

$('sl-addrow')?.addEventListener('click', () => {
  $('sl-rows').insertAdjacentHTML('beforeend', slipRow());
  slipBindRows();
});

$('sl-skip')?.addEventListener('click', async () => { await loadSlipWork(); });

$('sl-form')?.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!slipNow) return;
  const votes = [];
  $('sl-rows').querySelectorAll('tr').forEach((tr) => {
    const party = tr.querySelector('.sl-party')?.value.trim();
    const n = tr.querySelector('.sl-num')?.value;
    if (party && n !== '') votes.push({ party, votes: Number(n) });
  });
  if (votes.length === 0) { $('sl-note').textContent = 'Nothing entered.'; return; }

  $('sl-save').disabled = true;
  $('sl-note').textContent = 'Filing…';
  try {
    const { data } = await api('/api/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slipId: slipNow.slipId,
        spoilt: $('sl-spoilt').value === '' ? null : Number($('sl-spoilt').value),
        totalVotesCast: $('sl-total').value === '' ? null : Number($('sl-total').value),
        votes,
      }),
    });
    const said = data.status === 'DISPUTED'
      ? `Filed. The two passes disagree on ${fmt(data.disagreements)} — it is in "Needs a decision".`
      : `Filed — ${esc(data.status.toLowerCase())}. Next slip below.`;
    /* Written AFTER the reload, because loadSlipWork clears this field while
       setting up the next slip. Written before, the operator files a pass and
       sees nothing happen — and on a night of several hundred, "did that
       save?" is the question that makes people file twice. */
    await loadSlips();
    $('sl-note').textContent = said;
  } catch (err) {
    $('sl-note').textContent = err.message;
  } finally {
    $('sl-save').disabled = false;
  }
});
