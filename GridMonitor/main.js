/* Microgrid Forecast Engine - shared script for index.html (input) and dashboard.html (results) */
/* Built-in defaults: the app still works if config.js is missing; config.js only overrides them. */
const CFG_DEFAULTS = {
  API_MODE: 'auto', APPSAIL_BASE: '/server/microgrid_api', FORECAST_PATH: '/forecast',
  QUICKML_ENDPOINT: 'https://api.catalyst.zoho.in/quickml/v1/project/101065000000013024/endpoints/predict',
  REQUEST_TIMEOUT_MS: 8000, SEND_ENGINEERED_FEATURES: false, DEFAULT_DATE: '2024-01-01',
  THRESHOLDS: { overloadKw: 200, storageKw: 160, peakStart: 18, peakEnd: 22 },
  BATTERY: { capacityKwh: 600, startPct: 85, minPct: 10, dischargeShare: 0.4, chargeKwh: 45 }
};
const USER_CFG = window.MICROGRID_CONFIG || {};
const CFG = { ...CFG_DEFAULTS, ...USER_CFG, THRESHOLDS: { ...CFG_DEFAULTS.THRESHOLDS, ...USER_CFG.THRESHOLDS }, BATTERY: { ...CFG_DEFAULTS.BATTERY, ...USER_CFG.BATTERY } };
const { overloadKw: OVERLOAD_KW, storageKw: STORAGE_KW, peakStart: PEAK_START, peakEnd: PEAK_END } = CFG.THRESHOLDS;
const STORE_KEY = 'microgrid_result', HIST_KEY = 'microgrid_history';
const HOURS = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
const FIELDS = ['ambient_temp_c', 'humidity_pct', 'solar_irradiance_wm2'];
const COLORS = { grid: '#5b8def', store: '#2bb3a3', over: '#e5484d', warn: '#c9a45c' };
const MODE_NAME = { grid: 'Main Grid Mode', store: 'Renewable Storage Mode' };
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function navigate(url) {
  document.body.classList.add('leaving');
  setTimeout(() => { window.location.href = url; }, 420);
}

function countUp(el, to, { suffix = '', duration = 1200 } = {}) {
  const start = performance.now();
  const tick = (t) => {
    const p = Math.min((t - start) / duration, 1), e = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(to * e) + suffix;
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function setupFx() {
  // ripple on buttons
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.btn-primary, .btn-ghost');
    if (!b) return;
    const r = b.getBoundingClientRect(), s = Math.max(r.width, r.height);
    const sp = document.createElement('span');
    sp.className = 'ripple';
    sp.style.cssText = `width:${s}px;height:${s}px;left:${e.clientX - r.left - s / 2}px;top:${e.clientY - r.top - s / 2}px`;
    b.appendChild(sp); setTimeout(() => sp.remove(), 600);
  });
  // cursor spotlight + gentle 3D tilt
  document.querySelectorAll('.panel, .kpi').forEach((el) => {
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      el.style.setProperty('--mx', x + 'px'); el.style.setProperty('--my', y + 'px');
      if (el.classList.contains('tilt') && !el.classList.contains('wide')) {
        el.style.transform = `perspective(900px) rotateX(${((y / r.height) - .5) * -5}deg) rotateY(${((x / r.width) - .5) * 5}deg)`;
      }
    });
    el.addEventListener('pointerleave', () => { el.style.transform = ''; });
  });
  // page transitions for in-site links
  document.querySelectorAll('a[data-nav]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); navigate(a.href); }));
  const clock = $('clock');
  if (clock) { const t = () => (clock.textContent = new Date().toLocaleTimeString('en-GB')); t(); setInterval(t, 1000); }
}

/* Animated background: drifting energy nodes linked by lines; they react to the pointer */
function startBackground() {
  const c = $('bgCanvas'), ctx = c.getContext('2d');
  let w, h, nodes = [], mouse = { x: -999, y: -999 };
  const resize = () => {
    w = c.width = innerWidth; h = c.height = innerHeight;
    nodes = Array.from({ length: Math.min(70, Math.floor(w * h / 22000)) }, () => ({
      x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - .5) * .35, vy: (Math.random() - .5) * .35, t: Math.random() < .5 ? COLORS.grid : COLORS.store
    }));
  };
  addEventListener('resize', resize); resize();
  addEventListener('pointermove', (e) => { mouse = { x: e.clientX, y: e.clientY }; });
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  (function frame() {
    ctx.clearRect(0, 0, w, h);
    for (const n of nodes) {
      const dx = n.x - mouse.x, dy = n.y - mouse.y, d = Math.hypot(dx, dy);
      if (d < 140) { n.x += dx / d * 1.4; n.y += dy / d * 1.4; }
      n.x += n.vx; n.y += n.vy;
      if (n.x < 0 || n.x > w) n.vx *= -1;
      if (n.y < 0 || n.y > h) n.vy *= -1;
    }
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      ctx.beginPath(); ctx.fillStyle = a.t; ctx.globalAlpha = .55; ctx.arc(a.x, a.y, 2, 0, 7); ctx.fill();
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j], d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < 130) { ctx.globalAlpha = (1 - d / 130) * .22; ctx.strokeStyle = '#7f9ccf'; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
      }
    }
    requestAnimationFrame(frame);
  })();
}


/* ---------- transition controller (deterministic rules) ---------- */
function controller(kw, hour) {
  return { mode: kw > STORAGE_KW || (hour >= PEAK_START && hour <= PEAK_END) ? 'store' : 'grid', alert: kw >= OVERLOAD_KW };
}
const hourOf = (ts) => parseInt(ts.slice(11, 13), 10);

function simulateBattery(results, rows) {
  const B = CFG.BATTERY; let soc = B.startPct;
  return results.map((r, i) => {
    if (r.mode === 'store') soc -= (r.kw * B.dischargeShare) / B.capacityKwh * 100;
    else soc += (B.chargeKwh * (0.5 + (rows[i]?.solar_irradiance_wm2 || 0) / 1000)) / B.capacityKwh * 100;
    soc = Math.min(100, Math.max(B.minPct, soc));
    return +soc.toFixed(1);
  });
}

/* ---------- data preparation ---------- */
function normTs(s = '') {
  let m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) return `${m[1]} ${m[2]}:${m[3]}:${m[4] || '00'}`;
  m = s.match(/^(\d{1,2}):(\d{2})/);
  return m ? `${CFG.DEFAULT_DATE} ${m[1].padStart(2, '0')}:${m[2]}:00` : null;
}

/* Mean imputation for blank or non-numeric cells; returns how many cells were filled */
function cleanRows(rows) {
  let imputed = 0;
  FIELDS.forEach((f) => {
    const ok = rows.map((r) => r[f]).filter((v) => v !== null && !Number.isNaN(v));
    if (!ok.length) throw new Error(`Column "${f}" has no valid values.`);
    const mean = +(ok.reduce((a, b) => a + b, 0) / ok.length).toFixed(2);
    rows.forEach((r) => { if (r[f] === null || Number.isNaN(r[f])) { r[f] = mean; imputed++; } });
  });
  return { rows, imputed };
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw new Error('The file is empty.');
  let idx = { timestamp: 0, ambient_temp_c: 1, humidity_pct: 2, solar_irradiance_wm2: 3 }, body = lines;
  if (/timestamp|temp|humid|solar/i.test(lines[0])) {
    const head = lines[0].split(',').map((h) => h.trim().toLowerCase()); idx = {};
    const missing = ['timestamp', ...FIELDS].filter((c) => (idx[c] = head.indexOf(c)) < 0);
    if (missing.length) throw new Error(`Missing required column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`);
    body = lines.slice(1);
  }
  if (body.length < 24) throw new Error(`Found ${body.length} data row${body.length === 1 ? '' : 's'}. The forecast needs exactly 24 hourly rows.`);
  const rows = body.slice(0, 24).map((line, i) => {
    const p = line.split(',').map((s) => s.trim()), ts = normTs(p[idx.timestamp]);
    if (!ts) throw new Error(`Row ${i + 1}: timestamp must look like YYYY-MM-DD HH:MM:SS.`);
    const r = { timestamp: ts };
    FIELDS.forEach((f) => { const n = parseFloat(p[idx[f]]); r[f] = Number.isNaN(n) ? null : n; });
    return r;
  });
  return { ...cleanRows(rows), notice: body.length > 24 ? `Only the first 24 of ${body.length} rows are used.` : '' };
}

const toCsv = (rows) => 'timestamp,' + FIELDS.join(',') + '\n' + rows.map((r) => [r.timestamp, ...FIELDS.map((f) => r[f])].join(',')).join('\n');

/* Optional engineered features. They MUST match the features used to train the QuickML model. */
function buildFeatures(rows) {
  return rows.map((r, i) => {
    const h = hourOf(r.timestamp), d = new Date(r.timestamp.slice(0, 10) + 'T00:00:00'), prev = rows[i - 1] || r;
    return { ...r, hour: h, day_of_week: (d.getDay() + 6) % 7, month: d.getMonth() + 1,
      hour_sin: +Math.sin(2 * Math.PI * h / 24).toFixed(6), hour_cos: +Math.cos(2 * Math.PI * h / 24).toFixed(6),
      ambient_temp_c_lag1: prev.ambient_temp_c, solar_irradiance_wm2_lag1: prev.solar_irradiance_wm2 };
  });
}

/* ---------- forecasting pipeline ---------- */
function localForecast(rows) {
  return rows.map((r) => {
    const hour = hourOf(r.timestamp);
    const base = 95 + r.ambient_temp_c * 1.7 - r.humidity_pct * 0.1 + r.solar_irradiance_wm2 * 0.04;
    return Math.round(base + (hour >= PEAK_START && hour <= PEAK_END ? 58 : hour >= 10 && hour <= 16 ? 28 : 0));
  });
}
const toResults = (rows, preds) => rows.map((r, i) => {
  const kw = Math.round(Number(preds[i]) * 10) / 10;
  return { timestamp: r.timestamp, kw, ...controller(kw, hourOf(r.timestamp)) };
});
function fromBackend(x, row) {
  const kw = Math.round(Number(x.predicted_demand_kw ?? x.target_demand_kw ?? x.kw) * 10) / 10, ts = row.timestamp, c = controller(kw, hourOf(ts));
  return { timestamp: ts, kw, mode: x.grid_mode ? (/renewable|store/i.test(x.grid_mode) ? 'store' : 'grid') : c.mode, alert: x.critical_alert ?? c.alert };
}
async function fetchJson(url, opts) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), CFG.REQUEST_TIMEOUT_MS);
  try { const res = await fetch(url, { ...opts, signal: ac.signal }); if (!res.ok) throw new Error('HTTP ' + res.status); return await res.json(); }
  finally { clearTimeout(t); }
}
async function runForecast(rows, upload) {
  const m = CFG.API_MODE;
  if (m === 'auto' || m === 'appsail') {
    try {
      const fd = new FormData(); fd.append('file', upload, 'telemetry.csv');
      const j = await fetchJson(CFG.APPSAIL_BASE + CFG.FORECAST_PATH, { method: 'POST', body: fd });
      const list = j.forecast || j.results || (Array.isArray(j) ? j : null);
      if (list && list.length >= rows.length) return { source: 'AppSail + QuickML', results: rows.map((r, i) => fromBackend(list[i], r)) };
    } catch (e) { console.warn('AppSail unavailable:', e.message); }
  }
  if (m === 'auto' || m === 'quickml') {
    try {
      const data = CFG.SEND_ENGINEERED_FEATURES ? buildFeatures(rows) : rows;
      const j = await fetchJson(CFG.QUICKML_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) });
      const list = Array.isArray(j.predictions) ? j.predictions : Array.isArray(j.data) ? j.data : null;
      if (list && list.length >= rows.length) return { source: 'QuickML model', results: toResults(rows, list) };
    } catch (e) { console.warn('QuickML unavailable:', e.message); }
  }
  return { source: 'Local estimate', results: toResults(rows, localForecast(rows)) };
}

/* Reset transient UI so a restored (back/forward) page is never blank */
function resetTransient() {
  document.body.classList.remove('leaving');
  const l = $('loader');
  if (l) { l.classList.add('hidden'); const t = $('loaderTitle'); if (t) t.textContent = 'Running pipeline'; document.querySelectorAll('#loaderSteps li').forEach((s) => s.classList.remove('active', 'done')); }
}
addEventListener('pagehide', resetTransient);
addEventListener('pageshow', (e) => { resetTransient(); if (e.persisted || +getComputedStyle(document.body).opacity < 0.05) { document.body.style.animation = 'none'; void document.body.offsetWidth; document.body.style.animation = ''; } });

/* ---------- INPUT PAGE ---------- */
function initInput() {
  let mode = 'csv', csv = null;
  const tabs = document.querySelector('.tabs'), err = $('errorMsg');
  const showErr = (m) => { err.textContent = m; err.classList.remove('hidden'); err.style.animation = 'none'; void err.offsetWidth; err.style.animation = ''; };
  const clearErr = () => err.classList.add('hidden');
  if ($('apiChip')) $('apiChip').textContent = { auto: 'Auto: AppSail, QuickML, local', appsail: 'AppSail backend', quickml: 'QuickML direct', local: 'Local demo' }[CFG.API_MODE] || CFG.API_MODE;
  if ($('dateInput')) $('dateInput').value = CFG.DEFAULT_DATE;

  const setMode = (m) => {
    mode = m; clearErr(); tabs.classList.toggle('manual', m === 'manual');
    $('tabCsv').classList.toggle('active', m === 'csv'); $('tabManual').classList.toggle('active', m === 'manual');
    $('sectionCsv').classList.toggle('hidden', m !== 'csv'); $('sectionManual').classList.toggle('hidden', m !== 'manual');
  };
  $('tabCsv').onclick = () => setMode('csv'); $('tabManual').onclick = () => setMode('manual');

  /* CSV */
  async function handleFile(file) {
    clearErr(); csv = null; $('csvPreview').classList.add('hidden'); $('csvQuality').classList.add('hidden');
    if (!file) return;
    try {
      csv = { ...parseCsv(await file.text()), file };
      $('dzTitle').textContent = file.name; $('dropzone').classList.add('ok');
      $('fileNameDisplay').textContent = '24 rows loaded';
      $('csvQuality').innerHTML = `<b>Schema valid</b>: 24 rows, timestamps OK. ` + (csv.imputed ? `<span class="warn">${csv.imputed} missing value${csv.imputed > 1 ? 's' : ''} filled with column averages.</span>` : 'No missing values.') + (csv.notice ? ` <span class="warn">${csv.notice}</span>` : '');
      $('csvQuality').classList.remove('hidden');
      $('csvPreview').innerHTML = '<table><thead><tr><th>Timestamp</th><th>Temp °C</th><th>Humidity %</th><th>Solar W/m²</th></tr></thead><tbody>' +
        csv.rows.slice(0, 4).map((r) => `<tr><td>${r.timestamp}</td><td>${r.ambient_temp_c}</td><td>${r.humidity_pct}</td><td>${r.solar_irradiance_wm2}</td></tr>`).join('') + '</tbody><caption>First 4 of 24 rows</caption></table>';
      $('csvPreview').classList.remove('hidden');
    } catch (e) { $('dropzone').classList.remove('ok'); $('dzTitle').textContent = 'Drop a CSV file here, or click to browse'; $('fileNameDisplay').textContent = 'Columns: timestamp, ambient_temp_c, humidity_pct, solar_irradiance_wm2 (24 rows)'; showErr(e.message); }
  }
  $('csvFileInput').onchange = (e) => handleFile(e.target.files[0]);
  const dz = $('dropzone');
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));

  /* Manual: sliders fill an editable 24-row table */
  const sliderVals = () => ({ t: +$('tempInput').value, h: +$('humidityInput').value, s: +$('solarInput').value });
  const profile = () => { const { t, h, s } = sliderVals(); return HOURS.map((_, i) => ({
    ambient_temp_c: +(t + 4 * Math.sin(((i - 9) / 24) * 2 * Math.PI)).toFixed(1), humidity_pct: h,
    solar_irradiance_wm2: i >= 6 && i <= 18 ? Math.round(s * Math.sin(((i - 6) / 12) * Math.PI)) : 0 })); };
  const fillTable = () => { $('hourlyBody').innerHTML = profile().map((r, i) => `<tr><td>${HOURS[i]}</td>` +
    FIELDS.map((f) => `<td><input type="number" step="0.1" data-f="${f}" value="${r[f]}" aria-label="${f} at ${HOURS[i]}"></td>`).join('') + '</tr>').join(''); };
  [['tempInput', 'tempOut', ' °C'], ['humidityInput', 'humOut', ' %'], ['solarInput', 'solOut', ' W/m²']].forEach(([i, o, u]) => {
    const el = $(i), upd = () => { $(o).textContent = el.value + u; el.style.setProperty('--p', ((el.value - el.min) / (el.max - el.min)) * 100 + '%'); };
    el.addEventListener('input', () => { upd(); fillTable(); }); upd();
  });
  fillTable();
  const manualRows = () => [...$('hourlyBody').rows].map((tr, i) => {
    const r = { timestamp: `${$('dateInput').value || CFG.DEFAULT_DATE} ${HOURS[i]}:00` };
    tr.querySelectorAll('input').forEach((inp) => { const n = parseFloat(inp.value); r[inp.dataset.f] = Number.isNaN(n) ? null : n; });
    return r;
  });

  $('btnSample').onclick = () => {
    const rows = profile().map((r, i) => ({ timestamp: `${CFG.DEFAULT_DATE} ${HOURS[i]}:00`, ...r }));
    Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv' })), download: 'sample_test_input.csv' }).click();
  };

  document.querySelectorAll('[data-count]').forEach((el, i) => setTimeout(() => countUp(el, +el.dataset.count, { duration: 1400 }), 300 + i * 150));

  /* Recent runs (stored in this browser) */
  try {
    const hist = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
    if (hist.length) {
      $('history').classList.remove('hidden');
      hist.forEach((h) => {
        const b = document.createElement('button'), a = document.createElement('span'), c = document.createElement('span');
        a.textContent = `${h.results[0].timestamp.slice(0, 10)} · peak ${Math.max(...h.results.map((r) => r.kw))} kW`;
        c.textContent = new Date(h.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        b.append(a, c); b.onclick = () => { sessionStorage.setItem(STORE_KEY, JSON.stringify(h)); navigate('dashboard.html'); };
        $('historyList').appendChild(b);
      });
    }
  } catch { /* storage unavailable */ }

  $('btnGenerate').onclick = async () => {
    clearErr(); let rows, imputed, upload;
    try {
      if (mode === 'csv') { if (!csv) return showErr('Choose a valid CSV file first, or switch to manual entry.'); ({ rows, imputed } = csv); upload = csv.file; }
      else { ({ rows, imputed } = cleanRows(manualRows())); upload = new Blob([toCsv(rows)], { type: 'text/csv' }); }
    } catch (e) { return showErr(e.message); }

    const loader = $('loader'), steps = [...document.querySelectorAll('#loaderSteps li')];
    loader.classList.remove('hidden');
    const mark = (i) => steps.forEach((s, k) => { s.classList.toggle('done', k < i); s.classList.toggle('active', k === i); });
    mark(0); await sleep(500);
    mark(1); await sleep(400);
    mark(2); const out = await runForecast(rows, upload);
    mark(3); await sleep(500);
    mark(4); $('loaderTitle').textContent = 'Opening results';
    const payload = { results: out.results, rows, source: out.source, imputed, createdAt: Date.now() };
    sessionStorage.setItem(STORE_KEY, JSON.stringify(payload));
    try { const h = JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); h.unshift(payload); localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(0, 5))); } catch { /* ignore */ }
    await sleep(600);
    steps.forEach((s) => { s.classList.remove('active'); s.classList.add('done'); });
    navigate('dashboard.html');
  };
}

/* ---------- DASHBOARD PAGE ---------- */
function initDashboard() {
  let data;
  try { data = JSON.parse(sessionStorage.getItem(STORE_KEY)); } catch { data = null; }
  if (!data || !data.results) { location.replace('index.html'); return; }

  const { results, rows = [], source, imputed = 0 } = data;
  const kws = results.map((r) => r.kw), labels = results.map((r) => r.timestamp.slice(11, 16));
  const socs = simulateBattery(results, rows);
  const peak = Math.max(...kws), peakIdx = kws.indexOf(peak), avg = Math.round(kws.reduce((a, b) => a + b, 0) / kws.length);
  const nStore = results.filter((r) => r.mode === 'store').length, nAlert = results.filter((r) => r.alert).length;
  const colorOf = (r) => (r.alert ? COLORS.over : COLORS[r.mode]);

  $('sourceChip').textContent = source;
  $('qualityChip').textContent = imputed ? `${imputed} values filled` : 'Complete data';
  const hero = document.querySelector('.mode-hero');
  hero.style.setProperty('--hc', nAlert ? COLORS.over : nStore ? COLORS.store : COLORS.grid);
  $('modeTitle').textContent = nStore ? 'Renewable storage required' : 'Main grid mode all day';
  $('modeDesc').textContent = nStore ? `Storage supplies ${nStore} of 24 hours (demand above ${STORAGE_KW} kW or the ${PEAK_START}:00 to ${PEAK_END}:00 peak window).` : `Demand stays at or below ${STORAGE_KW} kW outside the evening window.`;
  if (nAlert) { $('alertBanner').classList.remove('hidden'); $('alertText').textContent = `Critical overload: forecast reaches ${peak} kW at ${labels[peakIdx]}. ${nAlert} hour${nAlert > 1 ? 's are' : ' is'} at or above ${OVERLOAD_KW} kW.`; }

  const pct = Math.round((peak / OVERLOAD_KW) * 100);
  requestAnimationFrame(() => { $('gaugeFg').style.strokeDashoffset = 326.7 * (1 - Math.min(pct, 100) / 100); });
  countUp($('gaugeVal'), pct, { suffix: '%' });
  countUp($('kPeak'), Math.round(peak), { suffix: ' kW' }); countUp($('kAvg'), avg, { suffix: ' kW' });
  countUp($('kStore'), nStore); countUp($('kOver'), nAlert);
  $('kPeakHr').textContent = `at ${labels[peakIdx]}`;

  /* Chart: segments coloured by mode, threshold lines, moving marker, optional battery overlay */
  let active = peakIdx, chart, showSoc = false, type = 'line';
  const ctx = $('forecastChart').getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 340);
  grad.addColorStop(0, 'rgba(91,141,239,.3)'); grad.addColorStop(1, 'rgba(91,141,239,0)');
  const overlay = { id: 'overlay', afterDatasetsDraw(ch) {
    const { ctx: c, chartArea: a, scales: { y, x } } = ch; c.save(); c.setLineDash([6, 5]); c.lineWidth = 1.2; c.font = '11px IBM Plex Sans';
    [[STORAGE_KW, COLORS.warn, `${STORAGE_KW} kW storage threshold`], [OVERLOAD_KW, COLORS.over, `${OVERLOAD_KW} kW critical alert`]].forEach(([v, col, txt]) => {
      const yy = y.getPixelForValue(v); if (yy < a.top || yy > a.bottom) return;
      c.strokeStyle = col; c.fillStyle = col; c.beginPath(); c.moveTo(a.left, yy); c.lineTo(a.right, yy); c.stroke(); c.fillText(txt, a.left + 6, yy - 5); });
    c.setLineDash([]); c.strokeStyle = 'rgba(232,237,245,.55)'; c.lineWidth = 1.5; const xx = x.getPixelForValue(active);
    c.beginPath(); c.moveTo(xx, a.top); c.lineTo(xx, a.bottom); c.stroke(); c.restore(); } };
  const build = () => {
    if (typeof Chart === 'undefined') return;
    if (chart) chart.destroy();
    chart = new Chart(ctx, { type, plugins: [overlay], data: { labels, datasets: [
      { label: 'Forecast demand (kW)', data: kws, borderColor: COLORS.grid, backgroundColor: type === 'bar' ? results.map((r) => colorOf(r) + 'cc') : grad, fill: true, tension: .35, borderWidth: 2.5, borderRadius: 5,
        segment: { borderColor: (c) => colorOf(results[c.p1DataIndex]) }, pointBackgroundColor: results.map(colorOf), pointBorderColor: '#0c1524', pointBorderWidth: 2, pointRadius: 5, pointHoverRadius: 9 },
      { type: 'line', label: 'Battery (%)', data: socs, yAxisID: 'y1', hidden: !showSoc, borderColor: COLORS.warn, borderDash: [4, 4], borderWidth: 2, pointRadius: 0, tension: .3 }] },
      options: { responsive: true, maintainAspectRatio: false, animation: { duration: 1000, easing: 'easeOutQuart' }, interaction: { mode: 'index', intersect: false },
        onHover: (_, els) => { if (els.length && els[0].index !== active) select(els[0].index); },
        scales: { y: { beginAtZero: true, grid: { color: 'rgba(143,160,187,.12)' }, ticks: { color: '#8fa0bb' } }, y1: { position: 'right', min: 0, max: 100, display: 'auto', grid: { drawOnChartArea: false }, ticks: { color: COLORS.warn, callback: (v) => v + '%' } },
          x: { grid: { display: false }, ticks: { color: '#8fa0bb', maxRotation: 0 } } },
        plugins: { legend: { display: false }, tooltip: { backgroundColor: '#0c1524', borderColor: '#243656', borderWidth: 1, padding: 12, titleColor: '#e8edf5', bodyColor: '#c4cfe2',
          callbacks: { label: (c) => c.datasetIndex ? ` Battery ${c.parsed.y}%` : ` ${c.parsed.y} kW, ${MODE_NAME[results[c.dataIndex].mode]}${results[c.dataIndex].alert ? ' (critical)' : ''}` } } } } });
  };
  const hasChart = typeof Chart !== 'undefined';
  if (!hasChart) $('forecastChart').parentElement.innerHTML = '<p class="muted" style="padding:24px">The chart library could not load (check your internet connection). All other results are shown below.</p>';
  build();
  $('chartToggle').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; type = b.dataset.type; document.querySelectorAll('#chartToggle button').forEach((x) => x.classList.toggle('active', x === b)); build(); });
  $('toggleSoc').onchange = (e) => { showSoc = e.target.checked; if (chart) { chart.setDatasetVisibility(1, showSoc); chart.update(); } };

  /* Timeline + table */
  const maxKw = Math.max(peak, OVERLOAD_KW);
  const tl = $('timeline'), tbody = $('tbody');
  tl.innerHTML = results.map((r, i) => `<div class="cell${r.alert ? ' alert' : ''}" data-i="${i}" style="--i:${i};--c:${COLORS[r.mode]};--h:${Math.max(12, (r.kw / maxKw) * 100)}%" title="${labels[i]}: ${r.kw} kW"></div>`).join('');
  tl.insertAdjacentHTML('afterend', '<div class="cell-labels">' + labels.map((l, i) => `<span>${i % 3 === 0 ? l.slice(0, 2) : ''}</span>`).join('') + '</div>');
  tbody.innerHTML = results.map((r, i) => `<tr data-i="${i}" data-store="${r.mode === 'store'}" data-alert="${r.alert}"><td>${labels[i]}</td><td>${r.kw}</td>
    <td><div class="bar"><i data-w="${Math.min(100, (r.kw / OVERLOAD_KW) * 100)}" style="--c:${colorOf(r)}"></i></div></td>
    <td><span class="tag" style="--c:${COLORS[r.mode]}">${MODE_NAME[r.mode]}</span></td>
    <td>${r.alert ? '<span class="tag" style="--c:#e5484d">Critical</span>' : '<span class="muted">None</span>'}</td><td>${socs[i]}%</td></tr>`).join('');
  setTimeout(() => document.querySelectorAll('.bar i').forEach((b) => (b.style.width = b.dataset.w + '%')), 300);
  $('filterSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return; const f = b.dataset.f;
    document.querySelectorAll('#filterSeg button').forEach((x) => x.classList.toggle('active', x === b));
    [...tbody.rows].forEach((tr) => { tr.hidden = f === 'store' ? tr.dataset.store !== 'true' : f === 'alert' ? tr.dataset.alert !== 'true' : false; });
  });

  /* One function keeps chart, timeline, table, badge and battery in sync */
  function select(i) {
    active = i; const r = results[i], row = rows[i], c = colorOf(r);
    document.querySelectorAll('.cell.sel, tbody tr.sel').forEach((n) => n.classList.remove('sel'));
    document.querySelector(`.cell[data-i="${i}"]`)?.classList.add('sel'); document.querySelector(`tbody tr[data-i="${i}"]`)?.classList.add('sel');
    $('detail').innerHTML = `<b>${r.timestamp}</b> · ${r.kw} kW (${Math.round(r.kw / OVERLOAD_KW * 100)}% of limit) · <b style="color:${c}">${MODE_NAME[r.mode]}</b>${r.alert ? ' · <b style="color:#e5484d">Critical overload</b>' : ''}` +
      (row ? `<br>Inputs: ${row.ambient_temp_c} °C, ${row.humidity_pct}% humidity, ${row.solar_irradiance_wm2} W/m² solar` : '');
    $('detail').style.borderColor = c;
    const badge = $('liveBadge'); badge.style.setProperty('--hc', c); badge.classList.remove('pop'); void badge.offsetWidth; badge.classList.add('pop');
    $('liveTime').textContent = labels[i]; $('liveMode').textContent = MODE_NAME[r.mode]; $('liveKw').textContent = `${r.kw} kW predicted`;
    $('liveAlert').classList.toggle('hidden', !r.alert);
    $('socVal').textContent = socs[i] + '%'; $('socFill').style.width = socs[i] + '%';
    $('socFill').style.background = socs[i] <= CFG.BATTERY.minPct + 5 ? COLORS.over : socs[i] < 40 ? COLORS.warn : COLORS.store;
    $('socNote').textContent = socs[i] <= CFG.BATTERY.minPct ? 'Reserve limit reached: storage cannot cover more load.' : r.mode === 'store' ? 'Discharging to cover load.' : 'Charging from surplus supply.';
    const sc = $('scrub'); sc.value = i; sc.style.setProperty('--p', (i / 23) * 100 + '%');
    chart?.draw();
  }
  [tl, tbody].forEach((el) => { el.addEventListener('mouseover', (e) => { const t = e.target.closest('[data-i]'); if (t && +t.dataset.i !== active) select(+t.dataset.i); });
    el.addEventListener('click', (e) => { const t = e.target.closest('[data-i]'); if (t) select(+t.dataset.i); }); });
  $('scrub').addEventListener('input', (e) => select(+e.target.value));

  let timer = null;
  const stop = () => { clearInterval(timer); timer = null; $('btnPlay').textContent = 'Play'; };
  $('btnPlay').onclick = () => {
    if (timer) return stop();
    if (active >= 23) select(0);
    $('btnPlay').textContent = 'Pause';
    timer = setInterval(() => { if (active >= 23) return stop(); select(active + 1); }, 650);
  };
  $('btnRestart').onclick = () => { stop(); select(0); };
  select(peakIdx);

  /* Exports */
  const save = (name, text, mime) => Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type: mime })), download: name }).click();
  $('btnPred').onclick = () => save('predictions.csv', 'timestamp,target_demand_kw\n' + results.map((r) => `${r.timestamp},${r.kw}`).join('\n') + '\n', 'text/csv');
  $('btnFull').onclick = () => save('forecast_results.csv', 'timestamp,predicted_demand_kw,grid_mode,critical_alert,battery_pct\n' + results.map((r, i) => `${r.timestamp},${r.kw},${MODE_NAME[r.mode]},${r.alert},${socs[i]}`).join('\n') + '\n', 'text/csv');
  $('btnJson').onclick = () => save('forecast_results.json', JSON.stringify(results.map((r) => ({ timestamp: r.timestamp, predicted_demand_kw: r.kw, grid_mode: MODE_NAME[r.mode], critical_alert: r.alert })), null, 2), 'application/json');
}

document.addEventListener('DOMContentLoaded', () => {
  startBackground(); setupFx();
  document.body.dataset.page === 'input' ? initInput() : initDashboard();
});
