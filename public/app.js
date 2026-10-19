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
  try {
    const res = await fetch(path, { credentials: 'same-origin', ...options });
    if (res.status === 401) { showSignIn(); throw new Error('unauthenticated'); }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
    return await res.json();
  } finally {
    setBusy(-1);
  }
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

const VIEWS = ['overview', 'wards', 'sentiment', 'decisions', 'viewshed',
               'float', 'health', 'settings'];

function showView(view) {
  document.querySelectorAll('.views button').forEach((b) =>
    b.classList.toggle('is-current', b.dataset.view === view));
  for (const name of VIEWS) $(`view-${name}`).hidden = name !== view;

  // The projection holds a WebGL context and an animation loop; leaving it
  // running behind a hidden pane burns a core for nothing.
  if (view !== 'viewshed') window.VenomViewshed?.hide();

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
