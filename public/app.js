/* Venom ward ledger.
   No build step and no framework: the API is read-only and the page is a
   few hundred lines, so a bundler would be more machinery than the job. */

const $ = (id) => document.getElementById(id);

const state = {
  user: null,
  wards: [],
  targets: new Map(),
  filters: { box: null, cls: null, munic: '', province: null, region: null },
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
  // beside a box name is a claim and a placeholder is not.
  document.querySelector('.filters')?.classList.add('is-waiting');
  return whileLoading('view-wards', async () => {
    const [wards, targets] = await Promise.all([
      api(`/api/wards?limit=${WARD_LIMIT}`),
      api('/api/targets?limit=1000'),
    ]);
    state.wards = wards.data;
    /* The server counts the whole set separately, so the label can report
       what exists rather than what arrived. */
    state.wardsTotal = Number(wards.total ?? wards.data.length);
    state.targets = new Map(targets.data.map((t) => [t.ward_id, t]));

    refreshPlaceFilters();

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
   the rule - the rule is the 2x2 above them - they are the instruction.

   'Recruit' used to sit at the top of this list and of the ranking: winnable,
   nobody standing, find a candidate. Lists were certified on 16 September
   2026 and cannot change, so there is nobody to find. It is now 'PR', which
   is the thing that can still be done in such a ward - municipal PR is
   compensatory, so a list vote there is worth what a list vote is worth
   anywhere. See migration 041. */
const BOX_MEANING = {
  Contest:  'Winnable, candidate in place. Put people and money here.',
  PR:       'No ward candidate was certified for us. The seat is gone, the list ballot is not — turnout here still earns PR seats.',
  Hold:     'Not winnable, but we hold it. Defend, do not invest.',
  Abandon:  'Not winnable and nobody standing. Spend the day elsewhere.',
  /* Not a verdict. is_contestable is computed from the rival's 2021-2024
     decline, and its CASE ends ELSE false - so a ward with no baseline loaded
     was indistinguishable from one measured and found hopeless, and 4,031 of
     them were being reported as Abandon. See migration 044. */
  Unassessed: 'No 2021 baseline loaded for this ward, so nothing has been judged. Not a decision to skip it — a question nobody has answered.',
};

/* "confirmed" and "none confirmed" were the only two things this row could
   say, and both were read off a campaign-entered field that disagreed with
   the certified ballot in 310 of Gauteng's 526 wards. The row now says what
   it knows AND who said so, because "we have no candidate here" sourced from
   the IEC is final and actionable, while the same words sourced from a blank
   internal field mean only that nobody has filled it in. */
function candidateLine(d) {
  const certified = d.candidate_status_source === 'IEC certified';
  if (certified) {
    return d.candidate_status === 'Confirmed'
      ? 'standing — IEC certified'
      : 'none — IEC certified, final';
  }
  if (d.candidate_status === 'Confirmed') return 'confirmed — campaign entry, unverified';
  if (d.candidate_status === 'Pending')   return 'pending — campaign entry, unverified';
  return 'not recorded — certified list for this province not loaded';
}

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
    if (state.filters.province && w.province !== state.filters.province) return false;
    if (state.filters.region && w.region_code !== state.filters.region) return false;
    if (state.filters.munic && w.municipality !== state.filters.munic) return false;
    return true;
  });
}

function renderLedger() {
  const rows = visibleWards();
  $('filter-count').textContent =
    `${fmt(rows.length)} of ${fmt(state.wardsTotal ?? state.wards.length)} wards`
    /* If fewer arrived than exist, say so. The old label read "28 of 1000
       wards" on a register of 4,485 — a truncation presented as a total. */
    + ((state.wardsTotal ?? 0) > state.wards.length
        ? ` — only ${fmt(state.wards.length)} loaded` : '');
  $('ledger-empty').hidden = rows.length > 0;

  $('ledger').innerHTML = rows.map((w) => {
    const t = state.targets.get(w.ward_id);
    /* Was `urgent`, and wore the signal-yellow flag in the row margin. The
       flag is an alarm, and this is not one: no ward candidate of ours was
       certified here, that was final on 16 September, and nothing anyone
       does this week changes it. The row is still worth marking - the work
       there is different - so it keeps a marker in the informational hue
       rather than the alarm one. See migration 041. */
    const noCandidate = w.gap_flag === 'NO CANDIDATE';
    const band = t?.pressure_band ?? 'QUIET';
    const declineNeg = Number(w.rival_decline_share) < 0;
    const eoNeg = Number(w.eo_est_votes) < 0;
    return `
      <button class="line${noCandidate ? ' is-no-candidate' : ''}${state.openWard === w.ward_id ? ' is-open' : ''}"
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
/* Province narrows region narrows municipality. Rebuilt from the loaded
   wards rather than a fixed list, so the options are always things that
   exist in the data — a filter offering a municipality with no wards in it
   is a filter that returns an empty screen and looks broken. */
function refreshPlaceFilters() {
  const { province, region } = state.filters;

  const inProvince = (w) => !province || w.province === province;
  const inRegion = (w) => !region || w.region_code === region;

  const fill = (id, values, selected) => {
    const el = $(id);
    if (!el) return;
    el.innerHTML = '<option value="">All</option>'
      + values.map(([v, label]) =>
          `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(label)}</option>`).join('');
  };

  const provinces = [...new Set(state.wards.map((w) => w.province).filter(Boolean))].sort();
  fill('filter-province', provinces.map((p) => [p, p]), province);

  const regions = [...new Map(state.wards.filter(inProvince)
    .filter((w) => w.region_code)
    .map((w) => [w.region_code, w.region_name])).entries()]
    .sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  fill('filter-region', regions, region);

  const munics = [...new Set(state.wards.filter(inProvince).filter(inRegion)
    .map((w) => w.municipality).filter(Boolean))].sort();
  fill('filter-munic', munics.map((m) => [m, m]), state.filters.munic);
}

$('filter-province')?.addEventListener('change', (e) => {
  state.filters.province = e.target.value || null;
  /* Narrowing the province can orphan the region and municipality below it,
     so they are cleared rather than left pointing somewhere that is no
     longer in the list — a stale selection silently filters everything out. */
  state.filters.region = null;
  state.filters.munic = '';
  refreshPlaceFilters();
  renderLedger();
});

$('filter-region')?.addEventListener('change', (e) => {
  state.filters.region = e.target.value || null;
  state.filters.munic = '';
  refreshPlaceFilters();
  renderLedger();
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
      ['Candidate', candidateLine(d)],
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
    // The figure sits on its own cell, so the ink has to beat the cell it
    // sits on, not the page. Which ink wins is a property of the ramp AND of
    // the theme - on the MK gold ramp the dark theme crosses over at step 4
    // and the light theme not until step 6 - so a single threshold in here
    // would smudge one theme or the other. The step is published as a class
    // and each theme states its own crossover in CSS, where it is measured.
    // Exact values live in the table view either way.
    const step = Math.max(1, Math.min(7, Math.ceil(t * 7) || 1));
    const label = n ? `<text x="${x + cw / 2 - 1}" y="${y + ch / 2 + 4}" text-anchor="middle"
        font-size="11.5" class="cell-ink s${step}"
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

/* Above the national register of 4,485 so the directory holds all of it.
   Named rather than inline so the label below can test against it. */
const WARD_LIMIT = 6000;

const VIEWS = ['logistics', 'slips', 'overview', 'wards', 'sentiment', 'decisions',
               'heat', 'seats', 'readiness', 'briefing', 'float', 'health', 'settings'];

/* ------------------------------------------------------------------ *
 * Station readiness and gap maps.
 *
 * Canvas, not SVG: 23,751 points is 23,751 DOM nodes, which is a locked
 * tab on a war-room laptop. One canvas element draws the lot in a few
 * milliseconds.
 *
 * The two maps are the same data with the draw order inverted. On the
 * readiness map, covered stations draw last so coverage is legible. On
 * the gap map, only the uncovered real stations draw at all - the rest
 * are not dimmed, they are absent, because a gap map that still shows
 * everything else invites the eye to read the dense areas as progress.
 * ------------------------------------------------------------------ */
/* Xnith brand palette, from the brand sheet: status green #00E676 reads
   as covered, signal yellow #FFD600 as needing attention - the same way
   the rest of the dashboard already uses the accent. */
const MK = { green: '#00E676', greenPale: '#7FEFB4', gold: '#FFD600' };

const RD = {
  data: null,
  mode: 'all',
  map: null,
  layer: null,
  L: null,
  colours: {
    0: { fill: MK.gold,      label: 'No one assigned' },
    1: { fill: 'transparent', stroke: '#6b6b6b',
         label: 'Not from the IEC register (not counted)' },
    2: { fill: MK.greenPale, label: 'People, no named marshal' },
    3: { fill: MK.green,     label: 'Marshal assigned' },
  },
};

/* Leaflet, pinned, loaded only when this screen is opened - the same pattern
   viewshed.js uses for three.js. It is a global script rather than a module
   because Leaflet 1.x does not ship an ES build. */
const LEAFLET_JS  = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js';
const LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css';

/* A basemap carrying roads, place names and routes.

   THE BASEMAP IS A THIRD PARTY AND ELECTION DAY IS NOT THE DAY TO DISCOVER
   THAT. If these tiles fail - rate limit, outage, a network that blocks the
   host - the station layer still draws, on the dark background, exactly as
   it did before there was a basemap. The operational picture degrades to
   what it was yesterday rather than to a blank screen. The tile URL is kept
   in one place so it can be repointed at a self-hosted set without touching
   anything else.

   CARTO's dark tiles were the obvious choice and are not usable: they now
   require an API key and serve a watermarked image with HTTP 200, so a
   tile-error handler never fires and an automated check counts them as
   successes. This one was caught by looking at the render, not by the test.

   OpenStreetMap's own tiles are keyless, ODbL, and carry roads and place
   names. They are light, so the tile pane is darkened in CSS - which also
   keeps the station dots out of the filter, since they live on a separate
   canvas above it. OSM ask heavy users to self-host; a war room is not
   heavy use, but election day is the moment to have a local set ready. */
const BASEMAP_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const BASEMAP_ATTRIB =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!document.querySelector('link[data-leaflet]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = LEAFLET_CSS;
    link.setAttribute('data-leaflet', '1');
    document.head.appendChild(link);
  }
  return new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = LEAFLET_JS;
    sc.onload = () => resolve(window.L);
    sc.onerror = () => reject(new Error('Leaflet could not be loaded'));
    document.head.appendChild(sc);
  });
}

/* The station layer is a single canvas rather than 23,696 Leaflet markers,
   which would be 23,696 DOM nodes and an unusable tab. It redraws on every
   move using Leaflet's own projection, so the dots stay registered against
   the roads underneath at any zoom. */
function rdMakeLayer(L) {
  return L.Layer.extend({
    onAdd(map) {
      this._map = map;
      this._canvas = L.DomUtil.create('canvas', 'rd-overlay');
      map.getPanes().overlayPane.appendChild(this._canvas);
      map.on('move zoom resize zoomend moveend', this._draw, this);
      this._draw();
    },
    onRemove(map) {
      map.off('move zoom resize zoomend moveend', this._draw, this);
      this._canvas.remove();
    },
    _draw() {
      const map = this._map; const d = RD.data;
      if (!map || !d || !d.x.length) return;

      const size = map.getSize();
      const dpr = window.devicePixelRatio || 1;
      const cv = this._canvas;
      if (cv.width !== size.x * dpr || cv.height !== size.y * dpr) {
        cv.width = size.x * dpr; cv.height = size.y * dpr;
        cv.style.width = size.x + 'px'; cv.style.height = size.y + 'px';
      }
      /* The overlay pane is translated as the map moves; cancel that so the
         canvas sits still against the viewport and every dot is placed by
         container coordinates. */
      const corner = map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(cv, corner);

      const g = cv.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, size.x, size.y);

      const z = map.getZoom();
      const r = Math.max(1.3, Math.min(7, 1.3 * Math.pow(1.38, z - 5)));
      const gapsOnly = RD.mode === 'gaps';
      const order = gapsOnly ? ['0'] : ['1', '0', '2', '3'];

      /* Anything off-screen is skipped rather than drawn and clipped - at
         city zoom that is almost the whole country. */
      const pad = 40;
      const drawSelection = () => {
        /* Drawn last, on top of everything. A selected station that the
           dots cover is a selection the user cannot see. */
        if (!RD.selected) return;
        const pt = map.latLngToContainerPoint([RD.selected.lat, RD.selected.lon]);
        g.beginPath();
        g.arc(pt.x, pt.y, Math.max(7, r + 5), 0, Math.PI * 2);
        g.strokeStyle = getComputedStyle(document.documentElement)
          .getPropertyValue('--ink').trim() || '#fff';
        g.lineWidth = 2;
        g.stroke();
      };
      for (const code of order) {
        const spec = RD.colours[code];
        g.beginPath();
        let drew = false;
        for (let i = 0; i < d.x.length; i++) {
          if (d.state[i] !== code) continue;
          const pt = map.latLngToContainerPoint([d.y[i] / d.scale, d.x[i] / d.scale]);
          if (pt.x < -pad || pt.y < -pad || pt.x > size.x + pad || pt.y > size.y + pad) continue;
          g.moveTo(pt.x + r, pt.y);
          g.arc(pt.x, pt.y, r, 0, Math.PI * 2);
          drew = true;
        }
        if (!drew) continue;
        if (spec.fill === 'transparent') {
          g.strokeStyle = spec.stroke; g.lineWidth = 0.9; g.stroke();
        } else {
          /* A thin dark ring keeps dots separable where they pile up in a
             metro, and keeps them legible over pale road casings. */
          g.fillStyle = spec.fill;
          g.globalAlpha = gapsOnly ? 0.9 : 0.8;
          g.fill();
          g.globalAlpha = 1;
          if (r >= 3) { g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 1; g.stroke(); }
        }
      }
      drawSelection();
    },
  });
}

async function rdEnsureMap() {
  if (RD.map) return RD.map;
  const host = $('rd-map');
  if (!host) return null;

  const L = RD.L ?? (RD.L = await loadLeaflet());

  RD.map = L.map(host, {
    zoomAnimation: false,        // the overlay is redrawn, not tweened
    attributionControl: true,
    worldCopyJump: false,
  }).setView([-28.8, 24.7], 5);

  /* If the tiles never arrive the map still works: the station layer is
     added regardless and the background stays dark. */
  L.tileLayer(BASEMAP_URL, {
    attribution: BASEMAP_ATTRIB, maxZoom: 19, minZoom: 4,
  }).on('tileerror', () => {
    const n = $('rd-basemap-note');
    if (n) n.textContent =
      'Road basemap unavailable - station positions are still accurate.';
  }).addTo(RD.map);

  const StationLayer = rdMakeLayer(L);
  RD.layer = new StationLayer().addTo(RD.map);

  // Drill-down. The canvas overlay does not take pointer events, so the
  // click arrives on the map and is hit-tested against the drawn points.
  RD.map.on('click', (e) => { rdShowStation(e.latlng); });

  return RD.map;
}

/* Fit the view to whatever is currently selected, so choosing a province
   actually takes you there instead of leaving you at national zoom. */
function rdFit() {
  const d = RD.data; const L = RD.L;
  if (!RD.map || !L || !d || !d.x.length) return;
  let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < d.x.length; i++) {
    if (d.y[i] < minY) minY = d.y[i];
    if (d.y[i] > maxY) maxY = d.y[i];
    if (d.x[i] < minX) minX = d.x[i];
    if (d.x[i] > maxX) maxX = d.x[i];
  }
  RD.map.fitBounds(
    [[minY / d.scale, minX / d.scale], [maxY / d.scale, maxX / d.scale]],
    { padding: [24, 24], animate: false });
}

function rdDraw() { RD.layer?._draw(); }

function rdRenderLegend() {
  const el = $('rd-legend');
  if (!el) return;
  /* Only states actually present are listed. A legend offering "synthetic
     station" when the register holds none invites the reader to go looking
     for a category that is not on the map. */
  const present = new Set(RD.data?.state ?? '');
  const codes = (RD.mode === 'gaps' ? ['0'] : ['3', '2', '0', '1'])
    .filter((c) => present.has(c));
  el.innerHTML = codes.map((c) => {
    const s = RD.colours[c];
    const swatch = s.fill === 'transparent'
      ? `<span class="rd-dot rd-dot-hollow"></span>`
      : `<span class="rd-dot" style="background:${s.fill}"></span>`;
    return `<span class="rd-key">${swatch}${s.label}</span>`;
  }).join('');
}

function rdRenderStats(t) {
  const el = $('rd-stats');
  if (!el || !t) return;
  const pct = t.real_stations
    ? ((t.staffed / t.real_stations) * 100).toFixed(1) : '0.0';
  el.innerHTML = `
    <div class="rd-stat"><b>${fmt(t.real_stations)}</b><span>Real stations</span></div>
    <div class="rd-stat"><b>${fmt(t.staffed)}</b><span>With a marshal</span></div>
    <div class="rd-stat rd-stat-warn"><b>${fmt(t.real_gaps)}</b><span>No one assigned</span></div>
    <div class="rd-stat"><b>${pct}%</b><span>Covered</span></div>
    <div class="rd-stat"><b>${fmt(t.slips_expected)}</b><span>Slips to capture</span></div>`;

  /* voters_uncovered comes back null when the register carries no voter
     counts for these stations, which is currently true of every real one.
     Null is not zero: printing "0 registered voters" under a map of 21,385
     uncovered stations would read as "nothing at stake there". Say which
     it is. */
  const voters = t.voters_uncovered == null
    ? 'voter counts not yet in the register'
    : `${fmt(Number(t.voters_uncovered))} registered voters`;

  /* When every station is a gap, Gaps only draws exactly what Readiness
     draws, and a control with no visible effect is indistinguishable from a
     broken one. Say which it is rather than leaving the reader to wonder. */
  const allGaps = t.real_stations > 0 && t.real_gaps === t.real_stations;

  $('rd-note').textContent = t.real_gaps
    ? `${fmt(t.real_gaps)} of ${fmt(t.real_stations)} real stations have nobody `
      + `assigned (${voters}). `
      + `${fmt(t.slips_captured)} of ${fmt(t.slips_expected)} slips captured.`
      + (allGaps
          ? ` Every station here is a gap, so Gaps only shows the same points `
            + `as Readiness — the two views separate once marshals are assigned.`
          : '')
    : `Every real station in this selection has someone assigned.`;

  const gapsBtn = $('rd-mode-gaps');
  if (gapsBtn) gapsBtn.title = allGaps
    ? 'Identical to Readiness while no station has a marshal assigned'
    : 'Show only stations with nobody assigned';
}

/* Filled from the map payload itself, so the options always match the
   stations that can actually be drawn, and the screen works even if the
   ward directory has never been opened. */
function rdFillFilters(d) {
  const prov = $('rd-province'); const reg = $('rd-region');
  if (!prov || !reg || !d) return;

  const chosenP = prov.value; const chosenR = reg.value;
  prov.innerHTML = '<option value="">All</option>' + (d.provinces ?? []).map((p) =>
    `<option value="${esc(p)}"${p === chosenP ? ' selected' : ''}>${esc(p)}</option>`).join('');

  const seen = new Map();
  for (const r of d.regions ?? []) if (!seen.has(r.code)) seen.set(r.code, r.name);
  reg.innerHTML = '<option value="">All</option>' + [...seen.entries()].map(([v, l]) =>
    `<option value="${esc(v)}"${v === chosenR ? ' selected' : ''}>${esc(l)}</option>`).join('');
}

function rdSetMode(mode) {
  RD.mode = mode;
  const all = $('rd-mode-all'); const gaps = $('rd-mode-gaps');
  all?.classList.toggle('is-on', mode === 'all');
  gaps?.classList.toggle('is-on', mode === 'gaps');
  all?.setAttribute('aria-pressed', String(mode === 'all'));
  gaps?.setAttribute('aria-pressed', String(mode === 'gaps'));
  rdRenderLegend();
  rdDraw();
}

$('rd-mode-all')?.addEventListener('click', () => rdSetMode('all'));
$('rd-mode-gaps')?.addEventListener('click', () => rdSetMode('gaps'));
$('rd-province')?.addEventListener('change', () => {
  $('rd-region').value = '';   // a new province orphans the region below it
  loadReadiness();
});
$('rd-region')?.addEventListener('change', () => loadReadiness());

let rdResizeTimer = null;
window.addEventListener('resize', () => {
  if (!$('view-readiness') || $('view-readiness').hidden) return;
  clearTimeout(rdResizeTimer);
  rdResizeTimer = setTimeout(() => { RD.map?.invalidateSize(); rdDraw(); }, 120);
});

/* The completeness panel. A bar per province showing the share of its wards
   that have at least one voting station, with any ward that has none called
   out in words rather than left to be inferred from a nearly-full bar. */
async function loadCompleteness() {
  const rows = $('rc-rows');
  if (!rows) return;
  try {
    const res = await api('/api/register-completeness');
    const d = res.data ?? res;
    const max = Math.max(...d.provinces.map((p) => p.stations_per_ward), 1);

    rows.innerHTML = d.provinces.map((p) => {
      const covered = p.wards - p.wards_without_stations;
      const pct = p.wards ? (covered / p.wards) * 100 : 0;
      return `<div class="rc-row rc-${esc(p.status)}">
        <span class="rc-prov">${esc(p.province)}</span>
        <span class="rc-bar"><i style="width:${pct.toFixed(1)}%"></i></span>
        <span class="rc-num">${fmt(p.stations)}</span>
        <span class="rc-rate" title="Stations per ward">${p.stations_per_ward}/ward</span>
        <span class="rc-state">${p.wards_without_stations
          ? fmt(p.wards_without_stations) + ' wards with no station'
          : esc(p.status)}</span>
      </div>`;
    }).join('');

    const n = d.national;
    $('rc-note').textContent = n.wards_without_stations
      ? `${fmt(n.wards_without_stations)} of ${fmt(n.wards)} wards nationally `
        + `have no voting station in the register. Re-run the register ingest `
        + `for the affected province before trusting any coverage figure.`
      : `All ${fmt(n.wards)} wards have at least one station. `
        + `${fmt(n.stations)} stations in the register.`;
  } catch (e) {
    rows.innerHTML = '';
    $('rc-note').textContent =
      'Could not load register completeness: ' + (e?.message ?? e);
  }
}

async function loadReadiness() {
  const p = new URLSearchParams();
  const prov = $('rd-province')?.value;
  const reg = $('rd-region')?.value;
  if (prov) p.set('province', prov);
  if (reg) p.set('region', reg);

  try {
    const res = await api('/api/station-map?' + p.toString());
    const d = res.data ?? res;
    RD.data = d;
    rdFillFilters(d);
    rdRenderStats(d.totals);
    rdRenderLegend();
    await rdEnsureMap();
    /* The pane is hidden until the view opens, and a Leaflet map built in a
       hidden container measures itself at zero. Re-measure every time. */
    RD.map?.invalidateSize();
    rdFit();
    rdDraw();
  } catch (e) {
    /* Never leave the map showing a stale picture that looks current. */
    RD.data = null;
    rdDraw();
    $('rd-note').textContent =
      'Could not load station positions: ' + (e?.message ?? e);
  }
}

function showView(view) {
  document.querySelectorAll('.views button').forEach((b) =>
    b.classList.toggle('is-current', b.dataset.view === view));
  for (const name of VIEWS) $(`view-${name}`).hidden = name !== view;


  loadTicker();
  if (view === 'logistics') loadLogistics();
  if (view === 'slips') loadSlips();
  if (view === 'overview') { loadOverview(); loadPulse(); }
  if (view === 'sentiment') { loadSentiment(); loadHashtags(); }
  if (view === 'decisions') loadDecisions();
  if (view === 'float') loadFloat();
  if (view === 'health') loadHealth();
  if (view === 'readiness') { loadReadiness(); loadCompleteness(); }
  if (view === 'briefing') loadBriefing();
  if (view === 'heat') loadHeat();
  if (view === 'seats') loadSeats();
  if (view === 'settings') loadControlPanel();
}

/* -------------------------------------------------------- overview */

const ISSUE_MAX_BARS = 8;

/* ---- The clock, the readiness strip, and what the headline rests on ----
 *
 * These three sit above everything on the command centre that is a
 * projection, because they are the parts that are not one.
 */

/* Counted server-side against current_date. A war-room laptop with a wrong
   clock would otherwise be confidently early or late for the one date that
   cannot move. */
/* ---- Briefing ---------------------------------------------------
 *
 * A screen for showing people who will ask where every number came
 * from. It therefore reports the gaps as prominently as the strengths:
 * dark sources are listed, and the sentiment store says out loud that
 * it holds development data.
 *
 * The map here is drawn with no basemap and no network call. A boardroom
 * is exactly where third-party tiles fail to load, and a screen that is
 * half-blank in front of leadership proves the opposite of the point.
 */
function bfDrawMap(m) {
  const cv = $('bf-map');
  if (!cv || !m || !m.x?.length) return;
  const w = cv.parentElement.clientWidth;
  const h = Math.max(300, Math.round(w * 0.58));
  const dpr = window.devicePixelRatio || 1;
  cv.width = w * dpr; cv.height = h * dpr;
  cv.style.width = w + 'px'; cv.style.height = h + 'px';

  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < m.x.length; i++) {
    if (m.x[i] < minX) minX = m.x[i];
    if (m.x[i] > maxX) maxX = m.x[i];
    if (m.y[i] < minY) minY = m.y[i];
    if (m.y[i] > maxY) maxY = m.y[i];
  }
  const kx = Math.cos(((minY + maxY) / 2 / m.scale) * Math.PI / 180);
  const spanX = (maxX - minX) * kx || 1, spanY = (maxY - minY) || 1;
  const pad = 16;
  const sc = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
  const offX = (w - spanX * sc) / 2, offY = (h - spanY * sc) / 2;

  g.fillStyle = MK.gold; g.globalAlpha = 0.75;
  g.beginPath();
  for (let i = 0; i < m.x.length; i++) {
    const px = offX + (m.x[i] - minX) * kx * sc;
    const py = offY + (maxY - m.y[i]) * sc;
    g.moveTo(px + 1.5, py); g.arc(px, py, 1.5, 0, Math.PI * 2);
  }
  g.fill(); g.globalAlpha = 1;
}

const bfFig = (value, label, note) =>
  `<div class="bf-fig"><b>${value}</b><span>${label}</span>${
     note ? `<i>${note}</i>` : ''}</div>`;

async function loadBriefing() {
  try {
    const res = await api('/api/briefing');
    const d = res.data ?? res;
    const f = d.footprint ?? {}, r = d.readiness ?? {}, k = d.clock ?? {};

    /* The capability list below states what is running and what is waiting.
       It is read by people deciding whether to rely on this, so it is built
       from live counts rather than from hand-maintained strings - a status
       board that drifts is worse than none. The seat engine sat listed as
       "build / two days" for a day after it was built, validated and wired. */
    let seatsConfirmed = 0, seatsPending = 0, candidatesLoaded = 0;
    try {
      const sr = await api('/api/seats/readiness');
      for (const row of sr.data ?? []) {
        if (row.total_seats == null) seatsPending += 1; else seatsConfirmed += 1;
      }
      candidatesLoaded = (sr.data ?? [])
        .reduce((a, row) => a + Number(row.ward_candidates_loaded || 0)
                              + Number(row.pr_list_loaded || 0), 0);
    } catch { /* the list still renders, just without the live counts */ }

    $('bf-clock').innerHTML = k.election_date
      ? `<span><b>${num(k.days_to_election)}</b> days to polling day &middot; ${fmtDay(k.election_date)}</span>`
        + (k.next_drill ? `<span><b>${num(k.days_to_drill)}</b> days to the capture drill &middot; ${fmtDay(k.next_drill)}</span>` : '')
      : '';

    $('bf-footprint').innerHTML =
      bfFig(num(f.stations), 'voting stations', 'on their IEC coordinates')
      + bfFig(num(f.wards), 'wards')
      + bfFig(num(f.municipalities), 'municipalities')
      + bfFig(num(f.regions), 'districts and metros')
      + bfFig(num(f.provinces), 'provinces');

    $('bf-map-cap').textContent =
      `Every voting station in the country. Drawn from the register itself, `
      + `with no map service involved \u2014 nothing on this page depends on `
      + `an internet connection in the room.`;

    $('bf-completeness').innerHTML = (d.completeness ?? []).map((p) => {
      const covered = p.wards - p.wards_without_stations;
      const pct = p.wards ? (covered / p.wards) * 100 : 0;
      return `<div class="rc-row rc-${esc(p.status)}">
        <span class="rc-prov">${esc(p.province)}</span>
        <span class="rc-bar"><i style="width:${pct.toFixed(1)}%"></i></span>
        <span class="rc-num">${fmt(p.stations)}</span>
        <span class="rc-rate">${p.stations_per_ward}/ward</span>
        <span class="rc-state">${p.wards_without_stations
          ? fmt(p.wards_without_stations) + ' wards with no station' : esc(p.status)}</span>
      </div>`;
    }).join('');

    const pipe = d.pipeline ?? [];
    const metro = pipe.find((x) => x.category === 'A') ?? {};
    const local = pipe.find((x) => x.category === 'B') ?? {};
    $('bf-pipeline').innerHTML =
      bfFig(num(metro.stations), 'metro stations', `${metro.ballots_each ?? 2} ballots each`)
      + bfFig(num(local.stations), 'local stations', `${local.ballots_each ?? 3} ballots each`)
      + bfFig(num(r.slips_expected), 'result slips to capture', 'not 23,696');

    const staffed = Number(r.staffed ?? 0);
    const src = Object.fromEntries((d.sources ?? []).map((x) => [x.status, Number(x.n)]));

    $('bf-pvt').innerHTML =
      bfFig(num(r.slips_expected), 'slips to capture', 'two ballots per metro station, three per local')
      + bfFig(num(f.stations), 'stations to cover', 'every one of them, not a sample')
      + bfFig('2&times;', 'independent transcriptions', 'disagreements surfaced, never averaged');

    /* The ladder states its own evidence. A row is only LIVE when something
       in the register says so - the status is read from the data on this
       page, not asserted in the markup, so it cannot drift from the truth
       while nobody is looking. */
    const rows = [
      ['National electoral register', 'Every ward and station in the country, filterable by province, district and municipality.',
       Number(f.stations) > 0 ? ['live', 'Running'] : ['todo', 'Not loaded']],
      ['Ward targeting and priority', 'Where to contest, where to recruit, where to hold - ranked, with the reasoning kept.',
       Number(f.wards) > 0 ? ['live', 'Running'] : ['todo', 'Not loaded']],
      ['Ground logistics and alerts', 'Booth reports, exceptions and escalation from marshals in the field.',
       ['live', 'Running']],
      ['Register self-check', 'Catches the register going incomplete on its own - it already found 2,366 missing stations.',
       ['live', 'Running']],
      ['Parallel vote tabulation', 'Our own count at every station, from the posted slips.',
       ['built', 'Proves out at the drill, 29 October']],
      ['Live station readiness', 'Who is at which station, and where nobody is yet.',
       staffed > 0 ? ['live', 'Running'] : ['ready', 'Needs the marshal roster linked to stations']],
      ['Turnout weighting', 'Prioritise by voters behind a station, not by ward count.',
       ['ready', "Needs the voters' roll summary - already in hand"]],
      ['Official results feed', 'IEC results alongside our own count, as they declare.',
       ['needs', 'Needs IEC API credentials - request drafted']],
      /* Was 'build / Two days'. It is built, wired and reachable at
         /api/seats, and it reproduces both published 2021 results exactly.
         The one input still outstanding is the council seat total, which
         cannot be derived from the ward count - see migration 048. */
      ['Seats, not just votes', 'Votes translated into council seats under the Structures Act formula.',
       seatsConfirmed > 0
         ? ['live', 'Running']
         : ['ready', `Engine validated against 2021 — needs seat totals for ${fmt(seatsPending)} councils`]],
      ['Public issue pressure', 'What residents are raising, by ward, from live public sources.',
       ['needs', 'Needs Meta Business Manager approval — adapter already written']],
      ['Audited municipal finances', 'Service-delivery revenue per municipality, from Treasury.',
       ['live', 'Running — 147 municipalities, 2,295 audited facts']],
      ['Issue pressure, drillable', 'Complaints by province, municipality, ward and station.',
       ['live', 'Running — unmeasured places shown as unmeasured']],
      ['Certified candidates', 'Who is actually on the ballot, per ward.',
       candidatesLoaded > 0
         ? ['live', `Running — ${fmt(candidatesLoaded)} candidates loaded`]
         : ['ready', 'One command per province once the lists are to hand']],
    ];
    $('bf-ladder').innerHTML = rows.map(([name, what, [cls, state]]) => `
      <div class="bf-rung bf-${cls}">
        <span class="bf-rung-name">${esc(name)}</span>
        <span class="bf-rung-what">${what}</span>
        <span class="bf-rung-state">${state}</span>
      </div>`).join('');

    $('bf-asks').innerHTML = [
      ['Ten volunteers for the drill on 29 October',
       'Half at local-municipality stations, so the three-ballot case is tested rather than assumed.'],
      ['The marshal roster, with a station against each name',
       'The mechanism exists and the tokens work; the station field is empty. This is the one thing between us and a live readiness figure.'],
      ['Meta Business Manager registration',
       'Unlocks Instagram hashtag search, WhatsApp ingest and our own Pages. Approval is not instant, so it is worth starting before it is needed.'],
      ['IEC API credentials',
       'Lets our count sit beside the official declaration as it happens. The request is drafted and unsent.'],
      ["The voters' roll station summary",
       'Only the cover-page totals - voting district, ward, station, count. No voter-level data enters the system, by design.'],
    ].map(([ask, why]) =>
      `<li><b>${esc(ask)}</b><span>${esc(why)}</span></li>`).join('');

    /* Said once, plainly, at the foot - so the page cannot be read as
       claiming a sentiment capability it does not have, without that point
       dominating a screen which is otherwise about what works. */
    const se = d.sentiment ?? {};
    const connected = Number(src.Live ?? 0);
    const totalSrc = (d.sources ?? []).reduce((acc, x) => acc + Number(x.n), 0);
    $('bf-sentiment-note').textContent =
      `${connected} of ${totalSrc} external sources connected. `
      + (Number(se.rows ?? 0) > 0 && se.all_synthetic
          ? 'The sentiment store holds development data only, and nothing above is derived from it.'
          : 'No public sentiment ingested yet.');

    bfDrawMap(d.map);
  } catch (e) {
    $('bf-sentiment-note').textContent = 'Could not load the briefing: ' + (e?.message ?? e);
  }
}

let bfResizeTimer = null;
window.addEventListener('resize', () => {
  if ($('view-briefing')?.hidden !== false) return;
  clearTimeout(bfResizeTimer);
  bfResizeTimer = setTimeout(() => loadBriefing(), 150);
});


function renderClock(k) {
  const el = $('ov-clock');
  if (!el) return;
  if (!k) { el.innerHTML = ''; return; }

  const d = Number(k.days_to_election);
  const when = d > 1 ? `${d} days` : d === 1 ? 'tomorrow' : d === 0 ? 'today' : `${Math.abs(d)} days ago`;
  const urgent = d >= 0 && d <= 14;

  const drill = k.next_drill
    ? `<span class="clock-item"><b>${Number(k.days_to_drill) === 0 ? 'today'
        : Number(k.days_to_drill) === 1 ? 'tomorrow' : num(k.days_to_drill) + ' days'}</b>
         <span>to the capture drill &middot; ${fmtDay(k.next_drill)}</span></span>`
    : '';

  el.className = 'clockbar' + (urgent ? ' is-urgent' : '');
  el.innerHTML = `
    <span class="clock-item clock-main"><b>${d < 0 ? when : when}</b>
      <span>${d < 0 ? 'since polling day' : 'to polling day'} &middot; ${fmtDay(k.election_date)}</span></span>
    ${drill}`;
}

const fmtDay = (iso) => {
  const dt = new Date(iso);
  return Number.isNaN(dt.getTime()) ? String(iso)
    : dt.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long' });
};

/* Whether anyone is actually going to be at a polling station. Every figure
   further down this screen assumes somebody is. */
function renderReadiness(r) {
  const el = $('ov-ready');
  if (!el) return;
  if (!r) { el.innerHTML = ''; return; }

  const staffed = Number(r.staffed ?? 0);
  const stations = Number(r.stations ?? 0);
  const pct = Number(r.pct_staffed ?? 0);
  const none = staffed === 0 && stations > 0;

  el.className = 'readybar' + (none ? ' is-bare' : '');
  el.innerHTML = `
    <span class="ready-item"><b>${num(staffed)}</b><span>of ${num(stations)} stations staffed</span></span>
    <span class="ready-item"><b>${pct}%</b><span>covered</span></span>
    <span class="ready-item"><b>${num(r.slips_captured ?? 0)}</b><span>of ${num(r.slips_expected ?? 0)} slips captured</span></span>
    ${none ? `<span class="ready-say">Nobody is assigned to any station yet.</span>` : ''}`;
}

/* The headline renders at sixty pixels in the brand colour, which reads as
   certainty. It is only as good as the roll underneath it, and while that
   roll is synthetic or partial the figure has to say so in the same breath -
   not in a tooltip, and not on another screen. When a real roll is loaded
   these counts change on their own and the caveat disappears without anyone
   remembering to remove it. */
function renderHeroProvenance(p) {
  const el = $('ov-eo-prov');
  if (!el) return;
  if (!p) { el.textContent = ''; return; }

  const total = Number(p.wards_total ?? 0);
  const withRoll = Number(p.wards_with_roll ?? 0);
  const real = Number(p.wards_real ?? 0);

  if (withRoll === 0) { el.textContent = ''; el.className = 'headline-provenance'; return; }

  if (real === 0) {
    el.className = 'headline-provenance is-synthetic';
    el.textContent = `Synthetic. Every voter figure behind this is development `
      + `data covering ${num(withRoll)} of ${num(total)} wards; `
      + `the other ${num(total - withRoll)} carry none.`;
    return;
  }
  if (withRoll < total) {
    el.className = 'headline-provenance is-partial';
    el.textContent = `Based on ${num(withRoll)} of ${num(total)} wards `
      + `(${p.pct_covered}%); the rest have no roll loaded.`;
    return;
  }
  el.className = 'headline-provenance';
  el.textContent = `Based on all ${num(total)} wards.`;
}

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

  /* The region came from a hardcoded "Gauteng" that stopped being true when
     the register went national. */
  const reg = data.register ?? {};
  const where = reg.provinces > 1 ? `${num(reg.provinces)} provinces` : (reg.provinces === 1 ? 'one province' : 'the register');
  $('ov-sub').textContent =
    `${num(c.wards_total)} wards across ${where}. ${num(c.wards_declared)} declared. `
    + `leakage charged against ${LEAKAGE_WORDS[c.leakage_basis] ?? c.leakage_basis}`;

  renderClock(data.clock);
  renderReadiness(data.readiness);
  renderHeroProvenance(data.provenance);



  /* A ward with no registered-voter figure cannot contribute to any of the
     vote arithmetic, so with none of them loaded every number below is zero —
     and a zero here reads as a forecast of nothing rather than as "we have no
     basis to forecast". That is the same fault as SUPPLY_OK over wards with
     no deployments, and NO_PLAN over a NULL expected_people: an absence
     rendering as a confident value. Say which it is. */
  const withRoll = Number(reg.wards_with_roll ?? 0);
  const noBaseline = withRoll === 0 || potential === 0;

  const eoEl = $('ov-eo');
  if (noBaseline) {
    /* An em-dash at hero size is a stray horizontal rule, not a value. Say
       it in words, smaller and muted, so the eye reads it as a state rather
       than as a number that failed to load. */
    eoEl.textContent = 'not yet known';
    eoEl.classList.remove('is-negative');
    eoEl.classList.add('is-unknown');
  } else {
    eoEl.classList.remove('is-unknown');
    eoEl.textContent = num(eo);
    eoEl.classList.toggle('is-negative', eo < 0);
  }

  // The bar is the subtraction: the whole width is what could be had, the
  // dimmed part is what is being lost, the accent is what survives it.
  const keep = potential > 0 ? Math.max(0, Math.min(1, eo / potential)) : 0;
  /* An empty bar drawn at full width reads as "all of it is being lost".
     With no baseline there is no bar to draw. */
  /* Hidden, not emptied: the bar's own track still reads as a meter sitting
     at zero, which is the thing this whole change exists to avoid. */
  $('ov-bar').hidden = noBaseline;
  $('ov-bar').innerHTML = noBaseline ? ''
    : `<i class="is-keep" style="width:${(keep * 100).toFixed(1)}%"></i>`
      + `<i class="is-lose" style="width:${((1 - keep) * 100).toFixed(1)}%"></i>`;
  $('ov-legend').innerHTML = noBaseline
    ? `<span class="viz-sub" style="margin:0">No electoral baseline loaded —
         ${num(reg.wards ?? c.wards_total)} wards have geography but no registered-voter
         or past-result figures, so there is nothing to project from. This is not a
         forecast of zero.</span>`
    : `<span><b>${num(potential)}</b>could be had</span>`
      + `<span><b>&minus;${num(eroding)}</b>eroding</span>`
      + `<span><b>${num(eo)}</b>expected</span>`;

  $('ov-stats').innerHTML = [
    /* Was labelled "Without a candidate", which is not what it counts. The
       figure is SUM(candidate_shortage) - wards that are contestable AND have
       no candidate of ours - so it read 6 while 72 Gauteng wards have no
       candidate of ours at all. The number is the right one to show here (a
       ward we could not win anyway is not an operational gap); the label was
       claiming a wider fact than the number supports. It now names the same
       cell as the 2x2 in the wards directory: winnable, no candidate. */
    ['Winnable, no candidate', noBaseline ? '—' : num(c.wards_no_candidate),
      !noBaseline && Number(c.wards_no_candidate) > 0],
    ['People short', noBaseline ? '—' : num(c.people_gap_total),
      !noBaseline && Number(c.people_gap_total) > 0],
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
  /* Two colours on these bars need a key, or the reader invents one. */
  $('ov-issues-note').textContent = (data.sentiment?.synthetic
    ? 'synthetic data' : `${num(data.sentiment?.mentions ?? 0)} mentions`)
    + ' \u00b7 gold = taken badly';
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
        'Municipal Money is open and needs no credentials. This pulls every '
        + 'municipality in the register and their audited service revenue:',
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



/* ------------------------------------------------------- live pulse
 *
 * The Overview's real-time panel: a national station map and an activity
 * strip, both fed by SSE.
 *
 * TWO JOBS, SIX DAYS APART. Before polling day the map shows staffing
 * filling in; on the day it shows result slips arriving. The server decides
 * which from the election date rather than the client offering a toggle,
 * because a toggle left in the wrong position on election night shows a
 * staffing map to a room that believes it is watching results.
 *
 * NO BASEMAP HERE, DELIBERATELY. The readiness screen has tiles because you
 * navigate there. This panel is glanced at, often projected, and a road map
 * behind 23,696 dots at this size is texture rather than information. The
 * station positions alone draw a recognisable South Africa - which is the
 * other reason the readiness screen's own note says nothing on it depends
 * on an internet connection in the room.
 */

const PULSE = { data: null, timer: null, drawn: false };

/* ------------------------------------------- live panel sections
 *
 * Five optional sections, each switchable. The choice is sent to the server
 * as ?blocks=, so a section that is off is not computed - this endpoint is
 * re-read on every NOTIFY, and on polling night that is whenever a slip
 * lands. A panel nobody has open should not be generating load against the
 * one screen that has to stay quick.
 *
 * Defaults: rate and provinces on, because "are we on track, and where
 * aren't we" is the election-night question. The rest are opt-in so the
 * panel does not arrive as a wall.
 */
const PULSE_SECTIONS = [
  ['rate',       'Rate & ETA',   'Slips per minute, and when capture finishes at this rate.'],
  ['provinces',  'Provinces',    'Capture per province. A national total hides the one that stalled.'],
  ['quiet',      'Gone quiet',   'Provinces silent while the rest are still reporting.'],
  ['exceptions', 'Exceptions',   'The last few alerts, as text rather than a count.'],
  ['seats',      'Seats',        'Councils that can be projected as results land.'],
];
const PULSE_DEFAULT = ['rate', 'provinces'];

/* localStorage is per-viewer and can throw in a private window, so every
   read and write is guarded and the panel renders correctly without it. */
function pulseOn() {
  try {
    const raw = localStorage.getItem('venom-pulse-sections');
    if (raw) return new Set(JSON.parse(raw));
  } catch { /* fall through to the default */ }
  return new Set(PULSE_DEFAULT);
}
function pulseSetOn(set) {
  try {
    localStorage.setItem('venom-pulse-sections', JSON.stringify([...set]));
  } catch { /* the toggle still works for this session */ }
}

function pulseToggles() {
  const host = $('pulse-toggles');
  if (!host) return;
  const on = pulseOn();
  host.innerHTML = PULSE_SECTIONS.map(([key, label, why]) => `
    <button type="button" class="pt${on.has(key) ? ' is-on' : ''}"
            data-pulse-section="${key}" aria-pressed="${on.has(key)}"
            title="${esc(why)}">${esc(label)}</button>`).join('');
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest?.('[data-pulse-section]');
  if (!btn) return;
  const key = btn.dataset.pulseSection;
  const on = pulseOn();
  if (on.has(key)) on.delete(key); else on.add(key);
  pulseSetOn(on);
  pulseToggles();
  loadPulse();
});

const pfNum = (v) => (v === null || v === undefined ? NO_VALUE : fmt(v));

function pulseRate() {
  const r = PULSE.data?.rate;
  if (!r) return '';
  /* minutes_left is null when nothing is arriving. "Infinity" and a blank
     are both wrong; the useful statement is that nothing is coming in. */
  const eta = r.minutes_left === null
    ? '<span class="muted">nothing arriving — no finish time to give</span>'
    : `<b>${fmtClock(r.eta)}</b> at this rate`;
  return `
    <div class="ps ps-rate">
      <h4>Rate</h4>
      <p><b>${pfNum(r.recent)}</b> slips in the last ${pfNum(r.window_min)} min
         · <b>${r.per_minute}</b>/min</p>
      <p>${pfNum(r.remaining)} still to capture · ${eta}</p>
    </div>`;
}

function fmtClock(iso) {
  if (!iso) return NO_VALUE;
  try {
    return new Date(iso).toLocaleTimeString('en-ZA',
      { hour: '2-digit', minute: '2-digit' });
  } catch { return NO_VALUE; }
}

function pulseProvinces() {
  const rows = PULSE.data?.provinces;
  if (!rows?.length) return '';
  const metric = PULSE.data.mode === 'capture'
    ? (p) => ({ n: p.pct, label: `${p.pct ?? 0}%`,
                of: `${fmt(p.reporting)}/${fmt(p.stations)}` })
    : (p) => { const pct = p.stations ? Math.round((p.staffed / p.stations) * 100) : 0;
               return { n: pct, label: `${pct}%`,
                        of: `${fmt(p.staffed)}/${fmt(p.stations)}` }; };
  return `
    <div class="ps ps-prov">
      <h4>${PULSE.data.mode === 'capture' ? 'Capture' : 'Staffing'} by province</h4>
      ${rows.map((p) => { const m = metric(p); return `
        <div class="pp-row">
          <span class="pp-name">${esc(p.province)}</span>
          <span class="pp-bar"><i style="width:${Math.max(0, Math.min(100, m.n || 0))}%"></i></span>
          <span class="pp-n">${m.label}</span>
          <span class="pp-of">${m.of}</span>
        </div>`; }).join('')}
    </div>`;
}

function pulseQuiet() {
  const q = PULSE.data?.quiet;
  if (!q) return '';
  if (!q.newest) {
    return `<div class="ps ps-quiet"><h4>Gone quiet</h4>
      <p class="muted">Nothing has reported anywhere yet, so nothing can be
         quiet relative to anything else.</p></div>`;
  }
  return `
    <div class="ps ps-quiet">
      <h4>Gone quiet</h4>
      ${q.quiet.length
        ? q.quiet.map((p) => `<p class="pq"><b>${esc(p.province)}</b>
            silent ${pfNum(p.silent_min)} min — last slip ${fmtClock(p.last_slip)}</p>`).join('')
        : '<p class="muted">Every reporting province is still arriving.</p>'}
    </div>`;
}

function pulseExceptions() {
  const rows = PULSE.data?.exceptions;
  if (!rows) return '';
  return `
    <div class="ps ps-exc">
      <h4>Exceptions</h4>
      ${rows.length ? rows.map((a) => `
        <div class="pe sev-${esc(a.severity ?? 'info')}">
          <span class="pe-when">${fmtClock(a.raised_at)}</span>
          <span class="pe-body">${esc(a.body ?? a.kind)}</span>
          ${a.station_name ? `<span class="pe-where">${esc(a.station_name)}</span>` : ''}
          ${a.acknowledged_at ? '<span class="pe-ack">acknowledged</span>' : ''}
        </div>`).join('')
        : '<p class="muted">No exceptions raised.</p>'}
    </div>`;
}

function pulseSeats() {
  const s = PULSE.data?.seats;
  if (!s) return '';
  return `
    <div class="ps ps-seats">
      <h4>Seats</h4>
      ${s.projectable > 0
        ? s.declared.map((c) => `<p class="pc"><b>${esc(c.municipality)}</b>
            ${fmt(c.total_seats)} seats · ${fmt(c.slips_captured)} slips in</p>`).join('')
        : `<p class="muted">${fmt(s.needs_total)} councils cannot be projected yet —
             their seat total is not confirmed. ${fmt(s.waiting)} are ready and
             waiting for results.</p>`}
    </div>`;
}

function pulseSections() {
  const host = $('pulse-sections');
  if (!host) return;
  const on = pulseOn();
  host.innerHTML = [
    on.has('rate') ? pulseRate() : '',
    on.has('provinces') ? pulseProvinces() : '',
    on.has('quiet') ? pulseQuiet() : '',
    on.has('exceptions') ? pulseExceptions() : '',
    on.has('seats') ? pulseSeats() : '',
  ].join('');
}

const PULSE_LEGEND = {
  staffing: [['3', 'staffed'], ['2', 'people only'], ['0', 'nobody'], ['1', 'synthetic']],
  capture:  [['3', 'all slips in'], ['2', 'partial'], ['0', 'nothing yet'], ['1', 'synthetic']],
};

function pulseColours() {
  const host = $('pulse-map') ?? document.documentElement;
  const css = (n) => getComputedStyle(host).getPropertyValue(n).trim();
  return {
    '3': css('--st-good') || '#34d399',
    '2': css('--st-warn') || '#fb923c',
    '0': css('--st-bad') || '#f43f5e',
    '1': css('--ink-3') || '#6e6e7c',
  };
}

/* Equirectangular, fitted to the extent of the points themselves. No
   projection library and no tile server: this is a scatter of 23,696 real
   coordinates and at this size the difference from a proper projection is
   smaller than a dot. */
function pulseDraw() {
  const host = $('pulse-map');
  const d = PULSE.data;
  if (!host || !d || !d.y.length) return;

  const w = host.clientWidth || 420;
  const h = host.clientHeight || 260;
  if (w < 20 || h < 20) return;           // laid out but not yet measured

  let cv = host.querySelector('canvas');
  if (!cv) { cv = document.createElement('canvas'); host.appendChild(cv); }
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== w * dpr || cv.height !== h * dpr) {
    cv.width = w * dpr; cv.height = h * dpr;
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < d.x.length; i++) {
    if (d.x[i] < minX) minX = d.x[i];
    if (d.x[i] > maxX) maxX = d.x[i];
    if (d.y[i] < minY) minY = d.y[i];
    if (d.y[i] > maxY) maxY = d.y[i];
  }
  // Latitude degrees are a fixed distance; longitude degrees shrink with
  // latitude. Without this correction the country comes out stretched.
  const midLat = ((minY + maxY) / 2) / d.scale;
  const lonScale = Math.cos(midLat * Math.PI / 180);
  const spanX = (maxX - minX) * lonScale || 1;
  const spanY = (maxY - minY) || 1;
  const pad = 8;
  const k = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
  const offX = (w - spanX * k) / 2;
  const offY = (h - spanY * k) / 2;

  const colours = pulseColours();
  // Draw the quiet states first so the interesting ones are never buried.
  for (const code of ['1', '0', '2', '3']) {
    g.beginPath();
    let drew = false;
    for (let i = 0; i < d.x.length; i++) {
      if (d.state[i] !== code) continue;
      const px = offX + ((d.x[i] - minX) * lonScale) * k;
      const py = offY + (maxY - d.y[i]) * k;
      g.moveTo(px + 1.1, py);
      g.arc(px, py, 1.1, 0, Math.PI * 2);
      drew = true;
    }
    if (!drew) continue;
    g.fillStyle = colours[code];
    g.globalAlpha = code === '1' ? 0.35 : 0.85;
    g.fill();
    g.globalAlpha = 1;
  }
  PULSE.drawn = true;
}

function pulseSpark() {
  const host = $('pulse-spark');
  const d = PULSE.data;
  if (!host || !d) return;
  const series = [
    ['slips', 'Slips', '--st-good'],
    ['reports', 'Reports', '--st-info'],
    ['alerts', 'Alerts', '--st-warn'],
  ];
  const css = (n) => getComputedStyle($('pulse-map') ?? document.documentElement)
    .getPropertyValue(n).trim();

  host.innerHTML = series.map(([key, label, token]) => {
    const vals = d.activity.map((a) => Number(a[key]) || 0);
    const max = Math.max(1, ...vals);
    const total = vals.reduce((a, b) => a + b, 0);
    const bars = vals.map((v, i) => {
      const pct = Math.round((v / max) * 100);
      /* A zero bar still draws a 2px stub. A bucket with nothing in it must
         be visible as a bucket - otherwise a quiet hour and a missing hour
         look the same, and the quiet one is the one worth noticing. */
      return `<i style="height:${v === 0 ? 2 : Math.max(8, pct)}%;
                background:${v === 0 ? 'var(--rule)' : css(token)}"
                 title="${esc(d.activity[i].at)} — ${fmt(v)}"></i>`;
    }).join('');
    return `<div class="ps-row">
      <span class="ps-label">${label}</span>
      <span class="ps-bars">${bars}</span>
      <span class="ps-total">${fmt(total)}</span>
    </div>`;
  }).join('')
  + `<p class="ps-window">last hour, in ten-minute buckets</p>`;
}

function pulseFigures() {
  const host = $('pulse-figs');
  const d = PULSE.data;
  if (!host || !d) return;
  const t = d.totals ?? {};
  const fig = (v, label, warn) =>
    `<div class="pf${warn ? ' is-warn' : ''}"><b>${v}</b><span>${label}</span></div>`;

  host.innerHTML = d.mode === 'capture'
    ? fig(fmt(t.slips_captured), `of ${fmt(t.slips_expected)} slips in`,
          Number(t.slips_captured) === 0)
      + fig(fmt(t.stations_reporting), `of ${fmt(t.stations)} stations reporting`,
            Number(t.stations_reporting) === 0)
    : fig(fmt(t.staffed), `of ${fmt(t.stations)} stations staffed`,
          Number(t.staffed) === 0)
      + fig(fmt(t.slips_expected), 'slips to capture', false);

  const legend = (PULSE_LEGEND[d.mode] ?? []).map(([code, label]) =>
    `<span class="pl"><i style="background:${pulseColours()[code]}"></i>${label}</span>`).join('');
  $('pulse-mode').innerHTML =
    `${d.mode === 'capture' ? 'Result capture' : 'Staffing'} `
    + `<span class="muted">· ${esc(d.mode_source)}</span>`;
  $('pulse-note').innerHTML = legend;
}

async function loadPulse() {
  try {
    const on = [...pulseOn()];
    PULSE.data = await api('/api/pulse'
      + (on.length ? `?blocks=${encodeURIComponent(on.join(','))}` : ''));
  } catch (e) {
    const n = $('pulse-note');
    if (n) n.textContent = `Live panel unavailable: ${String(e.message ?? e)}`;
    return;
  }
  pulseToggles();
  pulseFigures();
  pulseSpark();
  pulseSections();
  pulseDraw();
}

/* Redraw on resize - the canvas is sized from the container, and a panel
   that is narrower after a window change would otherwise keep a stale
   bitmap stretched across it. */
window.addEventListener('resize', () => { if (PULSE.data) pulseDraw(); });

/* ------------------------------------------- station drill-down
 *
 * Clicking the readiness map opens the station under the pointer.
 *
 * THE HIT TEST RUNS CLIENT-SIDE, AGAINST THE POINTS ACTUALLY DRAWN. The
 * obvious alternative - send the click's latitude and longitude and let the
 * server return its nearest station - behaves badly at national zoom, where
 * a click on the Karoo is "near" something 200km away and the panel fills
 * with a station the user never aimed at. Scanning RD.data instead means a
 * click either lands on a dot that is on the screen, under the current
 * filter, or it lands on nothing and says so.
 *
 * 23,696 points is a linear scan of about a quarter of a millisecond. There
 * is no index to justify here.
 */

const RD_PICK_RADIUS_PX = 14;

/* The dossier has an identical helper, but it is a `const` declared INSIDE
   that function, so it is not in scope here - calling it would throw at the
   moment a user first clicked a station, which is exactly the kind of fault
   that survives a build and a page load and only appears on interaction. */
const rdKv = (pairs) => `<dl class="kv">${pairs
  .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;

function rdNearest(latlng) {
  const d = RD.data;
  if (!d || !d.x.length || !RD.map) return null;
  const scale = d.scale || 10000;
  const target = RD.map.latLngToContainerPoint(latlng);

  let best = null, bestDist = RD_PICK_RADIUS_PX * RD_PICK_RADIUS_PX;
  const gapsOnly = RD.mode === 'gaps';

  for (let i = 0; i < d.x.length; i++) {
    // Respect the mode: in Gaps only, the other dots are not on screen and
    // must not be clickable either.
    if (gapsOnly && d.state[i] !== '0') continue;
    const lat = d.y[i] / scale, lon = d.x[i] / scale;
    const pt = RD.map.latLngToContainerPoint([lat, lon]);
    const dx = pt.x - target.x, dy = pt.y - target.y;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) { bestDist = dist; best = { lat, lon, code: d.state[i] }; }
  }
  return best;
}

const RD_READINESS = {
  staffed: ['Staffed', 'A marshal is assigned and has checked in.'],
  people_only: ['People, no marshal', 'Bodies are planned here, but nobody is assigned to capture the result.'],
  unstaffed: ['Nobody assigned', 'No marshal. Nothing will be captured here unless that changes.'],
};

async function rdShowStation(latlng) {
  const host = $('rd-detail');
  if (!host) return;
  const hit = rdNearest(latlng);
  if (!hit) {
    host.hidden = true;
    RD.selected = null;
    RD.layer?._draw?.();
    return;
  }

  host.hidden = false;
  host.innerHTML = '<p class="muted">Loading…</p>';
  RD.selected = hit;
  RD.layer?._draw?.();

  let d;
  try {
    d = await api(`/api/station?lat=${hit.lat}&lon=${hit.lon}`);
  } catch (e) {
    host.innerHTML = `<p class="muted">Could not load that station: ${esc(String(e.message ?? e))}</p>`;
    return;
  }

  const s = d.station ?? {};
  const [label, meaning] = RD_READINESS[s.readiness] ?? ['Unknown', ''];
  const address = [s.street_name, s.suburb, s.town].filter(Boolean).join(', ');

  const roster = (d.roster ?? []).length
    ? (d.roster ?? []).map((r) => `<li>${esc(r.display_name ?? 'unnamed')}</li>`).join('')
    : '<li class="muted">Nobody on the roster for this station.</li>';

  /* `registered_voters` is null for most stations - the roll summary has not
     been loaded. A dash says that; a 0 would say the station has no voters,
     which is a different and false claim. */
  const voters = s.registered_voters == null
    ? '<span class="muted">not loaded</span>' : fmt(s.registered_voters);

  host.innerHTML = `
    <button class="rd-close" id="rd-close" aria-label="Close station detail">Close</button>
    <h3>${esc(s.name ?? s.station_id)}</h3>
    ${address ? `<p class="rd-addr">${esc(address)}</p>` : ''}
    ${s.is_real === false
      ? '<p class="rd-synth">Synthetic station — development data, not a real voting station.</p>'
      : ''}
    <p class="rd-state rd-state-${esc(s.readiness ?? 'unknown')}">
      <b>${esc(label)}</b> ${esc(meaning)}</p>
    ${rdKv([
      ['Station', esc(s.station_id)],
      ['Ward', esc(s.ward_id)],
      ['Municipality', esc(s.municipality_name ?? '')],
      ['Province', esc(s.province ?? '')],
      ['Registered voters', voters],
      ['Ballot slips expected', fmt(s.ballots_expected)],
      ['Slips captured', fmt(d.slips?.captured ?? 0)
        + ((d.slips?.rejected ?? 0) > 0 ? ` (${fmt(d.slips.rejected)} rejected)` : '')],
      ['Our people planned', s.our_people == null
        ? '<span class="muted">—</span>' : fmt(s.our_people)],
    ])}
    <h4>Roster</h4>
    <ul class="rd-roster">${roster}</ul>
    <p class="provenance">${esc(Number(s.latitude).toFixed(5))},
       ${esc(Number(s.longitude).toFixed(5))} — IEC coordinates.</p>`;
}

document.addEventListener('click', (e) => {
  if (e.target?.id === 'rd-close') {
    $('rd-detail').hidden = true;
    RD.selected = null;
    RD.layer?._draw?.();
  }
});

/* ------------------------------------------------------- issue heat
 *
 * Replaces the viewshed projection, which rendered London terrain and
 * answered no question anyone asks about a South African ward.
 *
 * Drill: country -> province -> municipality -> ward -> stations.
 *
 * THE ONE RULE THIS SCREEN IS BUILT AROUND. A heatmap turns numbers into
 * colour, and colour reads as measurement. A place with no signal must not
 * be painted the same as a place measured and found quiet, and a place whose
 * number is invented must not be painted the same as one that is real.
 * Today that is not a hypothetical: ward-level signal is 100% SYNTHETIC and
 * covers 116 of 4,485 wards, so a naive heatmap would render one province of
 * fabricated data as a national finding.
 *
 *   measured + real        filled dot, colour by intensity
 *   measured + synthetic   filled dot, dashed ring, counted in the banner
 *   no signal              hollow grey ring, never a warm colour
 */

const HEAT = {
  map: null, L: null, layer: null,
  level: 'province', province: null, municipality: null,
  municipalityName: null, selected: null, rows: [],
};

/* Sequential ramp, light to dark, one hue. Taken from the tokens rather
   than hardcoded so it follows the theme. */
const HEAT_STEPS = 6;

/* Read from the MAP HOST, not documentElement. The --seq-* ramp is scoped
   to `.viz`, so resolving it against the root returns empty string for every
   step - and the `|| fallback` then painted all nine provinces the same
   colour while looking like it worked. Third time a token read against the
   wrong scope has silently degraded a visual in this file. */
function heatCss(name) {
  const host = $('heat-map') ?? document.documentElement;
  return getComputedStyle(host).getPropertyValue(name).trim();
}

/* Resolve the ramp once and say so if it is missing, rather than quietly
   collapsing to a single colour. A heatmap with one colour is not a degraded
   heatmap, it is a wrong one. */
function heatRamp() {
  const steps = [];
  for (let i = 2; i <= 7; i++) steps.push(heatCss(`--seq-${i}`));
  if (steps.some((c) => !c)) {
    console.warn('issue heat: --seq-* ramp did not resolve; check .viz scope');
    return ['#3d2f00', '#5c4700', '#806200', '#a88000', '#cc9d00', '#FFD600'];
  }
  return steps;
}

/* Intensity is a rank, not a raw count. Mentions are wildly uneven - one
   metro carries 12,542 and most municipalities carry single digits - so a
   linear scale puts everything except Johannesburg in the lightest bucket
   and the map says nothing. Rank within what is on screen. */
function heatBuckets(rows) {
  const vals = rows.filter((r) => r.has_signal ?? (r.mentions > 0))
                   .map((r) => Number(r.mentions) || 0)
                   .sort((a, b) => a - b);
  if (!vals.length) return [];
  const cuts = [];
  for (let i = 1; i < HEAT_STEPS; i++) {
    cuts.push(vals[Math.floor((i / HEAT_STEPS) * vals.length)] ?? vals[vals.length - 1]);
  }
  return cuts;
}

function heatBucketOf(mentions, cuts) {
  let b = 0;
  for (const c of cuts) if (mentions > c) b++;
  return Math.min(b, HEAT_STEPS - 1);
}

async function heatEnsureMap() {
  if (HEAT.map) return HEAT.map;
  const host = $('heat-map');
  if (!host) return null;
  const L = HEAT.L ?? (HEAT.L = await loadLeaflet());

  HEAT.map = L.map(host, {
    zoomAnimation: false, attributionControl: true, worldCopyJump: false,
  }).setView([-28.8, 24.7], 5);

  L.tileLayer(BASEMAP_URL, {
    attribution: BASEMAP_ATTRIB, maxZoom: 19, minZoom: 4,
  }).on('tileerror', () => {
    const n = $('heat-basemap-note');
    if (n) n.textContent =
      'Road basemap unavailable - the dots are still positioned correctly.';
  }).addTo(HEAT.map);

  HEAT.layer = L.layerGroup().addTo(HEAT.map);
  return HEAT.map;
}

/* Province rows carry no coordinates of their own - a province is drawn at
   the mean of its municipalities, which are drawn at the mean of their
   stations. Computed here rather than in SQL because it is a presentation
   convenience, not a fact about a province. */
const PROVINCE_CENTRES = {
  'Eastern Cape': [-32.3, 26.4], 'Free State': [-28.5, 26.8],
  'Gauteng': [-26.1, 28.1], 'KwaZulu-Natal': [-28.9, 30.6],
  'Limpopo': [-23.7, 29.5], 'Mpumalanga': [-25.6, 30.4],
  'North West': [-26.4, 25.6], 'Northern Cape': [-29.3, 21.9],
  'Western Cape': [-33.3, 19.9],
};

function heatRadius(row) {
  // Area by station count, floored so a one-station ward is still clickable.
  const n = Number(row.stations) || 1;
  return Math.max(6, Math.min(26, Math.sqrt(n) * 2.2));
}

function heatDraw() {
  const L = HEAT.L;
  if (!L || !HEAT.layer) return;
  HEAT.layer.clearLayers();

  const cuts = heatBuckets(HEAT.rows);
  const ramp = heatRamp();
  const muted = heatCss('--ink-3') || '#6e6e7c';

  let synthetic = 0, unmeasured = 0;

  for (const row of HEAT.rows) {
    const centre = HEAT.level === 'province'
      ? PROVINCE_CENTRES[row.province]
      : (row.lat != null && row.lon != null ? [Number(row.lat), Number(row.lon)] : null);
    if (!centre) continue;

    const measured = HEAT.level === 'province'
      ? Number(row.mentions) > 0
      : Boolean(row.has_signal);
    const isSynth = HEAT.level === 'province'
      ? Boolean(row.any_synthetic)
      : (row.signal_basis === 'synthetic' || row.signal_basis === 'mixed');

    if (!measured) unmeasured++;
    if (isSynth) synthetic++;

    const marker = L.circleMarker(centre, {
      radius: HEAT.level === 'province' ? 16 : heatRadius(row),
      /* Unmeasured is hollow. Not a pale warm colour - pale warm is still a
         position on the scale, and this has no position on the scale. */
      fillColor: measured ? ramp[heatBucketOf(Number(row.mentions) || 0, cuts)] : 'transparent',
      fillOpacity: measured ? 0.75 : 0,
      color: isSynth ? heatCss('--st-warn') : (measured ? ramp[HEAT_STEPS - 1] : muted),
      weight: isSynth ? 2.5 : 1.2,
      dashArray: isSynth ? '4 3' : null,
      opacity: measured ? 0.9 : 0.55,
    });

    /* Chosen by LEVEL, not by which field happens to be populated. A
       municipality row carries both `municipality` and `province`, so a
       `row.province ?? row.municipality` fallback labelled every
       municipality dot with its province - every dot in the Free State read
       "Free State". */
    const label = HEAT.level === 'province' ? row.province
      : HEAT.level === 'municipality' ? row.municipality
      : `Ward ${row.ward_id}`;
    const n = Number(row.mentions) || 0;
    marker.bindTooltip(
      `<b>${esc(label)}</b><br>`
      + (measured
          ? `${fmt(n)} mention${n === 1 ? '' : 's'}`
            + (isSynth ? ' <i>(synthetic)</i>' : '')
          : '<i>no signal collected</i>'),
      { direction: 'top' });

    marker.on('click', () => heatSelect(row));
    marker.addTo(HEAT.layer);
  }

  heatBanner(synthetic, unmeasured);
  heatLegend(cuts, ramp);
}

/* The banner exists because this screen is going to be shown to people who
   did not build it. */
function heatBanner(synthetic, unmeasured) {
  const el = $('heat-synth');
  if (!el) return;
  /* Both forms written out. Appending "s" produced "6 municipalitys" on
     screen, which is the sort of thing nobody notices until it is on a
     projector in front of the people being asked to trust the numbers. */
  const PLACE = {
    province: ['province', 'provinces'],
    municipality: ['municipality', 'municipalities'],
    ward: ['ward', 'wards'],
  }[HEAT.level] ?? ['place', 'places'];
  const plural = (n) => `${fmt(n)} ${n === 1 ? PLACE[0] : PLACE[1]}`;
  const parts = [];
  if (synthetic) {
    parts.push(`${plural(synthetic)} shown here carr${synthetic === 1 ? 'ies' : 'y'} `
      + 'development data rather than collected signal. '
      + 'Ringed in orange — those numbers are invented.');
  }
  if (unmeasured) {
    parts.push(`${plural(unmeasured)} ${unmeasured === 1 ? 'is' : 'are'} hollow `
      + 'because nothing has been collected there — an absence of data, '
      + 'not an absence of complaints.');
  }
  el.innerHTML = parts.join(' ');
  el.hidden = parts.length === 0;
}

function heatLegend(cuts, ramp) {
  const el = $('heat-legend');
  if (!el) return;
  const swatches = ramp.map((c, i) => {
    const lo = i === 0 ? 0 : Math.round(cuts[i - 1] ?? 0) + 1;
    return `<span class="hl-step"><i style="background:${c}"></i>${fmt(lo)}+</span>`;
  }).join('');
  el.innerHTML =
    `<span class="hl-title">mentions</span>${swatches}`
    + '<span class="hl-step hl-none"><i></i>no signal</span>'
    + '<span class="hl-step hl-synth"><i></i>synthetic</span>';
}

function heatCrumbs() {
  const el = $('heat-crumbs');
  if (!el) return;
  const bits = [`<button class="crumb" data-to="province">South Africa</button>`];
  if (HEAT.province) {
    bits.push(`<button class="crumb" data-to="municipality">${esc(HEAT.province)}</button>`);
  }
  if (HEAT.municipality) {
    bits.push(`<button class="crumb" data-to="ward">${esc(HEAT.municipalityName ?? HEAT.municipality)}</button>`);
  }
  el.innerHTML = bits.join('<span class="crumb-sep">›</span>');
}

/* Clicking a dot drills in; at ward level it opens the detail panel rather
   than drilling further, because a station has no issue signal of its own
   and inventing one per station is exactly what this screen refuses to do. */
async function heatSelect(row) {
  if (HEAT.level === 'province') {
    HEAT.province = row.province;
    return heatLoad('municipality');
  }
  if (HEAT.level === 'municipality') {
    HEAT.municipality = row.demarcation_code;
    HEAT.municipalityName = row.municipality;
    return heatLoad('ward');
  }
  HEAT.selected = row;
  await heatDetail(row);
}

async function heatDetail(row) {
  const side = $('heat-side');
  if (!side) return;
  side.innerHTML = '<p class="muted">Loading…</p>';

  const qs = row.ward_id ? `ward=${encodeURIComponent(row.ward_id)}`
                         : `municipality=${encodeURIComponent(row.demarcation_code)}`;
  let d;
  try { d = await api(`/api/heat/detail?${qs}`); }
  catch (e) { side.innerHTML = `<p class="muted">Could not load detail: ${esc(String(e.message ?? e))}</p>`; return; }

  const cats = d.data ?? [];
  const title = row.ward_id ? `Ward ${row.ward_id}` : row.municipality;
  const max = Math.max(1, ...cats.map((c) => Number(c.mentions) || 0));

  const catRows = cats.length ? cats.map((c) => `
    <div class="hc-row${c.synthetic ? ' is-synth' : ''}">
      <span class="hc-name">${esc(c.category)}${c.synthetic ? ' <i class="hc-tag">synthetic</i>' : ''}</span>
      <span class="hc-bar"><i style="width:${Math.round((Number(c.mentions) / max) * 100)}%"></i></span>
      <span class="hc-n">${fmt(c.mentions)}</span>
    </div>`).join('')
    : '<p class="muted">No signal collected here. That is not the same as no complaints.</p>';

  const stations = (d.stations ?? []);
  const stationRows = stations.length ? `
    <h4>Voting stations <span class="muted">(${fmt(stations.length)})</span></h4>
    <div class="hs-list">${stations.map((st) => `
      <div class="hs-row">
        <span class="hs-name">${esc(st.name ?? st.station_id)}</span>
        <span class="hs-sub">${esc(st.suburb ?? '')}</span>
        <span class="hs-n">${fmt(st.registered_voters)}</span>
      </div>`).join('')}</div>` : '';

  side.innerHTML = `
    <h3>${esc(title)}</h3>
    <p class="muted">${esc(row.municipality ?? row.province ?? '')}</p>
    ${catRows}
    ${stationRows}`;
}

async function heatLoad(level) {
  HEAT.level = level;
  if (level === 'province') { HEAT.province = null; HEAT.municipality = null; }
  if (level === 'municipality') { HEAT.municipality = null; }

  const params = new URLSearchParams({ level });
  if (level === 'municipality' && HEAT.province) params.set('province', HEAT.province);
  if (level === 'ward' && HEAT.municipality) params.set('municipality', HEAT.municipality);

  const res = await api(`/api/heat?${params}`);
  HEAT.rows = res.data ?? [];
  HEAT.selected = null;
  $('heat-side').innerHTML =
    '<p class="muted">Click a dot for the category breakdown.</p>';

  heatCrumbs();
  heatDraw();
  heatFit();

  const note = $('heat-note');
  if (note) {
    note.textContent = HEAT.rows.length
      ? `${fmt(HEAT.rows.length)} ${level === 'province' ? 'provinces' : level === 'municipality' ? 'municipalities' : 'wards'} shown`
        + (res.as_of ? ` · as of ${new Date(res.as_of).toLocaleDateString('en-ZA')}` : '')
      : (res.note ?? 'Nothing to show at this level.');
  }
}

function heatFit() {
  if (!HEAT.map || !HEAT.L) return;
  const pts = HEAT.rows.map((r) => (HEAT.level === 'province'
      ? PROVINCE_CENTRES[r.province]
      : (r.lat != null && r.lon != null ? [Number(r.lat), Number(r.lon)] : null)))
    .filter(Boolean);
  if (!pts.length) return;
  if (pts.length === 1) { HEAT.map.setView(pts[0], 11); return; }
  HEAT.map.fitBounds(HEAT.L.latLngBounds(pts).pad(0.15));
}

async function loadHeat() {
  return whileLoading('view-heat', async () => {
    await heatEnsureMap();
    // A Leaflet map built in a hidden pane measures itself at zero.
    HEAT.map?.invalidateSize();
    if (!HEAT.rows.length) await heatLoad('province');
    else { heatDraw(); heatFit(); }
  });
}

document.addEventListener('click', (e) => {
  const crumb = e.target.closest?.('.crumb');
  if (!crumb) return;
  const to = crumb.dataset.to;
  if (to === 'province') heatLoad('province');
  if (to === 'municipality' && HEAT.province) heatLoad('municipality');
  if (to === 'ward' && HEAT.municipality) heatLoad('ward');
});


/* ---------------------------------------------------- seat projection
 *
 * The hemicycle. Fed by `src/seats/allocate.ts`, which reproduces both
 * published 2021 results exactly - the engine existed and passed its
 * fixtures for a day before anything could reach it, so this screen is the
 * wiring as much as the picture.
 *
 * WHAT THE PICTURE MUST NOT DO. A hemicycle is a very convincing shape. It
 * looks like a result whatever is behind it, so this screen never draws one
 * from incomplete or unconfirmed inputs. A council whose seat total is not
 * confirmed gets the reason in words; a council with no captured results
 * gets the same. The only arcs drawn from real inputs today are the two 2021
 * fixtures, and they are labelled as validation rather than projection.
 */

/* Seats laid out in concentric rows across a half-circle, each row holding
   seats in proportion to its radius so the spacing stays even. */
function hemicycleSeats(total, rows = null) {
  if (total <= 0) return [];
  const R = rows ?? Math.max(2, Math.min(7, Math.round(Math.sqrt(total / 2.2))));
  const weights = [];
  for (let i = 0; i < R; i++) weights.push(1 + i * 0.62);
  const sum = weights.reduce((a, b) => a + b, 0);

  const perRow = weights.map((w) => Math.max(1, Math.round((w / sum) * total)));
  // Rounding will not add up; correct from the outermost row inwards.
  let drift = total - perRow.reduce((a, b) => a + b, 0);
  for (let i = R - 1; i >= 0 && drift !== 0; i--) {
    const step = drift > 0 ? 1 : -1;
    if (perRow[i] + step >= 1) { perRow[i] += step; drift -= step; }
  }

  const pts = [];
  const rOuter = 1, rInner = 0.42;
  for (let i = 0; i < R; i++) {
    const r = R === 1 ? (rOuter + rInner) / 2
      : rInner + (rOuter - rInner) * (i / (R - 1));
    const n = perRow[i];
    for (let k = 0; k < n; k++) {
      // Left to right across the arc, 180deg to 0deg.
      const t = n === 1 ? 0.5 : k / (n - 1);
      const a = Math.PI * (1 - t);
      pts.push({ x: Math.cos(a) * r, y: -Math.sin(a) * r, row: i, idx: k });
    }
  }
  // Order so seats fill left to right across the whole arc, not row by row:
  // a party's block should read as one wedge.
  pts.sort((a, b) => Math.atan2(-a.y, a.x) - Math.atan2(-b.y, b.x));
  return pts.reverse();
}

/* CATEGORICAL, NOT SEQUENTIAL. Party is identity, not magnitude. The first
   attempt opened with --seq-7, --seq-5, --seq-3 - three steps off one
   sequential ramp - which put the ANC, the DA and the EFF in three yellows
   nobody could tell apart on a projector. A ramp encodes "more"; parties are
   not more or less than each other.

   Fixed order, never cycled: a party keeps its colour as the count changes,
   so filtering does not repaint the survivors. Past the eighth party every
   remaining one is grey rather than a generated hue - at that point colour
   has stopped carrying identity and the legend is doing the work. */
const SEAT_PALETTE = ['--ours', '--st-info', '--st-good', '--st-warn',
                      '--st-bad', '--seq-3', '--st-unknown', '--theirs'];
const SEAT_OVERFLOW = '--ink-3';

function seatColour(i, host) {
  const token = i < SEAT_PALETTE.length ? SEAT_PALETTE[i] : SEAT_OVERFLOW;
  const v = getComputedStyle(host ?? document.documentElement)
    .getPropertyValue(token).trim();
  return v || '#FFD600';
}

/* Draws one hemicycle. `parties` is [{party, total, ward, pr}] already in
   seat order. Returns an SVG string. */
function hemicycleSvg(parties, host) {
  const total = parties.reduce((a, p) => a + Number(p.total || 0), 0);
  if (total <= 0) return '<p class="muted">No seats to draw.</p>';
  const pts = hemicycleSeats(total);

  const blocks = [];
  let i = 0;
  parties.forEach((p, pi) => {
    const n = Number(p.total) || 0;
    for (let k = 0; k < n && i < pts.length; k++, i++) {
      blocks.push({ ...pts[i], party: p.party, colour: seatColour(pi, host),
                    ward: k < Number(p.ward || 0) });
    }
  });

  const W = 620, H = 330, cx = W / 2, cy = H - 18, scale = 268;
  const dots = blocks.map((b) => {
    const x = cx + b.x * scale, y = cy + b.y * scale;
    /* A ward seat is filled, a list seat is hollow. The distinction is the
       whole point of compensatory PR and it is free to show. */
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6.2"`
      + (b.ward ? ` fill="${b.colour}" stroke="none"` 
                : ` fill="none" stroke="${b.colour}" stroke-width="2.2"`)
      + `><title>${esc(b.party)} — ${b.ward ? 'ward' : 'list'} seat</title></circle>`;
  }).join('');

  const legend = parties.filter((p) => Number(p.total) > 0).map((p, pi) => `
    <span class="sl-item">
      <i style="background:${seatColour(pi, host)}"></i>
      ${esc(p.party)}
      <b>${fmt(p.total)}</b>
      <span class="muted">${fmt(p.ward)} ward · ${fmt(p.pr)} list</span>
    </span>`).join('');

  return `<svg class="hemicycle" viewBox="0 0 ${W} ${H}" role="img"
            aria-label="Hemicycle of ${total} council seats">${dots}
            <text x="${cx}" y="${cy - 8}" text-anchor="middle"
                  class="hemi-total">${fmt(total)}</text>
            <text x="${cx}" y="${cy + 10}" text-anchor="middle"
                  class="hemi-sub">seats</text></svg>
          <div class="seat-legend">${legend}</div>
          <p class="provenance">Filled = ward seat won outright. Hollow = seat
             from the PR list. PR seats are the party's total entitlement
             minus its ward seats, so the two are not added together.</p>`;
}

async function seatValidation() {
  const host = $('seat-validation');
  if (!host) return;
  let d;
  try { d = await api('/api/seats/validation'); }
  catch (e) { host.innerHTML = `<p class="muted">${esc(String(e.message ?? e))}</p>`; return; }

  host.innerHTML = (d.data ?? []).map((f) => `
    <div class="seat-fixture">
      <h4>${esc(f.name)}
        <span class="${f.passed ? 'sv-pass' : 'sv-fail'}">
          ${f.passed ? 'reproduced exactly' : 'MISMATCH'}</span></h4>
      <p class="provenance">quota ${fmt(f.quota)} · ${fmt(f.council_seats)} seats
         · ${fmt(f.parties)} parties</p>
      ${f.passed ? hemicycleSvg(f.seats, host)
                 : `<p class="muted">${esc(f.mismatches.join('; '))}</p>`}
    </div>`).join('');
}

async function seatReadiness() {
  const host = $('seat-readiness');
  if (!host) return;
  let d;
  try { d = await api('/api/seats/readiness'); }
  catch (e) { host.innerHTML = `<p class="muted">${esc(String(e.message ?? e))}</p>`; return; }

  const summary = Object.entries(d.summary ?? {})
    .map(([k, v]) => `<span class="sr-chip">${esc(k)} <b>${fmt(v)}</b></span>`).join('');

  const rows = (d.data ?? []).slice(0, 40).map((r) => `
    <tr>
      <td>${esc(r.municipality)}</td>
      <td class="num">${fmt(r.ward_seats)}</td>
      <td class="num">${r.total_seats == null
          ? `<span class="muted">${fmt(r.total_if_odd)} or ${fmt(r.total_if_even)}</span>`
          : fmt(r.total_seats)}</td>
      <td class="num">${fmt(r.ward_candidates_loaded)}</td>
      <td class="num">${fmt(r.slips_captured)}</td>
      <td>${esc(r.status)}</td>
    </tr>`).join('');

  host.innerHTML = `
    <div class="sr-summary">${summary}</div>
    <table class="sr-table">
      <thead><tr><th>Council</th><th class="num">Wards</th>
        <th class="num">Seats</th><th class="num">Candidates</th>
        <th class="num">Slips</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${(d.data ?? []).length > 40
      ? `<p class="provenance">Showing 40 of ${fmt(d.data.length)} councils.</p>` : ''}`;
}

async function seatProject(code) {
  const host = $('seat-result');
  if (!host) return;
  if (!code) { host.innerHTML = ''; return; }
  host.innerHTML = '<p class="muted">Loading…</p>';
  let d;
  try { d = await api(`/api/seats?municipality=${encodeURIComponent(code)}`); }
  catch (e) { host.innerHTML = `<p class="muted">${esc(String(e.message ?? e))}</p>`; return; }

  if (!d.projectable) {
    host.innerHTML = `
      <div class="seat-blocked">
        <h4>${esc(d.municipality ?? '')} — cannot project yet</h4>
        <p class="seat-reason">${esc(d.reason ?? '')}</p>
        <p>${esc(d.detail ?? '')}</p>
      </div>`;
    return;
  }

  host.innerHTML = `
    <div class="seat-live">
      <h4>${esc(d.municipality)}</h4>
      <p class="provenance">quota ${fmt(d.quota)} · ${fmt(d.total_seats)} seats
        · ${fmt(d.surplus_seats)} by largest remainder${d.partial
          ? ' · <b>partial — counted from slips captured so far</b>' : ''}</p>
      ${(d.notes ?? []).map((n) => `<p class="seat-note">${esc(n)}</p>`).join('')}
      ${hemicycleSvg((d.data ?? []).map((p) => ({
          party: p.party, total: p.totalSeats, ward: p.wardSeats, pr: p.prSeats,
        })), host)}
    </div>`;
}

let seatsLoaded = false;
async function loadSeats() {
  return whileLoading('view-seats', async () => {
    if (!seatsLoaded) {
      const sel = $('seat-munic');
      const d = await api('/api/seats/readiness');
      sel.innerHTML = '<option value="">— choose a council —</option>'
        + (d.data ?? []).map((r) =>
            `<option value="${esc(r.demarcation_code)}">${esc(r.municipality)} (${esc(r.province)})</option>`).join('');
      sel.addEventListener('change', (e) => seatProject(e.target.value));
      await seatValidation();
      await seatReadiness();
      seatsLoaded = true;
    }
  });
}

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
  /* The heat map reads its ramp from CSS tokens at draw time, so a theme
     change has to redraw it rather than recolour it. This line used to
     reference the removed viewshed pane - `$('view-viewshed')` returns null
     and `.hidden` on null throws, which would have taken out the theme
     toggle the first time anyone pressed it with the new screen shipped. */
  if (!$('view-heat').hidden) heatDraw();
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
  source.addEventListener('extract_stale', () => { loadOverview(); loadWards(); loadPulse(); });
  source.addEventListener('ward_changed', () => { loadWards(); });

  /* The pulse channels, emitted by statement-level triggers in migration
     051. Coalesced: a busy minute on election night can deliver dozens of
     these, and re-querying on every one would turn the panel into a load
     generator against the database at the exact hour it must stay quick.
     One refresh per 1.5s is well inside what the eye reads as live. */
  let pulseDue = null;
  const pulseSoon = () => {
    if (pulseDue) return;
    pulseDue = setTimeout(() => { pulseDue = null; loadPulse(); }, 1500);
  };
  source.addEventListener('slip_captured', pulseSoon);
  source.addEventListener('booth_reported', pulseSoon);
  source.addEventListener('roster_changed', pulseSoon);
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
  /* The ticker is on every view, so it loads at boot rather than only in
     showView — showView runs on NAVIGATION, and the first screen after
     sign-in never goes through it. Hooking it there alone meant the strip
     stayed hidden until you clicked something. */
  loadTicker();
  /* Same reason as the ticker, and the same bug it had: the live panel lives
     ON the Overview, and showView never runs for the first screen after
     sign-in. loadPulse() was only wired into showView, so the panel it
     belongs to was the one screen that never populated it - you had to
     navigate away and back to see it fill. */
  loadPulse();
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

/* ------------------------------------------------------------- hashtags
 *
 * A budget, not a search box. Instagram allows thirty unique hashtags per
 * rolling seven days and the clock starts at a tag's first query, so the
 * screen's job is to show what is left before someone spends it — and to be
 * honest that nothing is being collected yet, because the token does not
 * exist. An empty table with no explanation reads as "no activity", which is
 * a different and wrong thing.
 */

async function loadHashtags() {
  const host = $('ht-list');
  if (!host) return;
  let data;
  try { ({ data } = await api('/api/hashtags')); }
  catch (err) { host.innerHTML = `<p class="viz-sub">${esc(err.message)}</p>`; return; }

  const q = data.quota || {};
  const used = Number(q.used ?? 0);
  const cap = Number(q.cap ?? 30);
  $('ht-quota').textContent = `${fmt(used)} of ${fmt(cap)} weekly slots in use`;

  /* The connection state is said once, at the top, because every number
     below it depends on it. */
  const connected = data.tags.some((t) => t.resolved || t.last_queried_at);
  $('ht-state').innerHTML = connected ? '' : `<div class="banner-inline">
      <strong>Not collecting yet.</strong> Instagram hashtag search needs a Meta
      access token and App Review, which this deployment does not have. Tags added
      here are a watchlist: nothing is queried, and no counts will appear, until a
      token exists. The same Meta Business process covers WhatsApp ingest.
    </div>`;

  const over = Number(q.tags_enabled ?? 0) > cap;
  const noPlace = Number(q.enabled_without_place ?? 0);
  const warnings = [
    over ? `${fmt(q.tags_enabled)} tags are enabled against a cap of ${fmt(cap)} — a single run cannot query them all.` : '',
    noPlace > 0 ? `${fmt(noPlace)} enabled tag${noPlace === 1 ? '' : 's'} have no municipality and will never be collected.` : '',
  ].filter(Boolean);

  host.innerHTML = `
    ${warnings.map((w) => `<div class="banner-inline is-warn">${esc(w)}</div>`).join('')}
    ${data.tags.length === 0 ? '<p class="viz-sub">No hashtags on the watchlist.</p>' : `
    <table class="logi-table">
      <thead><tr><th>Tag</th><th>Municipality</th><th>Issue</th><th>Last seen</th><th>State</th></tr></thead>
      <tbody>
        ${data.tags.map((t, i) => `<tr>
          <td data-k="Tag"><span class="id">#${esc(t.tag)}</span></td>
          <td data-k="Municipality">${t.municipality
            ? esc(t.municipality)
            : '<span class="viz-sub">no place — not collected</span>'}</td>
          <td data-k="Issue">${esc(t.category ?? '—')}</td>
          <td data-k="Last seen">${t.last_queried_at
            ? `${esc(since((Date.now() - new Date(t.last_queried_at).getTime()) / 60000))}`
              + (t.in_window ? ' <span class="viz-sub">(holding a slot)</span>' : '')
            : '—'}</td>
          <td data-k="State">
            <button class="btn ht-toggle" data-tag="${esc(t.tag)}" data-on="${t.enabled}">
              ${t.enabled ? 'On' : 'Off'}</button></td>
        </tr>`).join('')}
      </tbody>
    </table>`}`;

  host.querySelectorAll('.ht-toggle').forEach((el) => {
    el.addEventListener('click', async () => {
      el.disabled = true;
      try {
        const { data: r } = await api(`/api/hashtags/${encodeURIComponent(el.dataset.tag)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: el.dataset.on !== 'true' }),
        });
        if (r.warning) $('ht-note').textContent = r.warning;
        await loadHashtags();
      } catch (err) {
        $('ht-note').textContent = err.message;
        el.disabled = false;
      }
    });
  });
}

$('ht-add')?.addEventListener('click', async () => {
  const text = $('ht-paste')?.value ?? '';
  if (text.trim() === '') { $('ht-note').textContent = 'Nothing pasted.'; return; }
  const button = $('ht-add');
  button.disabled = true;
  $('ht-note').textContent = 'Adding…';
  try {
    const { data } = await api('/api/hashtags', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const refused = data.refused || [];
    const parts = [`${fmt(data.added)} added`];
    if (data.updated > 0) parts.push(`${fmt(data.updated)} updated`);
    if (refused.length) parts.push(`${fmt(refused.length)} refused`);
    $('ht-note').textContent = parts.join(', ');
    if (data.added > 0 || data.updated > 0) $('ht-paste').value = '';
    await loadHashtags();
    /* After the reload, for the same reason as the roster refusals: the
       reload replaces this element and would wipe them. */
    if (refused.length > 0) {
      $('ht-list').insertAdjacentHTML('afterbegin',
        `<div class="roster-refused">
          <strong>${fmt(refused.length)} not added</strong>
          ${refused.map((r) => `<div><code>${esc(r.line)}</code> — ${esc(r.reason)}</div>`).join('')}
        </div>`);
    }
  } catch (err) {
    $('ht-note').textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

/* ------------------------------------------------------------- ticker
 *
 * Trending topics, along the bottom of every view.
 *
 * There are no headlines to show: the news and press adapters score text and
 * keep counts, and every source has stores_text = false. So this reports
 * movement — which issue, where, is being written about more than it was.
 * A standing count would say "Johannesburg has a lot of electricity
 * coverage", which is true every week and therefore not news.
 *
 * It stays hidden when there is nothing real. v_trending_topics excludes
 * synthetic rows, so an empty result means no genuine trend yet — and an
 * empty ticker is better than a ticker scrolling invented ones.
 */

const DIRECTION_MARK = { UP: '▲', DOWN: '▼', NEW: '●', STEADY: '–' };

async function loadTicker() {
  const el = $('ticker');
  if (!el) return;
  let data;
  try { ({ data } = await api('/api/trending')); }
  catch (err) {
    /* A bare catch here hid the reason the ticker never appeared. A failure
       should still hide the strip — a broken ticker is worse than none — but
       it must not do so silently. */
    console.warn('ticker:', err.message);
    el.hidden = true;
    return;
  }

  if (!data || data.length === 0) { el.hidden = true; return; }

  const item = (t) => {
    const dir = String(t.direction || 'STEADY');
    const mark = DIRECTION_MARK[dir] ?? '–';
    const pct = t.pct_change === null || t.pct_change === undefined
      ? '' : ` ${Number(t.pct_change) > 0 ? '+' : ''}${fmt(t.pct_change)}%`;
    return `<span class="ticker-item">
      <span class="dir ${esc(dir.toLowerCase())}">${mark}</span>
      <b>${esc(t.category)}</b>
      <span>${esc(t.municipality)}</span>
      <span>${fmt(t.recent)} mentions${esc(pct)}</span>
    </span>`;
  };
  /* Doubled, because the keyframe translates by -50%: the second copy is
     what occupies the space the first vacates, so the loop has no gap. */
  const once = data.map(item).join('');
  $('ticker-track').innerHTML = once + once;
  el.hidden = false;
}

$('ticker-pause')?.addEventListener('click', () => {
  const el = $('ticker');
  const paused = el.classList.toggle('is-paused');
  const b = $('ticker-pause');
  b.setAttribute('aria-pressed', String(paused));
  b.setAttribute('aria-label', paused ? 'Resume the ticker' : 'Pause the ticker');
  b.innerHTML = paused ? '&#9654;' : '&#10073;&#10073;';
});
