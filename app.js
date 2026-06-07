'use strict';

// ── BLE constants ─────────────────────────────────────────────────────────────
const PROGRESSOR_SERVICE = '7e4e1701-1ea6-40c9-9dcc-13d34ffead57';
const DATA_CHAR          = '7e4e1702-1ea6-40c9-9dcc-13d34ffead57';
const CTRL_CHAR          = '7e4e1703-1ea6-40c9-9dcc-13d34ffead57';

const CMD = {
  TARE:         100,
  START_WEIGHT: 101,
  STOP_WEIGHT:  102,
  GET_VERSION:  107,
  SLEEP:        110,
  GET_BATTERY:  111,
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
let _device    = null;
let _dataChar  = null;
let _ctrlChar  = null;
let _measuring = false;
let _liveMode  = false;
let _batteryPct = null;
let _lastRawKg    = 0;
let _tareOffset   = 0;
let _peakDisplayKg = 0;
let _leftPeakKg    = 0;
let _rightPeakKg   = 0;

// ── Chart state ───────────────────────────────────────────────────────────────
let _chartPoints      = [];
let _measureStart     = 0;
let _rafId            = null;
let _liveChartPoints  = [];
let _liveMeasureStart = 0;
let _liveRafId        = null;

// ── Live mode state ───────────────────────────────────────────────────────────
let _liveTimerSec        = 0;
let _liveTimerIntervalId = null;
let _liveMaxKg           = 0;
let _liveSumKg           = 0;
let _liveSampleCount     = 0;

// ── Contraction state machine ─────────────────────────────────────────────────
let _cState   = 'idle';
let _cBuffer  = [];
let _debTimer = null;

// ── Measurement buffers ───────────────────────────────────────────────────────
let _contractions      = [];
let _leftContractions  = [];
let _rightContractions = [];

// ── Config ────────────────────────────────────────────────────────────────────
let _thresholdKg  = 2.0;
let _repsTarget   = 3;
let _laterality   = 'single';
let _activeSide   = null;
let _currentTest  = 'peak';
const TEST_LABELS = { peak: 'Fuerza Pico', rfd: 'RFD' };
let _rfdCountdown = 3;

// ── Session ───────────────────────────────────────────────────────────────────
const _sessionCh  = new BroadcastChannel('physiq-session');
let _patient      = '';
let _savedResults = [];
let _sessionLabel = '';
let _sessionDate  = '';
let _inSubScreen  = false;

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  _detectHub();
  _checkBLESupport();
  _bindUI();
  _loadSession();
  _registerSW();
});

window.addEventListener('popstate', async () => {
  if (_measuring) await _stopMeasurement();
  if (_liveMode)  await _stopLive();
  _inSubScreen = false;
  document.querySelectorAll('.screen').forEach(s => { s.hidden = s.id !== 'screen-menu'; });
});

// ── BLE support ───────────────────────────────────────────────────────────────
function _checkBLESupport() {
  _showScreen(navigator.bluetooth ? 'screen-menu' : 'screen-no-ble');
  _setBLEStatus('disconnected');
}

// ── BLE connect / disconnect ──────────────────────────────────────────────────
async function bleConnect() {
  _setBLEStatus('connecting');
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

    await _writeCmd(CMD.GET_VERSION);
    await _writeCmd(CMD.START_WEIGHT);

    _setBLEStatus('connected');
    _updateBLEDialog();
  } catch (err) {
    if (err.name !== 'NotFoundError') console.warn('BLE:', err);
    _setBLEStatus('disconnected');
    _updateBLEDialog();
  }
}

async function bleDisconnect() {
  if (_measuring) await _stopMeasurement();
  if (_liveMode)  await _stopLive();
  await _writeCmd(CMD.SLEEP);
  _device?.gatt?.disconnect();
}

function _onDisconnect() {
  _device = null; _dataChar = null; _ctrlChar = null;
  _measuring     = false;
  _liveMode      = false;
  _lastRawKg     = 0;
  _tareOffset    = 0;
  _peakDisplayKg = 0;
  _leftPeakKg    = 0;
  _rightPeakKg   = 0;
  clearInterval(_liveTimerIntervalId);
  _stopChartLoop();
  _stopLiveChartLoop();
  _setBLEStatus('disconnected');
  _updateBLEDialog();
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
      _lastRawKg = Math.max(0, dv.getFloat32(2 + i * 8, true));
      _onSample(Math.max(0, _lastRawKg - _tareOffset));
    }
  } else if (type === RES.CMD_RESPONSE) {
    if (dv.byteLength >= 3 && dv.getUint8(1) === CMD.GET_BATTERY) {
      _batteryPct = dv.getUint8(2);
      _renderBattery(_batteryPct);
    }
  }
}

// ── Sample dispatcher ─────────────────────────────────────────────────────────
function _onSample(kg) {
  const dialogForce = document.getElementById('ble-live-force');
  if (dialogForce) dialogForce.textContent = kg.toFixed(1);

  if (_liveMode) {
    _onLiveSample(kg);
  } else if (_measuring) {
    _onMeasureSample(kg);
  }
}

// ── Measurement mode ──────────────────────────────────────────────────────────
async function startMeasurement() {
  _contractions = [];
  _chartPoints  = [];
  _cState       = 'idle';
  _cBuffer      = [];
  clearTimeout(_debTimer);
  _measuring    = true;
  _measureStart = performance.now();

  document.querySelector('.app-header').classList.add('measuring');
  _renderLiveReset();
  if (_currentTest !== 'peak') {
    _initCanvas(`${_currentTest}-canvas`);
    _startChartLoop();
  }
  _doSoftTare();
}

async function _stopMeasurement() {
  if (!_measuring) return;
  _measuring = false;
  document.querySelector('.app-header').classList.remove('measuring');
  clearTimeout(_debTimer);
  if (_cState === 'active' || _cState === 'debounce') _finalizeContraction();
  _cState = 'idle';
  _stopChartLoop();
}

function _onMeasureSample(kg) {
  const t = performance.now() - _measureStart;

  _chartPoints.push({ kg, t });
  const cutoff = t - CHART_WINDOW_MS;
  while (_chartPoints.length > 1 && _chartPoints[0].t < cutoff) _chartPoints.shift();

  const el = document.getElementById(`${_currentTest}-live-force`);
  if (el) el.textContent = kg.toFixed(1);

  if (_currentTest === 'peak') { _updateForceBar(kg); return; }

  if (_cState === 'idle') {
    if (kg >= _thresholdKg) { _cState = 'active'; _cBuffer = [{ kg, t }]; }
  } else if (_cState === 'active') {
    _cBuffer.push({ kg, t });
    if (kg < _thresholdKg) { _cState = 'debounce'; _debTimer = setTimeout(_finalizeContraction, DEBOUNCE_MS); }
  } else if (_cState === 'debounce') {
    _cBuffer.push({ kg, t });
    if (kg >= _thresholdKg) { clearTimeout(_debTimer); _cState = 'active'; }
  }
}

// ── Live mode ─────────────────────────────────────────────────────────────────
async function _startLive() {
  _liveChartPoints  = [];
  _liveMeasureStart = performance.now();
  _liveTimerSec     = 0;
  _liveMaxKg        = 0;
  _liveSumKg        = 0;
  _liveSampleCount  = 0;
  _liveMode         = true;
  document.querySelector('.app-header').classList.add('measuring');
  _renderLiveDisplay();
  _startLiveTimer();
  _doSoftTare();
  requestAnimationFrame(() => {
    _initCanvas('force-canvas-live');
    _startLiveChartLoop();
  });
}

async function _stopLive() {
  if (!_liveMode) return;
  _liveMode = false;
  document.querySelector('.app-header').classList.remove('measuring');
  clearInterval(_liveTimerIntervalId);
  _stopLiveChartLoop();
}

function _resetLive() {
  _liveChartPoints  = [];
  _liveMeasureStart = performance.now();
  _liveTimerSec     = 0;
  _liveMaxKg        = 0;
  _liveSumKg        = 0;
  _liveSampleCount  = 0;
  clearInterval(_liveTimerIntervalId);
  _startLiveTimer();
  _initCanvas('force-canvas-live');
  _startLiveChartLoop();
  _renderLiveDisplay();
  _doSoftTare();
}

function _startLiveTimer() {
  clearInterval(_liveTimerIntervalId);
  _liveTimerIntervalId = setInterval(() => {
    _liveTimerSec++;
    const el = document.getElementById('live-timer');
    if (el) el.textContent = _liveTimerSec;
  }, 1000);
}

function _renderLiveDisplay() {
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set('live-actual', '0.0');
  set('live-timer',  '0');
  set('live-max',    '0.0');
  set('live-media',  '0.0');
}

function _buildLiveResults() {
  const avg = _liveSampleCount > 0 ? _liveSumKg / _liveSampleCount : 0;
  const sameType = _savedResults.filter(r => r.testType === 'live').length;
  const label    = sameType > 0 ? `Datos en Vivo · ${sameType + 1}` : 'Datos en Vivo';
  return {
    label,
    testType:  'live',
    laterality: null,
    peak:       _liveMaxKg  > 0 ? _liveMaxKg  : null,
    avg:        avg          > 0 ? avg          : null,
    duration:   _liveTimerSec,
    timestamp:  new Date().toISOString(),
  };
}

function _onLiveSample(kg) {
  const t = performance.now() - _liveMeasureStart;
  _liveChartPoints.push({ kg, t });
  const cutoff = t - CHART_WINDOW_MS;
  while (_liveChartPoints.length > 1 && _liveChartPoints[0].t < cutoff) _liveChartPoints.shift();

  if (kg > _liveMaxKg) _liveMaxKg = kg;
  _liveSumKg += kg;
  _liveSampleCount++;
  const avg = _liveSumKg / _liveSampleCount;

  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set('live-actual', kg.toFixed(1));
  set('live-max',    _liveMaxKg.toFixed(1));
  set('live-media',  avg.toFixed(1));
}

// ── Contraction detection ─────────────────────────────────────────────────────
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
function _initCanvas(id) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = canvas.clientWidth  * dpr;
  canvas.height = canvas.clientHeight * dpr;
}

function _startChartLoop() {
  cancelAnimationFrame(_rafId);
  const id = _currentTest;
  const tick = () => { _drawChart(`${id}-canvas`, _chartPoints, _measureStart); if (_measuring) _rafId = requestAnimationFrame(tick); };
  _rafId = requestAnimationFrame(tick);
}

function _stopChartLoop() {
  cancelAnimationFrame(_rafId);
  _rafId = null;
  _drawChart(`${_currentTest}-canvas`, _chartPoints, _measureStart);
}

const _LIVE_CHART_OPTS = { absoluteLabels: true, labelStep: 1, lineColor: 'var(--accent)', showThreshold: false };

function _startLiveChartLoop() {
  cancelAnimationFrame(_liveRafId);
  const tick = () => { _drawChart('force-canvas-live', _liveChartPoints, _liveMeasureStart, _LIVE_CHART_OPTS); if (_liveMode) _liveRafId = requestAnimationFrame(tick); };
  _liveRafId = requestAnimationFrame(tick);
}

function _stopLiveChartLoop() {
  cancelAnimationFrame(_liveRafId);
  _liveRafId = null;
  _drawChart('force-canvas-live', _liveChartPoints, _liveMeasureStart, _LIVE_CHART_OPTS);
}

function _drawChart(canvasId, points, measureStart, opts = {}) {
  const { absoluteLabels = false, labelStep = 2, lineColor = '#e8edf5', showThreshold = true } = opts;
  const canvas = document.getElementById(canvasId);
  if (!canvas || !canvas.width) return;
  const ctx = canvas.getContext('2d');
  const W   = canvas.width;
  const H   = canvas.height;
  const dpr = window.devicePixelRatio || 1;

  const mt = 8 * dpr, mb = 28 * dpr, ml = 42 * dpr, mr = 8 * dpr;
  const cw = W - ml - mr;
  const ch = H - mt - mb;

  ctx.clearRect(0, 0, W, H);
  if (points.length < 2) return;

  const now    = performance.now() - measureStart;
  const tStart = now - CHART_WINDOW_MS;
  const maxKg  = Math.max(showThreshold ? _thresholdKg * 2.5 : 5, ...points.map(s => s.kg), 20) * 1.1;

  const xOf = t  => ml + ((t  - tStart) / CHART_WINDOW_MS) * cw;
  const yOf = kg => mt + ch * (1 - kg / maxKg);

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

  if (showThreshold) {
    ctx.strokeStyle = 'rgba(251,146,60,0.5)';
    ctx.lineWidth   = 1.5 * dpr;
    ctx.setLineDash([5 * dpr, 4 * dpr]);
    ctx.beginPath(); ctx.moveTo(ml, yOf(_thresholdKg)); ctx.lineTo(ml + cw, yOf(_thresholdKg)); ctx.stroke();
    ctx.setLineDash([]);
  }

  const visible = points.filter(s => s.t >= tStart);
  if (_measuring && _cState !== 'idle' && _cBuffer.length > 0) {
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

  if (visible.length < 2) return;
  ctx.strokeStyle = lineColor;
  ctx.lineWidth   = 1.5 * dpr;
  ctx.lineJoin    = 'round';
  ctx.beginPath();
  visible.forEach((s, i) => {
    const x = xOf(s.t), y = yOf(s.kg);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.fillStyle = 'rgba(90,110,138,0.7)';
  ctx.textAlign = 'center';
  if (absoluteLabels) {
    const s0 = Math.ceil(tStart / 1000);
    const s1 = Math.floor((tStart + CHART_WINDOW_MS) / 1000);
    for (let s = s0; s <= s1; s++) {
      const t = s * 1000;
      if (t < 0) continue;
      ctx.fillText(`${s}`, xOf(t), mt + ch + 18 * dpr);
    }
  } else {
    for (let sec = 0; sec <= CHART_WINDOW_MS / 1000; sec += labelStep) {
      const t = tStart + sec * 1000;
      if (t < 0) continue;
      ctx.fillText(`${sec}s`, xOf(t), mt + ch + 18 * dpr);
    }
  }
}

window.addEventListener('resize', () => {
  if (_measuring && _currentTest !== 'peak') _initCanvas(`${_currentTest}-canvas`);
  if (_liveMode) _initCanvas('force-canvas-live');
});

// ── Countdown ─────────────────────────────────────────────────────────────────
function _runCountdown(seconds) {
  return new Promise(resolve => {
    if (seconds <= 0) { resolve(); return; }
    _showTestSection('rfd', 'countdown');
    const el = document.getElementById('rfd-countdown-num');
    let n = seconds;
    if (el) el.textContent = n;
    const iv = setInterval(() => {
      n--;
      if (n <= 0) { clearInterval(iv); resolve(); return; }
      if (el) el.textContent = n;
    }, 1000);
  });
}

// ── Comparison & asymmetry ────────────────────────────────────────────────────
function _calcAI(left, right) {
  const avg = (left + right) / 2;
  return avg === 0 ? 0 : (Math.abs(left - right) / avg) * 100;
}

// ── Results builder ───────────────────────────────────────────────────────────
function _genLabel() {
  const typeLabel = _currentTest === 'peak' ? 'MVC' : 'RFD';
  const latLabel  = _laterality === 'comparison' ? ' bilateral'
                  : _laterality === 'left'        ? ' (Izq)'
                  : _laterality === 'right'        ? ' (Der)'
                  : '';
  const sameType = _savedResults.filter(r => r.testType === _currentTest && r.laterality === _laterality).length;
  return sameType > 0 ? `${typeLabel}${latLabel} · ${sameType + 1}` : `${typeLabel}${latLabel}`;
}

function _bestOf(arr, key) {
  return arr.length ? Math.max(...arr.map(c => c[key])) : null;
}

function _buildResults() {
  if (_currentTest === 'peak') {
    if (_laterality === 'comparison') {
      const lPeak = _leftPeakKg  > 0 ? _leftPeakKg  : null;
      const rPeak = _rightPeakKg > 0 ? _rightPeakKg : null;
      const lsi   = (lPeak !== null && rPeak !== null)
        ? (Math.min(lPeak, rPeak) / Math.max(lPeak, rPeak)) * 100
        : null;
      return { label: _genLabel(), testType: 'peak', laterality: 'comparison', sides: { left: { peak: lPeak }, right: { peak: rPeak } }, lsi, asymmetryIndex: lsi !== null ? _calcAI(lPeak, rPeak) : null, timestamp: new Date().toISOString() };
    }
    return { label: _genLabel(), testType: 'peak', laterality: _laterality, side: _activeSide, peak: _peakDisplayKg > 0 ? _peakDisplayKg : null, timestamp: new Date().toISOString() };
  }

  if (_laterality === 'comparison') {
    const lPeak = _bestOf(_leftContractions,  'peak');
    const rPeak = _bestOf(_rightContractions, 'peak');
    return {
      label:          _genLabel(),
      testType:       _currentTest,
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
    label:      _genLabel(),
    testType:   _currentTest,
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
  if (data.type === 'SESSION_PATIENT') { _patient = data.patient ?? ''; _renderSessionState(); }
  if (data.type === 'SESSION_CLEAR')   _softReset();
};

function _saveResults(payload) {
  _savedResults = [..._savedResults, payload];
  if (!_sessionDate) _sessionDate = new Date().toLocaleDateString('es-ES');
  _renderSessionState();
  writeSession({ force: _savedResults, patient: _patient, date: _sessionDate }).then(() => {
    if (_patient) _sessionCh.postMessage({ type: 'SESSION_PATIENT', patient: _patient });
  });
  _sessionCh.postMessage({ type: 'SESSION_FORCE', force: _savedResults });
}

function _softReset() {
  if (_measuring) _stopMeasurement();
  if (_liveMode)  _stopLive();
  _contractions = []; _leftContractions = []; _rightContractions = [];
  _chartPoints  = []; _liveChartPoints  = [];
  _liveTimerSec    = 0; _liveMaxKg = 0; _liveSumKg = 0; _liveSampleCount = 0;
  _lastRawKg     = 0;
  _tareOffset    = 0;
  _peakDisplayKg = 0;
  _leftPeakKg    = 0;
  _rightPeakKg   = 0;
  _savedResults = [];
  _patient      = '';
  _sessionDate  = '';
  writeSession({ force: [], patient: '', date: '' });
  _sessionCh.postMessage({ type: 'SESSION_FORCE', force: [] });
  _sessionCh.postMessage({ type: 'SESSION_PATIENT', patient: '' });
  _syncPatientInputs('');
  _renderSessionState();
  _showScreen('screen-menu');
}

function _loadSession() {
  readSession().then(s => {
    if (!s) return;
    _patient      = s.patient ?? '';
    _sessionDate  = s.date    ?? '';
    _savedResults = Array.isArray(s.force) ? s.force : (s.force ? [s.force] : []);
    _syncPatientInputs(_patient);
    _renderSessionState();
  });
}

// ── Confirm banner ────────────────────────────────────────────────────────────
function showConfirmBanner(title, text, actionLabel, onConfirm) {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-banner';
  overlay.innerHTML = `
    <div class="confirm-box">
      <div class="confirm-box-title">${title}</div>
      <div class="confirm-box-text">${text}</div>
      <div class="confirm-box-btns">
        <button class="btn btn-secondary" id="confirmCancel" style="font-size:.85rem;padding:9px 18px;">Cancelar</button>
        <button class="btn btn-primary"   id="confirmAction" style="font-size:.85rem;padding:9px 18px;">${actionLabel}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const dismiss = () => overlay.remove();
  overlay.querySelector('#confirmCancel').onclick = dismiss;
  overlay.querySelector('#confirmAction').onclick = () => { dismiss(); onConfirm(); };
}

function promptClearSession() {
  showConfirmBanner(
    'Sesión en curso',
    `${_sessionLabel}<br>¿Borrar y empezar de nuevo?`,
    'Borrar sesión',
    () => {
      _softReset();
      clearSession().then(() => _sessionCh.postMessage({ type: 'SESSION_CLEAR' }));
    }
  );
}

// ── Translate banner ──────────────────────────────────────────────────────────
let _translateTimer = null;
function _hideTranslateBanner() {
  clearTimeout(_translateTimer);
  const banner = document.getElementById('translate-banner');
  if (banner) banner.classList.remove('visible');
}

// ── UI bindings ───────────────────────────────────────────────────────────────
function _bindUI() {
  // BLE badge → open BLE dialog
  document.getElementById('btn-ble').addEventListener('click', () => {
    _updateBLEDialog();
    document.getElementById('dialog-ble').showModal();
    if (_device?.gatt?.connected) _writeCmd(CMD.GET_BATTERY);
  });

  // BLE dialog: scan
  document.getElementById('btn-scan').addEventListener('click', async () => {
    document.getElementById('dialog-ble').close();
    await bleConnect();
    _updateBLEDialog();
    if (_device?.gatt?.connected) document.getElementById('dialog-ble').showModal();
  });
  // BLE dialog: tare
  document.getElementById('btn-tare').addEventListener('click', () => _doSoftTare());
  // BLE dialog: disconnect
  document.getElementById('btn-disconnect').addEventListener('click', async () => {
    document.getElementById('dialog-ble').close();
    await bleDisconnect();
  });
  // BLE dialog: close
  document.getElementById('btn-ble-close').addEventListener('click', () => {
    document.getElementById('dialog-ble').close();
  });

  // Menu cards
  document.querySelectorAll('.menu-card[data-test]').forEach(card => {
    card.addEventListener('click', () => {
      if (!_device?.gatt?.connected) {
        _updateBLEDialog();
        document.getElementById('dialog-ble').showModal();
        return;
      }
      _openTest(card.dataset.test);
    });
  });

  // Back buttons
  document.querySelectorAll('.btn-back[data-back]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (_measuring) await _stopMeasurement();
      if (_liveMode)  await _stopLive();
      if (_inSubScreen) history.back(); else _showScreen(btn.dataset.back);
    });
  });

  // Mode toggles — peak config
  document.querySelectorAll('#peak-section-config .mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#peak-section-config .mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _laterality = btn.dataset.laterality;
    });
  });
  // Mode toggles — rfd
  document.querySelectorAll('#screen-rfd .mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#screen-rfd .mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _laterality = btn.dataset.laterality;
    });
  });

  // RFD config inputs
  document.getElementById('rfd-reps-input').addEventListener('change', e => {
    _repsTarget = Math.max(1, Math.min(10, parseInt(e.target.value) || 3));
    e.target.value = _repsTarget;
  });
  document.getElementById('rfd-threshold-input').addEventListener('change', e => {
    _thresholdKg = Math.max(0.5, Math.min(20, parseFloat(e.target.value) || 2.0));
    e.target.value = _thresholdKg.toFixed(1);
  });
  document.getElementById('rfd-countdown-input').addEventListener('change', e => {
    _rfdCountdown = Math.max(0, Math.min(10, parseInt(e.target.value) || 0));
    e.target.value = _rfdCountdown;
  });

  // Start buttons
  document.getElementById('btn-start-peak').addEventListener('click', _startTest);
  document.getElementById('btn-start-rfd').addEventListener('click', async () => {
    await _runCountdown(_rfdCountdown);
    _startTest();
  });

  // Stop buttons
  document.getElementById('btn-stop-peak').addEventListener('click', _endCurrentSide);
  document.getElementById('btn-peak-restore').addEventListener('click', () => {
    if (_activeSide === 'left')       { _leftPeakKg  = 0; _peakDisplayKg = 0; }
    else if (_activeSide === 'right') { _rightPeakKg = 0; _peakDisplayKg = 0; }
    else                              { _peakDisplayKg = 0; }
    _drawForceBar(Math.max(0, _lastRawKg - _tareOffset));
  });

  document.querySelectorAll('.peak-side-btn').forEach(btn => {
    btn.addEventListener('click', () => _switchPeakSide(btn.dataset.side));
  });
  document.getElementById('btn-stop-rfd').addEventListener('click', _endCurrentSide);
  document.getElementById('btn-live-borrar').addEventListener('click', async () => {
    if (_liveTimerSec >= 2) {
      const payload = _buildLiveResults();
      _saveResults(payload);
    }
    await _stopLive();
    if (_inSubScreen) history.back(); else _showScreen('screen-menu');
  });
  document.getElementById('btn-live-restaurar').addEventListener('click', _resetLive);

  // Results buttons
  document.getElementById('btn-peak-new-test').addEventListener('click', () => {
    const titleEl = document.getElementById('peak-results-title');
    if (titleEl) titleEl.textContent = 'Resultados del test';
    _showTestSection('peak', 'config');
  });
  document.getElementById('btn-rfd-new-test').addEventListener('click', () => {
    _showTestSection('rfd', 'config');
  });
  document.getElementById('btn-peak-session').addEventListener('click', () => {
    _renderMeasurementsList();
    _showScreen('screen-measurements');
  });
  document.getElementById('btn-rfd-session').addEventListener('click', () => {
    _renderMeasurementsList();
    _showScreen('screen-measurements');
  });
  document.getElementById('btn-new-measurement').addEventListener('click', () => {
    if (_inSubScreen) history.back(); else _showScreen('screen-menu');
  });

  // Resumen global — copy button and chip clicks
  document.getElementById('btn-copy-force').addEventListener('click', _copyForceToClipboard);
  document.getElementById('globalExportChips').addEventListener('click', e => {
    const chip = e.target.closest('.region-chip');
    if (!chip) return;
    _renderMeasurementsList(chip.dataset.type);
    _showScreen('screen-measurements');
  });

  // Reset
  document.getElementById('btn-reset').addEventListener('click', _softReset);

  // Session icon (person) → confirm banner
  document.getElementById('btn-session').addEventListener('click', promptClearSession);

  // Patient name
  document.getElementById('menu-patient-name').addEventListener('input', e => {
    _patient = e.target.value.trim();
    _persistPatient();
  });

  // Global / translate btn
  document.getElementById('btn-global').addEventListener('click', () => {
    const banner = document.getElementById('translate-banner');
    if (!banner) return;
    banner.classList.add('visible');
    clearTimeout(_translateTimer);
    _translateTimer = setTimeout(_hideTranslateBanner, 4000);
  });
  document.getElementById('translate-banner-close').addEventListener('click', _hideTranslateBanner);

  // Hub logo
  document.querySelector('.logo-main')?.addEventListener('click', () => {
    if (document.body.classList.contains('in-hub'))
      window.parent.postMessage({ type: 'PHYSIQ_GO_HOME' }, '*');
  });
}

// ── Patient helpers ───────────────────────────────────────────────────────────
function _persistPatient() {
  if (!_sessionDate) _sessionDate = new Date().toLocaleDateString('es-ES');
  writeSession({ patient: _patient, date: _sessionDate }).then(() =>
    _sessionCh.postMessage({ type: 'SESSION_PATIENT', patient: _patient })
  );
  _renderSessionState();
}

function _syncPatientInputs(value) {
  const menuInput = document.getElementById('menu-patient-name');
  if (menuInput) menuInput.value = value;
}

function _renderSessionState() {
  const active = !!_patient || _savedResults.length > 0;
  const btn = document.getElementById('btn-session');
  if (btn) btn.classList.toggle('active', active);
  const date = _sessionDate || new Date().toLocaleDateString('es-ES');
  _sessionLabel = active
    ? (_patient ? `${_patient} · ${date}` : `Sesión · ${date}`)
    : '';
  _renderGlobalExport();
}

// ── Test routing ──────────────────────────────────────────────────────────────
function _openTest(test) {
  _currentTest = test;
  if (test === 'peak') {
    const active = document.querySelector('#peak-section-config .mode-btn.active');
    _laterality = active?.dataset.laterality ?? 'single';
    _showScreen('screen-peak');
    _showTestSection('peak', 'config');
  } else if (test === 'rfd') {
    const active = document.querySelector('#screen-rfd .mode-btn.active');
    _laterality = active?.dataset.laterality ?? 'single';
    _showScreen('screen-rfd');
    _showTestSection('rfd', 'config');
  } else if (test === 'live') {
    _showScreen('screen-live');
    _startLive();
  }
}

// ── Test flow ─────────────────────────────────────────────────────────────────
function _startTest() {
  _leftContractions  = [];
  _rightContractions = [];
  _contractions      = [];
  _leftPeakKg  = 0;
  _rightPeakKg = 0;

  _activeSide = _laterality === 'comparison' ? 'left'
              : _laterality === 'left'        ? 'left'
              : _laterality === 'right'       ? 'right'
              : null;

  _showTestSection(_currentTest, 'measure');

  if (_currentTest === 'peak') {
    const isComp    = _laterality === 'comparison';
    const toggle    = document.getElementById('peak-measure-toggle');
    const barSingle = document.getElementById('peak-bar-single');
    const barsComp  = document.getElementById('peak-bars-comparison');
    const readout   = document.querySelector('#peak-section-measure .force-meter-readout');
    if (toggle)    toggle.hidden    = !isComp;
    if (barSingle) barSingle.hidden = isComp;
    if (barsComp)  barsComp.hidden  = !isComp;
    if (readout)   readout.hidden   = isComp;
    if (isComp) {
      document.querySelectorAll('.peak-side-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.side === 'left')
      );
    }
  } else {
    _renderSideBanner(_activeSide);
    _updateRepsCounter();
  }

  startMeasurement();
}

async function _endCurrentSide() {
  await _stopMeasurement();

  if (_currentTest === 'peak') {
    const payload = _buildResults();
    _saveResults(payload);
    _showTestSection('peak', 'results');
    _renderFinalResults(payload);
    return;
  }

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
  _showTestSection(_currentTest, 'results');
  _renderFinalResults(payload);
}

// ── Force bar (peak visualization) ───────────────────────────────────────────
function _updateForceBar(kg) {
  if (_activeSide === 'left')       { if (kg > _leftPeakKg)  _leftPeakKg  = kg; _peakDisplayKg = _leftPeakKg; }
  else if (_activeSide === 'right') { if (kg > _rightPeakKg) _rightPeakKg = kg; _peakDisplayKg = _rightPeakKg; }
  else                              { if (kg > _peakDisplayKg) _peakDisplayKg = kg; }
  _drawForceBar(kg);
}

function _drawForceBar(kg) {
  if (_laterality === 'comparison') {
    const maxKg    = Math.max(_leftPeakKg * 1.3, _rightPeakKg * 1.3, kg * 1.5, 5);
    const aId      = _activeSide;
    const iId      = aId === 'left' ? 'right' : 'left';
    const aPeak    = aId === 'left' ? _leftPeakKg  : _rightPeakKg;
    const iPeak    = iId === 'left' ? _leftPeakKg  : _rightPeakKg;
    const aPct     = Math.min((kg   / maxKg) * 100, 100);
    const aPeakPct = Math.min((aPeak / maxKg) * 100, 100);
    const iPeakPct = Math.min((iPeak / maxKg) * 100, 100);

    const aFill  = document.getElementById(`peak-${aId}-fill`);
    const aLine  = document.getElementById(`peak-${aId}-line`);
    const aLabel = document.getElementById(`peak-${aId}-label`);
    if (aFill)  aFill.style.height = aPct + '%';
    if (aLine)  { aLine.hidden = aPeak === 0; aLine.style.bottom = aPeakPct + '%'; }
    if (aLabel) aLabel.textContent = aPeak.toFixed(1) + ' Kg';

    const iFill  = document.getElementById(`peak-${iId}-fill`);
    const iLine  = document.getElementById(`peak-${iId}-line`);
    const iLabel = document.getElementById(`peak-${iId}-label`);
    if (iFill)  iFill.style.height = '0%';
    if (iLine)  { iLine.hidden = iPeak === 0; iLine.style.bottom = iPeakPct + '%'; }
    if (iLabel) iLabel.textContent = iPeak.toFixed(1) + ' Kg';

    const aVal = document.getElementById(`peak-${aId}-col-value`);
    const iVal = document.getElementById(`peak-${iId}-col-value`);
    if (aVal) aVal.textContent = aPeak === 0 ? '—' : aPeak.toFixed(1);
    if (iVal) iVal.textContent = iPeak === 0 ? '—' : iPeak.toFixed(1);
    return;
  }

  const maxKg      = Math.max(_peakDisplayKg * 1.2, 20);
  const currentPct = Math.min((kg / maxKg) * 100, 100);
  const peakPct    = Math.min((_peakDisplayKg / maxKg) * 100, 100);

  const fill = document.getElementById('peak-bar-fill');
  if (fill) fill.style.height = currentPct + '%';

  const peakLine  = document.getElementById('peak-peak-line');
  const peakLabel = document.getElementById('peak-peak-label');
  if (peakLine) {
    peakLine.hidden = _peakDisplayKg === 0;
    peakLine.style.bottom = peakPct + '%';
  }
  if (peakLabel) peakLabel.textContent = _peakDisplayKg.toFixed(1) + ' Kg';
}

function _switchPeakSide(side) {
  _activeSide    = side;
  _peakDisplayKg = side === 'left' ? _leftPeakKg : _rightPeakKg;
  _drawForceBar(Math.max(0, _lastRawKg - _tareOffset));
  document.querySelectorAll('.peak-side-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.side === side)
  );
}


// ── Screen manager ────────────────────────────────────────────────────────────
function _showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => { s.hidden = s.id !== id; });
  if (id === 'screen-menu') {
    _inSubScreen = false;
  } else if (!_inSubScreen) {
    _inSubScreen = true;
    history.pushState({ physiqForce: true }, '');
  }
}

function _showTestSection(test, section) {
  ['config', 'countdown', 'measure', 'results'].forEach(s => {
    const el = document.getElementById(`${test}-section-${s}`);
    if (el) el.hidden = s !== section;
  });
  if (section === 'results') {
    const btn = document.getElementById(`btn-${test}-new-test`);
    if (btn) btn.textContent = `Nuevo ${TEST_LABELS[test] ?? test}`;
  }
}

// ── Render helpers ────────────────────────────────────────────────────────────
function _setBLEStatus(state) {
  const badge = document.getElementById('btn-ble');
  if (!badge) return;
  badge.classList.remove('active', 'pending', 'error');
  if (state === 'connected')    badge.classList.add('active');
  if (state !== 'connected')    badge.classList.add('pending');
}

function _updateBLEDialog() {
  const connected = !!_device?.gatt?.connected;
  document.getElementById('ble-state-disconnected').hidden = connected;
  document.getElementById('ble-state-connected').hidden    = !connected;
  document.getElementById('ble-dialog-title').textContent  = connected ? 'Dispositivo' : 'Conectar dispositivo';
  if (connected && _batteryPct !== null) _renderBattery(_batteryPct);
}

function _doSoftTare() {
  _tareOffset = _lastRawKg;
}

function _renderBattery(pct) {
const active = pct >= 66 ? 3 : pct >= 33 ? 2 : 1;
  const color  = active === 3 ? '#38d9a9' : active === 2 ? '#fcd34d' : '#ff4757';
  const dim    = '#232d45';

  ['battery-seg1', 'battery-seg2', 'battery-seg3'].forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.setAttribute('fill', i < active ? color : dim);
  });

  const svg = document.getElementById('battery-svg');
  if (svg) {
    svg.querySelector('rect:first-child')?.setAttribute('stroke', color);
  }
  if (pctEl) pctEl.style.color = color;
}

function _renderLiveReset() {
  const el = document.getElementById(`${_currentTest}-live-force`);
  if (el) el.textContent = '0.0';
  document.getElementById(`${_currentTest}-reps-list`)?.replaceChildren();
  if (_currentTest === 'peak') {
    _peakDisplayKg = 0;
    const fill = document.getElementById('peak-bar-fill');
    if (fill) fill.style.height = '0%';
    const line = document.getElementById('peak-peak-line');
    if (line) line.hidden = true;
    ['left', 'right'].forEach(s => {
      const f = document.getElementById(`peak-${s}-fill`);
      const l = document.getElementById(`peak-${s}-line`);
      const v = document.getElementById(`peak-${s}-col-value`);
      if (f) f.style.height = '0%';
      if (l) l.hidden = true;
      if (v) v.textContent = '—';
    });
  }
}

function _renderRepRow(n, rep) {
  const list = document.getElementById(`${_currentTest}-reps-list`);
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
  const el = document.getElementById(`${_currentTest}-reps-counter`);
  if (el) el.textContent = `${_contractions.length} / ${_repsTarget}`;
}

function _renderSideBanner(side) {
  const el = document.getElementById(`${_currentTest}-side-banner`);
  if (!el) return;
  const labels = { left: 'Lado izquierdo →', right: 'Lado derecho →' };
  el.textContent = labels[side] || '';
  el.hidden = !side;
}

function _renderFinalResults(payload) {
  if (payload.testType === 'peak') { _renderPeakResults(payload); return; }

  const content = document.getElementById(`${_currentTest}-results-content`);
  if (!content) return;
  content.innerHTML = '';

  if (payload.laterality === 'comparison') {
    _renderComparisonTable(payload, content);
  } else {
    _renderRepsTable(payload.reps ?? [], content);
  }

  const aiSection = document.getElementById(`${_currentTest}-ai-section`);
  if (payload.asymmetryIndex !== null && payload.asymmetryIndex !== undefined) {
    const ai    = payload.asymmetryIndex;
    const level = ai < 10 ? 'green' : ai < 20 ? 'yellow' : 'red';
    document.getElementById(`${_currentTest}-ai-value`).textContent = ai.toFixed(1) + ' %';
    document.getElementById(`${_currentTest}-ai-badge`).dataset.level = level;
    aiSection.hidden = false;
  } else {
    if (aiSection) aiSection.hidden = true;
  }
}

function _renderPeakResults(payload) {
  const aiSection = document.getElementById('peak-ai-section');
  const content   = document.getElementById('peak-results-content');
  const titleEl   = document.getElementById('peak-results-title');
  if (aiSection) aiSection.hidden = true;
  if (!content)  return;
  content.innerHTML = '';

  if (payload.laterality === 'comparison') {
    if (titleEl) titleEl.textContent = 'Análisis de fuerza';
    const lPeak  = payload.sides?.left?.peak;
    const rPeak  = payload.sides?.right?.peak;
    const lsi    = payload.lsi;
    const fmt    = v => (v !== null && v !== undefined) ? v.toFixed(2) : '0.00';
    const lsiNum = lsi ?? 0;
    const r      = 52;
    const circ   = +(2 * Math.PI * r).toFixed(1);
    const offset = +(circ * (1 - lsiNum / 100)).toFixed(1);
    const color  = lsiNum >= 90 ? 'var(--green)' : lsiNum >= 75 ? 'var(--accent3)' : 'var(--danger)';
    const lWeak  = lPeak !== null && rPeak !== null && lPeak < rPeak;
    const rWeak  = lPeak !== null && rPeak !== null && rPeak < lPeak;
    content.innerHTML = `
      <div class="peak-analysis">
        <div class="peak-analysis-row">
          <div class="peak-analysis-side">
            <span class="peak-analysis-label">izquierda</span>
            <span class="peak-analysis-val${lWeak ? ' peak-analysis-val--weaker' : ''}">${fmt(lPeak)} <small>Kg</small></span>
          </div>
          <div class="peak-analysis-divider"></div>
          <div class="peak-analysis-side">
            <span class="peak-analysis-label">derecha</span>
            <span class="peak-analysis-val${rWeak ? ' peak-analysis-val--weaker' : ''}">${fmt(rPeak)} <small>Kg</small></span>
          </div>
        </div>
        <svg class="peak-donut" viewBox="0 0 140 140" width="140" height="140">
          <circle cx="70" cy="70" r="${r}" fill="none" stroke="var(--surface2)" stroke-width="14"/>
          <circle cx="70" cy="70" r="${r}" fill="none" stroke="${color}" stroke-width="14"
            stroke-dasharray="${circ}" stroke-dashoffset="${offset}"
            stroke-linecap="round" transform="rotate(-90 70 70)"/>
          <text x="70" y="70" text-anchor="middle" dy=".35em" class="peak-donut-text">${lsiNum.toFixed(1)}%</text>
        </svg>
        <p class="peak-analysis-subtitle">% LSI Fuerza Máxima</p>
      </div>`;
  } else {
    if (titleEl) titleEl.textContent = 'Resultados del test';
    const peak = payload.peak;
    const fmt  = v => (v !== null && v !== undefined) ? v.toFixed(2) : '—';
    content.innerHTML = `
      <div class="peak-single-result">
        <span class="peak-single-val">${fmt(peak)}</span>
        <span class="peak-single-unit">Kg</span>
      </div>`;
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
  const table = document.createElement('table');
  table.className = 'results-table';
  const tbody = document.createElement('tbody');
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
  table.innerHTML = `<thead><tr><th>Rep</th><th>Pico (kg)</th><th>RFD (kg/s)</th><th>T. pico (ms)</th></tr></thead>`;
  table.appendChild(tbody);
  container.appendChild(table);
}

// ── Global export (Resumen global) ───────────────────────────────────────────
function _renderGlobalExport() {
  const card  = document.getElementById('globalExportCard');
  const chips = document.getElementById('globalExportChips');
  if (!card) return;

  const peakCount = _savedResults.filter(r => r.testType === 'peak').length;
  const rfdCount  = _savedResults.filter(r => r.testType === 'rfd').length;
  const liveCount = _savedResults.filter(r => r.testType === 'live').length;

  if (!peakCount && !rfdCount && !liveCount) { card.style.display = 'none'; return; }

  const items = [
    peakCount && { id: 'peak', label: 'Fuerza Pico',    count: peakCount },
    rfdCount  && { id: 'rfd',  label: 'RFD',             count: rfdCount  },
    liveCount && { id: 'live', label: 'Datos en Vivo',   count: liveCount },
  ].filter(Boolean);

  chips.innerHTML = items.map(({ id, label, count }) =>
    `<span class="region-chip" data-type="${id}">${label} <span class="chip-count">${count}</span></span>`
  ).join('');

  card.style.display = 'block';
}

function _copyForceToClipboard() {
  const patient = _patient ? `\nPaciente: ${_patient}` : '';
  const date    = _sessionDate || new Date().toLocaleDateString('es-ES');

  const peakResults = _savedResults.filter(r => r.testType === 'peak');
  const rfdResults  = _savedResults.filter(r => r.testType === 'rfd');
  const liveResults = _savedResults.filter(r => r.testType === 'live');
  const sections    = [];

  if (peakResults.length) {
    const lines = peakResults.map(r => {
      if (r.sides) {
        const l = r.sides.left?.peak?.toFixed(1)  ?? '—';
        const d = r.sides.right?.peak?.toFixed(1) ?? '—';
        let line = `  ${r.label}: Izq ${l} kg | Der ${d} kg`;
        if (r.asymmetryIndex != null) line += ` | AI ${r.asymmetryIndex.toFixed(1)} %`;
        return line;
      }
      let line = `  ${r.label}: ${r.peak?.toFixed(1) ?? '—'} kg`;
      if (r.ttPeak != null) line += ` | TtP ${r.ttPeak} ms`;
      return line;
    });
    sections.push(`Fuerza Pico (MVC):\n${lines.join('\n')}`);
  }

  if (rfdResults.length) {
    const lines = rfdResults.map(r => {
      if (r.sides) {
        const l = r.sides.left?.rfd?.toFixed(0)  ?? '—';
        const d = r.sides.right?.rfd?.toFixed(0) ?? '—';
        let line = `  ${r.label}: Izq ${l} N/s | Der ${d} N/s`;
        if (r.asymmetryIndex != null) line += ` | AI ${r.asymmetryIndex.toFixed(1)} %`;
        return line;
      }
      let line = `  ${r.label}: ${r.rfd?.toFixed(0) ?? '—'} N/s`;
      if (r.peak != null) line += ` | Pico ${r.peak.toFixed(1)} kg`;
      return line;
    });
    sections.push(`RFD:\n${lines.join('\n')}`);
  }

  if (liveResults.length) {
    const lines = liveResults.map(r => {
      const parts = [];
      if (r.peak     != null) parts.push(`Máx ${r.peak.toFixed(1)} kg`);
      if (r.avg      != null) parts.push(`Media ${r.avg.toFixed(1)} kg`);
      if (r.duration != null) parts.push(`${r.duration}s`);
      return `  ${r.label}: ${parts.join(' | ')}`;
    });
    sections.push(`Datos en Vivo:\n${lines.join('\n')}`);
  }

  const text = `MEDICIÓN PhysiQ-Force${patient}\nFecha: ${date}\n\n${sections.join('\n\n')}`;
  navigator.clipboard.writeText(text).then(() => _showCopyFeedback());
}

function _showCopyFeedback() {
  document.getElementById('copyFeedback')?.remove();
  const toast = document.createElement('div');
  toast.id = 'copyFeedback';
  toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--surface);border:1px solid var(--accent);color:var(--accent);font-size:.8rem;font-family:\'Outfit\',sans-serif;padding:10px 20px;border-radius:8px;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,.4);';
  toast.textContent = '✓ Mediciones copiadas al portapapeles';
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ── Measurements list ─────────────────────────────────────────────────────────
function _renderMeasurementsList(type = null) {
  const list    = document.getElementById('measurements-list');
  const titleEl = document.getElementById('measurements-title');
  if (!list) return;

  const titles = { peak: 'Fuerza Pico', rfd: 'RFD', live: 'Datos en Vivo' };
  if (titleEl) titleEl.textContent = type ? (titles[type] ?? 'Mediciones') : 'Mediciones';

  const results = type ? _savedResults.filter(r => r.testType === type) : _savedResults;
  list.innerHTML = '';

  if (!results.length) {
    const empty = document.createElement('p');
    empty.className = 'measurements-empty';
    empty.textContent = 'Sin mediciones guardadas en esta sesión.';
    list.appendChild(empty);
    return;
  }

  results.forEach((m, i) => {
    const card = document.createElement('div');
    card.className = 'mcard';

    const ts      = m.timestamp ? new Date(m.timestamp) : null;
    const timeStr = ts ? ts.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '';

    let valStr = '';
    if (m.testType === 'live') {
      const parts = [];
      if (m.peak     != null) parts.push(`Máx: ${m.peak.toFixed(1)} kg`);
      if (m.avg      != null) parts.push(`Media: ${m.avg.toFixed(1)} kg`);
      if (m.duration != null) parts.push(`${m.duration}s`);
      valStr = parts.join(' · ') || '—';
    } else if (m.laterality === 'comparison') {
      const l = m.sides?.left?.peak;
      const r = m.sides?.right?.peak;
      const parts = [];
      if (l != null) parts.push(`I: ${l.toFixed(1)} kg`);
      if (r != null) parts.push(`D: ${r.toFixed(1)} kg`);
      valStr = parts.join(' · ');
    } else {
      const peak      = m.peak;
      const sideLabel = m.side === 'left' ? 'Izq · ' : m.side === 'right' ? 'Der · ' : '';
      valStr = peak != null ? `${sideLabel}${peak.toFixed(1)} kg` : '—';
    }

    const _l = m.sides?.left?.peak, _r = m.sides?.right?.peak;
    const ai = m.asymmetryIndex ?? (_l != null && _r != null ? (() => { const avg = (_l + _r) / 2; return avg ? Math.abs(_l - _r) / avg * 100 : null; })() : null);
    const aiLevel = ai != null ? (ai < 10 ? 'green' : ai < 20 ? 'yellow' : 'red') : null;

    card.innerHTML =
      `<div class="mcard-header">` +
        `<span class="mcard-label">${m.label ?? `Medición ${i + 1}`}</span>` +
        `<span class="mcard-time">${timeStr}</span>` +
      `</div>` +
      `<div class="mcard-values">${valStr}</div>` +
      (aiLevel ? `<span class="mcard-ai" data-level="${aiLevel}">AI ${ai.toFixed(1)} %</span>` : '');

    list.appendChild(card);
  });
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
