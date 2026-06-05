'use strict';

// ── BLE constants ─────────────────────────────────────────────────────────────
const PROGRESSOR_SERVICE = '7e4e1701-1ea6-40c9-9dcc-13d34ffead57';
const DATA_CHAR          = '7e4e1702-1ea6-40c9-9dcc-13d34ffead57';
const CTRL_CHAR          = '7e4e1703-1ea6-40c9-9dcc-13d34ffead57';

const CMD = {
  TARE:             100,
  START_WEIGHT:     101,
  STOP_WEIGHT:      102,
  GET_VERSION:      107,
  SLEEP:            110,
  GET_BATTERY:      111,
};

const RES = {
  CMD_RESPONSE:    0,
  WEIGHT_MEAS:     1,
  LOW_PWR_WARNING: 4,
};

// ── Detection constants ───────────────────────────────────────────────────────
const CHART_WINDOW_MS = 10000;
const DEBOUNCE_MS     = 300;
const MIN_DURATION_MS = 150;

// ── BLE state ─────────────────────────────────────────────────────────────────
let _device   = null;
let _dataChar = null;
let _ctrlChar = null;
let _measuring = false;

// ── Chart state ───────────────────────────────────────────────────────────────
let _chartPoints  = [];   // { kg, t } — t = ms since _measureStart
let _measureStart = 0;    // performance.now() when measurement began
let _rafId        = null;

// ── Contraction state machine ─────────────────────────────────────────────────
// States: 'idle' | 'active' | 'debounce'
let _cState   = 'idle';
let _cBuffer  = [];         // { kg, t } accumulator for current contraction
let _debTimer = null;

// ── Measurement buffers ───────────────────────────────────────────────────────
let _contractions      = [];
let _leftContractions  = [];
let _rightContractions = [];

// ── Config ────────────────────────────────────────────────────────────────────
let _thresholdKg = 2.0;
let _repsTarget  = 3;
let _laterality  = 'single';
let _activeSide  = null;

// ── Session ───────────────────────────────────────────────────────────────────
const _sessionCh  = new BroadcastChannel('physiq-session');
let _patient      = '';
let _savedResults = null;

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  _detectHub();
  _checkBLESupport();
  _bindUI();
  _loadSession();
  _registerSW();
});

// ── BLE support ───────────────────────────────────────────────────────────────
function _checkBLESupport() {
  _showScreen(navigator.bluetooth ? 'screen-connect' : 'screen-no-ble');
}

// ── BLE connect / disconnect ──────────────────────────────────────────────────
async function bleConnect() {
  try {
    _device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'Progressor' }],
      optionalServices: [PROGRESSOR_SERVICE],
    });
    _device.addEventListener('gattserverdisconnected', _onDisconnect);

    const server = await _device.gatt.connect();
    const svc    = await server.getPrimaryService(PROGRESSOR_SERVICE);
    _dataChar    = await svc.getCharacteristic(DATA_CHAR);
    _ctrlChar    = await svc.getCharacteristic(CTRL_CHAR);

    await _dataChar.startNotifications();
    _dataChar.addEventListener('characteristicvaluechanged', _onData);

    await _writeCmd(CMD.GET_BATTERY);
    await _writeCmd(CMD.GET_VERSION);

    _setBLEStatus('connected');
    _showScreen('screen-config');
  } catch (err) {
    if (err.name !== 'NotFoundError') console.warn('BLE:', err);
    _setBLEStatus('disconnected');
  }
}

async function bleDisconnect() {
  if (_measuring) await _stopMeasurement();
  _device?.gatt?.disconnect();
}

function _onDisconnect() {
  _device = null; _dataChar = null; _ctrlChar = null;
  _measuring = false;
  _stopChartLoop();
  _setBLEStatus('disconnected');
  _showScreen('screen-connect');
}

async function _writeCmd(cmd) {
  if (!_ctrlChar) return;
  await _ctrlChar.writeValue(new Uint8Array([cmd]));
}

// ── BLE data handler ──────────────────────────────────────────────────────────
function _onData(e) {
  const dv   = new DataView(e.target.value.buffer);
  const type = dv.getUint8(0);

  if (type === RES.WEIGHT_MEAS) {
    const count = Math.floor((dv.byteLength - 2) / 8);
    for (let i = 0; i < count; i++) {
      _onSample(Math.max(0, dv.getFloat32(2 + i * 8, true)));
    }
  } else if (type === RES.LOW_PWR_WARNING) {
    document.getElementById('battery-warning').hidden = false;
  }
}

// ── Measurement control ───────────────────────────────────────────────────────
async function startMeasurement() {
  _contractions = [];
  _chartPoints  = [];
  _cState       = 'idle';
  _cBuffer      = [];
  clearTimeout(_debTimer);
  _measuring    = true;
  _measureStart = performance.now();

  _renderLiveReset();
  _initCanvas();
  _startChartLoop();

  await _writeCmd(CMD.TARE);
  await _writeCmd(CMD.START_WEIGHT);
}

async function _stopMeasurement() {
  if (!_measuring) return;
  _measuring = false;
  clearTimeout(_debTimer);
  if (_cState === 'active' || _cState === 'debounce') _finalizeContraction();
  _cState = 'idle';
  await _writeCmd(CMD.STOP_WEIGHT);
  _stopChartLoop();
}

// ── Contraction detection ─────────────────────────────────────────────────────
function _onSample(kg) {
  const t = performance.now() - _measureStart;

  _chartPoints.push({ kg, t });
  const cutoff = t - CHART_WINDOW_MS;
  while (_chartPoints.length > 1 && _chartPoints[0].t < cutoff) _chartPoints.shift();

  _renderLiveValue(kg);

  if (_cState === 'idle') {
    if (kg >= _thresholdKg) {
      _cState  = 'active';
      _cBuffer = [{ kg, t }];
    }
  } else if (_cState === 'active') {
    _cBuffer.push({ kg, t });
    if (kg < _thresholdKg) {
      _cState = 'debounce';
      _debTimer = setTimeout(_finalizeContraction, DEBOUNCE_MS);
    }
  } else if (_cState === 'debounce') {
    _cBuffer.push({ kg, t });
    if (kg >= _thresholdKg) {
      clearTimeout(_debTimer);
      _cState = 'active';
    }
  }
}

function _finalizeContraction() {
  const buf = _cBuffer;
  _cBuffer = [];
  _cState  = 'idle';

  if (buf.length < 2) return;
  const duration = buf[buf.length - 1].t - buf[0].t;
  if (duration < MIN_DURATION_MS) return;

  const peak    = Math.max(...buf.map(s => s.kg));
  const peakIdx = buf.findIndex(s => s.kg === peak);
  const ttPeak  = buf[peakIdx].t - buf[0].t;

  let rfd = 0;
  for (let i = 1; i <= peakIdx; i++) {
    const dt = (buf[i].t - buf[i - 1].t) / 1000;
    if (dt > 0) rfd = Math.max(rfd, (buf[i].kg - buf[i - 1].kg) / dt);
  }

  const rep = { peak, rfd, ttPeak };
  _contractions.push(rep);
  _renderRepRow(_contractions.length, rep);
  _updateRepsCounter();

  if (_contractions.length >= _repsTarget) setTimeout(_endCurrentSide, 400);
}

// ── Canvas chart ──────────────────────────────────────────────────────────────
function _initCanvas() {
  const canvas = document.getElementById('force-canvas');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = canvas.clientWidth  * dpr;
  canvas.height = canvas.clientHeight * dpr;
}

function _startChartLoop() {
  cancelAnimationFrame(_rafId);
  const tick = () => { _drawChart(); if (_measuring) _rafId = requestAnimationFrame(tick); };
  _rafId = requestAnimationFrame(tick);
}

function _stopChartLoop() {
  cancelAnimationFrame(_rafId);
  _rafId = null;
  _drawChart();
}

function _drawChart() {
  const canvas = document.getElementById('force-canvas');
  if (!canvas || !canvas.width) return;
  const ctx = canvas.getContext('2d');
  const W   = canvas.width;
  const H   = canvas.height;
  const dpr = window.devicePixelRatio || 1;

  const mt = 8 * dpr, mb = 28 * dpr, ml = 42 * dpr, mr = 8 * dpr;
  const cw = W - ml - mr;
  const ch = H - mt - mb;

  ctx.clearRect(0, 0, W, H);
  if (_chartPoints.length < 2) return;

  const now    = performance.now() - _measureStart;
  const tStart = now - CHART_WINDOW_MS;
  const maxKg  = Math.max(_thresholdKg * 2.5, ..._chartPoints.map(s => s.kg), 20) * 1.1;

  const xOf = t  => ml + ((t  - tStart) / CHART_WINDOW_MS) * cw;
  const yOf = kg => mt + ch * (1 - kg / maxKg);

  // grid
  const gridStep = maxKg > 50 ? 20 : maxKg > 25 ? 10 : maxKg > 10 ? 5 : 2;
  ctx.font      = `${9 * dpr}px "DM Mono", monospace`;
  ctx.textAlign = 'right';
  for (let kg = 0; kg <= maxKg; kg += gridStep) {
    const y = yOf(kg);
    ctx.strokeStyle = 'rgba(35,45,69,0.9)';
    ctx.lineWidth   = dpr;
    ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + cw, y); ctx.stroke();
    ctx.fillStyle = 'rgba(90,110,138,0.85)';
    ctx.fillText(kg, ml - 4 * dpr, y + 3 * dpr);
  }

  // threshold line
  ctx.strokeStyle = 'rgba(251,146,60,0.5)';
  ctx.lineWidth   = 1.5 * dpr;
  ctx.setLineDash([5 * dpr, 4 * dpr]);
  const yThr = yOf(_thresholdKg);
  ctx.beginPath(); ctx.moveTo(ml, yThr); ctx.lineTo(ml + cw, yThr); ctx.stroke();
  ctx.setLineDash([]);

  // active contraction fill
  const visible = _chartPoints.filter(s => s.t >= tStart);
  if (_cState !== 'idle' && _cBuffer.length > 0) {
    const cb = _cBuffer.filter(s => s.t >= tStart);
    if (cb.length > 0) {
      ctx.fillStyle = 'rgba(251,146,60,0.07)';
      ctx.beginPath();
      ctx.moveTo(xOf(cb[0].t), yOf(0));
      cb.forEach(s => ctx.lineTo(xOf(s.t), yOf(s.kg)));
      ctx.lineTo(xOf(cb[cb.length - 1].t), yOf(0));
      ctx.closePath();
      ctx.fill();
    }
  }

  // force line
  if (visible.length < 2) return;
  ctx.strokeStyle = '#e8edf5';
  ctx.lineWidth   = 1.5 * dpr;
  ctx.lineJoin    = 'round';
  ctx.beginPath();
  visible.forEach((s, i) => {
    const x = xOf(s.t), y = yOf(s.kg);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  // x-axis time labels
  ctx.fillStyle = 'rgba(90,110,138,0.7)';
  ctx.textAlign = 'center';
  for (let sec = 0; sec <= CHART_WINDOW_MS / 1000; sec += 2) {
    const t = tStart + sec * 1000;
    if (t < 0) continue;
    const x = xOf(t);
    ctx.fillText(`${sec}s`, x, mt + ch + 18 * dpr);
  }
}

window.addEventListener('resize', () => {
  if (_measuring) _initCanvas();
});

// ── Comparison & asymmetry ────────────────────────────────────────────────────
function _calcAI(left, right) {
  const strong = Math.max(left, right);
  return strong === 0 ? 0 : ((strong - Math.min(left, right)) / strong) * 100;
}

// ── Results builder ───────────────────────────────────────────────────────────
function _bestOf(arr, key) {
  return arr.length ? Math.max(...arr.map(c => c[key])) : null;
}

function _buildResults() {
  if (_laterality === 'comparison') {
    const lPeak = _bestOf(_leftContractions,  'peak');
    const rPeak = _bestOf(_rightContractions, 'peak');
    return {
      testType:       'isometric',
      laterality:     'comparison',
      sides: {
        left:  { peak: lPeak, rfd: _bestOf(_leftContractions,  'rfd'), ttPeak: _leftContractions.find(c => c.peak === lPeak)?.ttPeak  ?? null, reps: _leftContractions.map(c => ({ peak: c.peak, rfd: c.rfd, ttPeak: c.ttPeak })) },
        right: { peak: rPeak, rfd: _bestOf(_rightContractions, 'rfd'), ttPeak: _rightContractions.find(c => c.peak === rPeak)?.ttPeak ?? null, reps: _rightContractions.map(c => ({ peak: c.peak, rfd: c.rfd, ttPeak: c.ttPeak })) },
      },
      asymmetryIndex: (lPeak !== null && rPeak !== null) ? _calcAI(lPeak, rPeak) : null,
      timestamp:      new Date().toISOString(),
    };
  }
  const bestPeak = _bestOf(_contractions, 'peak');
  return {
    testType:   'isometric',
    laterality: _laterality,
    side:       _activeSide,
    peak:       bestPeak,
    rfd:        _bestOf(_contractions, 'rfd'),
    ttPeak:     _contractions.find(c => c.peak === bestPeak)?.ttPeak ?? null,
    reps:       _contractions.map(c => ({ peak: c.peak, rfd: c.rfd, ttPeak: c.ttPeak })),
    timestamp:  new Date().toISOString(),
  };
}

// ── Session protocol ──────────────────────────────────────────────────────────
_sessionCh.onmessage = ({ data }) => {
  if (data.type === 'SESSION_PATIENT') { _patient = data.patient ?? ''; _renderPatientChip(); }
  if (data.type === 'SESSION_CLEAR')   _softReset();
};

function _saveResults(payload) {
  _savedResults = payload;
  writeSession({ force: payload, patient: _patient }).then(() => {
    if (_patient) _sessionCh.postMessage({ type: 'SESSION_PATIENT', patient: _patient });
  });
  _sessionCh.postMessage({ type: 'SESSION_FORCE', force: payload });
}

function _softReset() {
  if (_measuring) _stopMeasurement();
  _contractions = []; _leftContractions = []; _rightContractions = [];
  _chartPoints  = [];
  _savedResults = null;
  _patient      = '';
  writeSession({ force: null, patient: '' });
  _sessionCh.postMessage({ type: 'SESSION_FORCE', force: null });
  _renderPatientChip();
  const inp = document.getElementById('patient-name');
  if (inp) inp.value = '';
  _showScreen(_device?.gatt?.connected ? 'screen-config' : 'screen-connect');
}

function _loadSession() {
  readSession().then(s => {
    if (!s) return;
    _patient      = s.patient ?? '';
    _savedResults = s.force   ?? null;
    _renderPatientChip();
    const inp = document.getElementById('patient-name');
    if (inp && _patient) inp.value = _patient;
  });
}

// ── UI bindings ───────────────────────────────────────────────────────────────
function _bindUI() {
  document.getElementById('btn-connect').addEventListener('click', bleConnect);
  document.getElementById('btn-disconnect').addEventListener('click', bleDisconnect);

  document.querySelectorAll('[data-laterality]').forEach(btn => {
    btn.addEventListener('click', () => {
      _laterality = btn.dataset.laterality;
      document.querySelectorAll('[data-laterality]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  document.getElementById('reps-input').addEventListener('change', e => {
    _repsTarget = Math.max(1, Math.min(10, parseInt(e.target.value) || 3));
    e.target.value = _repsTarget;
  });

  document.getElementById('threshold-input').addEventListener('change', e => {
    _thresholdKg = Math.max(0.5, Math.min(20, parseFloat(e.target.value) || 2.0));
    e.target.value = _thresholdKg.toFixed(1);
  });

  document.getElementById('btn-start-test').addEventListener('click', _startTest);
  document.getElementById('btn-stop-test').addEventListener('click', _endCurrentSide);
  document.getElementById('btn-reset').addEventListener('click', _softReset);
  document.getElementById('btn-new-test').addEventListener('click', () => _showScreen('screen-config'));

  document.getElementById('btn-session').addEventListener('click', () => {
    document.getElementById('dialog-session').showModal();
  });
  document.getElementById('btn-session-close').addEventListener('click', () => {
    document.getElementById('dialog-session').close();
  });

  document.querySelector('.logo-main')?.addEventListener('click', () => {
    if (document.body.classList.contains('in-hub'))
      window.parent.postMessage({ type: 'PHYSIQ_GO_HOME' }, '*');
  });

  document.getElementById('patient-name')?.addEventListener('input', e => {
    _patient = e.target.value.trim();
    writeSession({ patient: _patient }).then(() =>
      _sessionCh.postMessage({ type: 'SESSION_PATIENT', patient: _patient })
    );
    _renderPatientChip();
  });
}

// ── Test flow ─────────────────────────────────────────────────────────────────
function _startTest() {
  _leftContractions  = [];
  _rightContractions = [];
  _contractions      = [];

  if (_laterality === 'comparison') {
    _activeSide = 'left';
  } else {
    _activeSide = _laterality === 'left' ? 'left' : _laterality === 'right' ? 'right' : null;
  }

  _showScreen('screen-measure');
  _renderSideBanner(_activeSide);
  _updateRepsCounter();
  startMeasurement();
}

async function _endCurrentSide() {
  await _stopMeasurement();

  if (_laterality === 'comparison' && _activeSide === 'left') {
    _leftContractions = [..._contractions];
    _contractions     = [];
    _activeSide       = 'right';
    _renderSideBanner('right');
    _updateRepsCounter();
    startMeasurement();
    return;
  }

  if (_laterality === 'comparison') _rightContractions = [..._contractions];

  const payload = _buildResults();
  _saveResults(payload);
  _showScreen('screen-results');
  _renderFinalResults(payload);
}

// ── Screen manager ────────────────────────────────────────────────────────────
function _showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => { s.hidden = s.id !== id; });
}

// ── Render helpers ────────────────────────────────────────────────────────────
function _setBLEStatus(state) {
  const badge = document.getElementById('ble-badge');
  if (!badge) return;
  badge.dataset.state = state;
  badge.querySelector('.ble-label').textContent = state === 'connected' ? 'Conectado' : 'Desconectado';
}

function _renderPatientChip() {
  const chip = document.getElementById('session-chip');
  if (!chip) return;
  chip.textContent = _patient || '';
  chip.hidden = !_patient;
}

function _renderLiveValue(kg) {
  const el = document.getElementById('live-force');
  if (el) el.textContent = kg.toFixed(1);
}

function _renderLiveReset() {
  const el = document.getElementById('live-force');
  if (el) el.textContent = '0.0';
  document.getElementById('reps-list')?.replaceChildren();
}

function _renderRepRow(n, rep) {
  const list = document.getElementById('reps-list');
  if (!list) return;
  const li = document.createElement('li');
  li.className = 'rep-item';
  li.innerHTML =
    `<span class="rep-n">${n}</span>` +
    `<span class="rep-peak">${rep.peak.toFixed(1)} kg</span>` +
    `<span class="rep-rfd">${rep.rfd.toFixed(0)} kg/s</span>` +
    `<span class="rep-tt">${rep.ttPeak.toFixed(0)} ms</span>`;
  list.appendChild(li);
}

function _updateRepsCounter() {
  const el = document.getElementById('reps-counter');
  if (el) el.textContent = `${_contractions.length} / ${_repsTarget}`;
}

function _renderSideBanner(side) {
  const el = document.getElementById('side-banner');
  if (!el) return;
  const labels = { left: 'Lado izquierdo →', right: 'Lado derecho →' };
  el.textContent = labels[side] || '';
  el.hidden = !side;
}

function _renderFinalResults(payload) {
  const content = document.getElementById('results-content');
  if (!content) return;
  content.innerHTML = '';

  if (payload.laterality === 'comparison') {
    _renderComparisonTable(payload, content);
  } else {
    _renderRepsTable(payload.reps ?? [], content);
  }

  const aiSection = document.getElementById('ai-section');
  if (payload.asymmetryIndex !== null && payload.asymmetryIndex !== undefined) {
    const ai    = payload.asymmetryIndex;
    const level = ai < 10 ? 'green' : ai < 20 ? 'yellow' : 'red';
    document.getElementById('ai-value').textContent = ai.toFixed(1) + ' %';
    document.getElementById('ai-badge').dataset.level = level;
    aiSection.hidden = false;
  } else {
    aiSection.hidden = true;
  }
}

function _renderComparisonTable(payload, container) {
  const { left, right } = payload.sides;
  const fmt = (v, unit, dec = 1) => v !== null && v !== undefined ? `${v.toFixed(dec)} ${unit}` : '—';

  const table = document.createElement('table');
  table.className = 'results-table';
  table.innerHTML = `
    <thead><tr><th></th><th>Izquierdo</th><th>Derecho</th></tr></thead>
    <tbody>
      <tr><td class="row-label">Pico</td><td>${fmt(left.peak,'kg')}</td><td>${fmt(right.peak,'kg')}</td></tr>
      <tr><td class="row-label">RFD</td><td>${fmt(left.rfd,'kg/s',0)}</td><td>${fmt(right.rfd,'kg/s',0)}</td></tr>
      <tr><td class="row-label">T. al pico</td><td>${fmt(left.ttPeak,'ms',0)}</td><td>${fmt(right.ttPeak,'ms',0)}</td></tr>
    </tbody>`;
  container.appendChild(table);

  const maxReps = Math.max(left.reps?.length ?? 0, right.reps?.length ?? 0);
  if (maxReps > 0) {
    const detail = document.createElement('table');
    detail.className = 'results-table reps-detail';
    detail.innerHTML = `<thead><tr><th>Rep</th><th>Izq (kg)</th><th>Der (kg)</th></tr></thead>`;
    const tbody = document.createElement('tbody');
    for (let i = 0; i < maxReps; i++) {
      const l = left.reps?.[i];
      const r = right.reps?.[i];
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${i + 1}</td><td>${l ? l.peak.toFixed(1) : '—'}</td><td>${r ? r.peak.toFixed(1) : '—'}</td>`;
      tbody.appendChild(tr);
    }
    detail.appendChild(tbody);
    container.appendChild(detail);
  }
}

function _renderRepsTable(reps, container) {
  if (!reps.length) return;
  const table   = document.createElement('table');
  table.className = 'results-table';
  const header  = `<thead><tr><th>Rep</th><th>Pico (kg)</th><th>RFD (kg/s)</th><th>T. pico (ms)</th></tr></thead>`;
  const tbody   = document.createElement('tbody');
  reps.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${i + 1}</td><td>${r.peak.toFixed(1)}</td><td>${r.rfd.toFixed(0)}</td><td>${r.ttPeak.toFixed(0)}</td>`;
    tbody.appendChild(tr);
  });
  const best = {
    peak:   Math.max(...reps.map(r => r.peak)),
    rfd:    Math.max(...reps.map(r => r.rfd)),
    ttPeak: Math.min(...reps.map(r => r.ttPeak)),
  };
  const bestTr = document.createElement('tr');
  bestTr.className = 'best-row';
  bestTr.innerHTML = `<td>Mejor</td><td><strong>${best.peak.toFixed(1)}</strong></td><td><strong>${best.rfd.toFixed(0)}</strong></td><td><strong>${best.ttPeak.toFixed(0)}</strong></td>`;
  tbody.appendChild(bestTr);
  table.innerHTML = header;
  table.appendChild(tbody);
  container.appendChild(table);
}

// ── Hub integration ───────────────────────────────────────────────────────────
function _detectHub() {
  try { if (window.self !== window.top) document.body.classList.add('in-hub'); }
  catch (_) { document.body.classList.add('in-hub'); }
}

// ── SW ────────────────────────────────────────────────────────────────────────
function _registerSW() {
  if ('serviceWorker' in navigator)
    navigator.serviceWorker.register('./sw.js', { scope: './' });
}
