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

async function api(path, options) {
  const res = await fetch(path, { credentials: 'same-origin', ...options });
  if (res.status === 401) { showSignIn(); throw new Error('unauthenticated'); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json();
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

/* -------------------------------------------------------- statement */

/** The statement is behind a real wait: the ledger fetches two thousand rows
 *  alongside it, so the figures land a couple of seconds after the frame does.
 *  The loader runs on first load only — once figures are on screen a later
 *  refresh replaces them in place, and re-skeletoning would read as a fault. */
function statementSettled() {
  const s = $('statement');
  s.classList.remove('is-loading');
  s.setAttribute('aria-busy', 'false');
}

async function loadStatement() {
  let data, as_of;
  try {
    ({ data, as_of } = await api('/api/campaign'));
  } catch (error) {
    statementSettled();
    for (const id of ['fig-a', 'fig-l', 'fig-eo']) $(id).textContent = NO_VALUE;
    $('statement-meta').innerHTML =
      `<div><dt>Statement</dt><dd>could not be read: ${esc(error.message)}</dd></div>`;
    return;
  }
  statementSettled();
  if (!data) {
    for (const id of ['fig-a', 'fig-l', 'fig-eo']) $(id).textContent = NO_VALUE;
    $('statement-meta').innerHTML =
      '<div><dt>Statement</dt><dd>nothing ingested yet</dd></div>';
    return;
  }
  $('fig-a').textContent = num(data.a_total_votes);
  $('fig-l').textContent = num(data.l_total_votes);
  const eo = $('fig-eo');
  eo.textContent = num(data.eo_est_votes);
  eo.classList.toggle('is-negative', Number(data.eo_est_votes) < 0);

  const basis = { ALL: 'all 2024 voters', POOL_SHARE: 'our share of the pool', OWN_VOTE: 'our own voters' };
  const meta = [
    ['Wards', num(data.wards_total)],
    ['Declared', `${num(data.wards_declared)} of ${num(data.wards_total)}`],
    ['Without a candidate', num(data.wards_no_candidate)],
    ['People short', num(data.people_gap_total)],
    ['Leakage charged against', basis[data.leakage_basis] ?? data.leakage_basis],
    ['As of', as_of ? new Date(as_of).toLocaleString('en-ZA') : NO_VALUE],
  ];
  $('statement-meta').innerHTML = meta
    .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
}

/* ----------------------------------------------------------- ledger */

async function loadWards() {
  const [wards, targets] = await Promise.all([
    api('/api/wards?limit=1000'),
    api('/api/targets?limit=1000'),
  ]);
  state.wards = wards.data;
  state.targets = new Map(targets.data.map((t) => [t.ward_id, t]));

  const municipalities = [...new Set(state.wards.map((w) => w.municipality))].sort();
  $('filter-munic').innerHTML = '<option value="">All</option>' +
    municipalities.map((m) => `<option>${esc(m)}</option>`).join('');

  renderChips();
  renderLedger();
}

function countBy(key, value) {
  return state.wards.filter((w) => (key === 'box'
    ? w.recommended_box === value
    : state.targets.get(w.ward_id)?.target_class === value)).length;
}

function renderChips() {
  const boxes = ['Recruit', 'Contest', 'Hold', 'Abandon'];
  const classes = ['ACT NOW', 'WATCH', 'PRESSURE ONLY', 'QUIET'];
  const chip = (label, n, on) =>
    `<button class="chip${on ? ' is-on' : ''}" data-value="${esc(label)}">` +
    `${esc(sentence(label))}<span class="chip-n">${n}</span></button>`;

  $('filter-box').innerHTML = boxes
    .map((b) => chip(b, countBy('box', b), state.filters.box === b)).join('');
  $('filter-class').innerHTML = classes
    .map((c) => chip(c, countBy('cls', c), state.filters.cls === c)).join('');
}

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
        <span class="num${declineNeg ? ' is-negative' : ''}${w.rival_decline_share === null ? ' is-null' : ''}">${dec(w.rival_decline_share, 3)}</span>
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
      ['Rival decline', dec(d.rival_decline_share, 3)],
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

const CATEGORY_ORDER = ['Water','Electricity','Refuse','Roads','Housing',
                        'Sanitation','Safety','Billing'];
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
  const cats = CATEGORY_ORDER.filter((c) => area.some((r) => r.category === c));
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
  const cats = CATEGORY_ORDER.filter((c) => trend.some((r) => r.category === c));
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

async function loadSentiment() {
  const { data } = await api('/api/sentiment');
  const s = data.summary;

  $('sent-provenance').innerHTML = s && s.synthetic
    ? '<b>Synthetic data.</b> No sentiment feed is connected yet. Every figure on this screen was generated for development and describes no real area. Nothing here may be read as what anyone actually thinks.'
    : `Signals from a connected feed. Average classifier confidence ${dec(s?.confidence)}. A sentiment figure is only as good as the feed behind it.`;

  $('sent-kpis').innerHTML = [
    ['Mentions', num(s?.mentions)],
    ['Wards with signal', num(s?.wards)],
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

const VIEWS = ['wards', 'sentiment', 'decisions', 'viewshed', 'float', 'health'];

function showView(view) {
  document.querySelectorAll('.views button').forEach((b) =>
    b.classList.toggle('is-current', b.dataset.view === view));
  for (const name of VIEWS) $(`view-${name}`).hidden = name !== view;

  // The projection holds a WebGL context and an animation loop; leaving it
  // running behind a hidden pane burns a core for nothing.
  if (view !== 'viewshed') window.VenomViewshed?.hide();

  if (view === 'sentiment') loadSentiment();
  if (view === 'decisions') loadDecisions();
  if (view === 'float') loadFloat();
  if (view === 'health') loadHealth();
  if (view === 'viewshed') loadViewshed();
}

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
  source.addEventListener('extract_stale', () => { loadStatement(); loadWards(); });
  source.addEventListener('ward_changed', () => { loadWards(); });
  source.onerror = () => {
    el.className = 'live is-down'; $('live-text').textContent = 'reconnecting';
  };
}

/* ------------------------------------------------------------ start */

async function start() {
  $('who').textContent = `${state.user.display_name ?? state.user.user_id}, ${state.user.role}`;
  await Promise.all([loadStatement(), loadWards()]);
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
