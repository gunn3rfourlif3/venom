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

async function loadStatement() {
  const { data, as_of } = await api('/api/campaign');
  if (!data) return;
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

async function loadHealth() {
  const { data } = await api('/api/ingest-health');
  $('health-list').innerHTML = data.length ? data.map((s) => `
    <article class="card-line">
      <h3>${esc(s.source)}</h3>
      <p class="meta">Last fetched ${s.last_fetch_at ? new Date(s.last_fetch_at).toLocaleString('en-ZA') : 'never'},
        last promoted ${s.last_promote_at ? new Date(s.last_promote_at).toLocaleString('en-ZA') : 'never'},
        ${s.errors_total} error${s.errors_total === 1 ? '' : 's'}, ${s.pending} pending</p>
    </article>`).join('')
    : '<p class="empty">Nothing has been ingested yet. Run the baseline fetch once IEC credentials are issued.</p>';
}

/* ------------------------------------------------------------ views */

document.querySelector('.views').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]'); if (!btn) return;
  const view = btn.dataset.view;
  document.querySelectorAll('.views button').forEach((b) => b.classList.toggle('is-current', b === btn));
  for (const name of ['wards', 'decisions', 'float', 'health']) {
    $(`view-${name}`).hidden = name !== view;
  }
  if (view === 'decisions') loadDecisions();
  if (view === 'float') loadFloat();
  if (view === 'health') loadHealth();
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
