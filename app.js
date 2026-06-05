'use strict';

// ── BLE constants ────────────────────────────────────────────────────────────
const PROGRESSOR_SERVICE = '7e4e1701-1ea6-40c9-9dcc-13d34ffead57';
const DATA_CHAR          = '7e4e1702-1ea6-40c9-9dcc-13d34ffead57';
const CTRL_CHAR          = '7e4e1703-1ea6-40c9-9dcc-13d34ffead57';

const CMD = {
  TARE:             100,
  START_WEIGHT:     101,
  STOP_WEIGHT:      102,
  START_RFD:        103,
  START_RFD_SERIES: 104,
  GET_VERSION:      107,
  GET_ERROR:        108,
  SLEEP:            110,
  GET_BATTERY:      111,
};

const RES = {
  CMD_RESPONSE:    0,
  WEIGHT_MEAS:     1,
  RFD_PEAK:        2,
  RFD_PEAK_SERIES: 3,
  LOW_PWR_WARNING: 4,
};

// ── BLE state ────────────────────────────────────────────────────────────────
let _device    = null;
let _server    = null;
let _dataChar  = null;
let _ctrlChar  = null;
let _measuring = false;

// ── Measurement buffer ───────────────────────────────────────────────────────
let _samples      = [];   // { kg, us } raw stream
let _contractions = [];   // completed contractions for current side

// ── Session state ────────────────────────────────────────────────────────────
const _sessionCh = new BroadcastChannel('physiq-session');

let _patient = '';
let _results = null;   // forceResults object persisted to IDB

// ── App state ────────────────────────────────────────────────────────────────
// laterality: 'single' | 'left' | 'right' | 'comparison'
// phase (comparison): 'idle' | 'measuring-a' | 'measuring-b' | 'done'
let _laterality  = 'single';
let _activeSide  = null;   // 'left' | 'right' | null
let _repsTarget  = 3;

// ── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  _initSessionChip();
  _loadSession();
  _bindUI();
  _registerSW();
  _checkBLESupport();
});

// ── BLE support check ────────────────────────────────────────────────────────
function _checkBLESupport() {
  if (!navigator.bluetooth) {
    _showScreen('screen-no-ble');
  } else {
    _showScreen('screen-connect');
  }
}

// ── BLE connect / disconnect ─────────────────────────────────────────────────
async function bleConnect() {
  try {
    _device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'Progressor' }],
      optionalServices: [PROGRESSOR_SERVICE],
    });
    _device.addEventListener('gattserverdisconnected', _onDisconnect);

    _server    = await _device.gatt.connect();
    const svc  = await _server.getPrimaryService(PROGRESSOR_SERVICE);
    _dataChar  = await svc.getCharacteristic(DATA_CHAR);
    _ctrlChar  = await svc.getCharacteristic(CTRL_CHAR);

    await _dataChar.startNotifications();
    _dataChar.addEventListener('characteristicvaluechanged', _onData);

    await _writeCmd(CMD.GET_BATTERY);
    await _writeCmd(CMD.GET_VERSION);

    _setBLEStatus('connected');
    _showScreen('screen-config');
  } catch (err) {
    if (err.name !== 'NotFoundError') console.warn('BLE connect error:', err);
    _setBLEStatus('disconnected');
  }
}

async function bleDisconnect() {
  if (_measuring) await _stopMeasurement();
  if (_device?.gatt?.connected) _device.gatt.disconnect();
}

function _onDisconnect() {
  _device = null; _server = null; _dataChar = null; _ctrlChar = null;
  _measuring = false;
  _setBLEStatus('disconnected');
  _showScreen('screen-connect');
}

async function _writeCmd(cmd) {
  if (!_ctrlChar) return;
  await _ctrlChar.writeValue(new Uint8Array([cmd]));
}

// ── BLE data handler ─────────────────────────────────────────────────────────
function _onData(e) {
  const data = new DataView(e.target.value.buffer);
  const type = data.getUint8(0);

  if (type === RES.WEIGHT_MEAS) {
    const count = data.getUint8(1);
    for (let i = 0; i < count; i++) {
      const offset = 2 + i * 8;
      const kg = data.getFloat32(offset, true);
      const us = data.getUint32(offset + 4, true);
      _samples.push({ kg, us });
      _onSample(kg, us);
    }
  } else if (type === RES.CMD_RESPONSE) {
    _onCmdResponse(data);
  } else if (type === RES.LOW_PWR_WARNING) {
    _showBatteryWarning();
  }
}

function _onCmdResponse(data) {
  // Battery voltage: 4-byte LE uint32 in mV at data[2]
  // FW version: UTF-8 string at data[2:]
  // Both handled generically; extend as needed
}

// ── Measurement control ──────────────────────────────────────────────────────
async function startMeasurement() {
  _samples = [];
  _measuring = true;
  _renderLiveReset();
  await _writeCmd(CMD.TARE);
  await _writeCmd(CMD.START_WEIGHT);
}

async function _stopMeasurement() {
  _measuring = false;
  await _writeCmd(CMD.STOP_WEIGHT);
  _processContraction();
}

// ── Signal processing ────────────────────────────────────────────────────────
const CONTRACTION_THRESHOLD_KG = 2.0;   // minimum force to count as contraction
const CONTRACTION_MIN_MS       = 200;   // minimum duration ms

function _onSample(kg, us) {
  _renderLiveSample(kg);
}

function _processContraction() {
  if (_samples.length < 2) return;

  const t0us = _samples[0].us;
  const data = _samples.map(s => ({ kg: Math.max(0, s.kg), ms: (s.us - t0us) / 1000 }));

  const peak     = Math.max(...data.map(s => s.kg));
  const peakIdx  = data.findIndex(s => s.kg === peak);
  const ttPeak   = data[peakIdx]?.ms ?? 0;

  // RFD: steepest slope in 200 ms window before peak
  let rfd = 0;
  for (let i = 1; i <= peakIdx; i++) {
    const dt = (data[i].ms - data[i - 1].ms) / 1000;
    if (dt <= 0) continue;
    const slope = (data[i].kg - data[i - 1].kg) / dt;
    if (slope > rfd) rfd = slope;
  }

  if (peak < CONTRACTION_THRESHOLD_KG) return;

  _contractions.push({ peak, rfd, ttPeak, samples: data });
  _renderContractionResult(_contractions.length - 1);
}

// ── Comparison & asymmetry ───────────────────────────────────────────────────
function _calcAsymmetry(left, right) {
  const strong = Math.max(left, right);
  const weak   = Math.min(left, right);
  if (strong === 0) return 0;
  return ((strong - weak) / strong) * 100;
}

function _buildResults() {
  const best = arr => arr.length ? Math.max(...arr.map(c => c.peak)) : null;
  const bestRfd = arr => arr.length ? Math.max(...arr.map(c => c.rfd)) : null;

  if (_laterality === 'comparison') {
    const lContractions = _results?._leftContractions ?? [];
    const rContractions = _results?._rightContractions ?? [];
    const lPeak = best(lContractions);
    const rPeak = best(rContractions);
    return {
      testType:        'isometric',
      laterality:      'comparison',
      sides: {
        left:  { peak: lPeak, rfd: bestRfd(lContractions), ttPeak: lContractions.find(c => c.peak === lPeak)?.ttPeak ?? null },
        right: { peak: rPeak, rfd: bestRfd(rContractions), ttPeak: rContractions.find(c => c.peak === rPeak)?.ttPeak ?? null },
      },
      asymmetryIndex:  (lPeak !== null && rPeak !== null) ? _calcAsymmetry(lPeak, rPeak) : null,
      timestamp:       new Date().toISOString(),
    };
  }

  const peakVal = best(_contractions);
  return {
    testType:   'isometric',
    laterality: _laterality,
    side:       _activeSide,
    peak:       peakVal,
    rfd:        bestRfd(_contractions),
    ttPeak:     _contractions.find(c => c.peak === peakVal)?.ttPeak ?? null,
    reps:       _contractions.map(c => ({ peak: c.peak, rfd: c.rfd, ttPeak: c.ttPeak })),
    timestamp:  new Date().toISOString(),
  };
}

// ── Session protocol ─────────────────────────────────────────────────────────
_sessionCh.onmessage = e => {
  const { type, patient } = e.data ?? {};
  if (type === 'SESSION_PATIENT') { _patient = patient ?? ''; _renderPatientChip(); }
  if (type === 'SESSION_CLEAR')   { _softReset(); }
};

function _emitForce(payload) {
  _sessionCh.postMessage({ type: 'SESSION_FORCE', force: payload });
}

function _saveResults(payload) {
  _results = payload;
  writeSession({ force: payload, patient: _patient }).then(() => {
    if (_patient) _sessionCh.postMessage({ type: 'SESSION_PATIENT', patient: _patient });
  });
  _emitForce(payload);
}

function _softReset() {
  _contractions = [];
  _samples = [];
  _results = null;
  _patient = '';
  writeSession({ force: null, patient: '' });
  _emitForce(null);
  _renderPatientChip();
  _showScreen(_device?.gatt?.connected ? 'screen-config' : 'screen-connect');
}

// ── Session load on boot ─────────────────────────────────────────────────────
function _loadSession() {
  readSession().then(s => {
    if (!s) return;
    _patient = s.patient ?? '';
    _results = s.force ?? null;
    _renderPatientChip();
    if (_results) _renderSavedResults();
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

  document.getElementById('btn-start-test').addEventListener('click', _startTest);
  document.getElementById('btn-stop-test').addEventListener('click', _endCurrentSide);
  document.getElementById('btn-reset').addEventListener('click', _softReset);

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
    writeSession({ patient: _patient }).then(() => {
      _sessionCh.postMessage({ type: 'SESSION_PATIENT', patient: _patient });
    });
  });
}

// ── Test flow ────────────────────────────────────────────────────────────────
function _startTest() {
  _contractions = [];
  _samples = [];

  if (_laterality === 'comparison') {
    _activeSide = 'left';
    _results = { _leftContractions: [], _rightContractions: [] };
    _showScreen('screen-measure');
    _renderSideBanner('left');
  } else {
    _activeSide = _laterality === 'left' ? 'left' : _laterality === 'right' ? 'right' : null;
    _showScreen('screen-measure');
    _renderSideBanner(_activeSide);
  }

  startMeasurement();
}

async function _endCurrentSide() {
  await _stopMeasurement();

  if (_laterality === 'comparison') {
    if (_activeSide === 'left') {
      _results._leftContractions = [..._contractions];
      _contractions = [];
      _samples = [];
      _activeSide = 'right';
      _renderSideBanner('right');
      startMeasurement();
      return;
    } else {
      _results._rightContractions = [..._contractions];
    }
  }

  const payload = _buildResults();
  _saveResults(payload);
  _showScreen('screen-results');
  _renderFinalResults(payload);
}

// ── Screen manager ───────────────────────────────────────────────────────────
function _showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.hidden = s.id !== id);
}

// ── Render helpers (stubs — filled in index.html inline or here) ─────────────
function _setBLEStatus(state) {
  const badge = document.getElementById('ble-badge');
  if (!badge) return;
  badge.dataset.state = state;
  badge.querySelector('.ble-label').textContent =
    state === 'connected' ? 'Conectado' : 'Desconectado';
}

function _renderPatientChip() {
  const chip = document.getElementById('session-chip');
  if (!chip) return;
  chip.textContent = _patient || '';
  chip.hidden = !_patient;
}

function _renderLiveSample(kg) {
  const el = document.getElementById('live-force');
  if (el) el.textContent = kg.toFixed(1);
}

function _renderLiveReset() {
  const el = document.getElementById('live-force');
  if (el) el.textContent = '0.0';
  document.getElementById('reps-list')?.replaceChildren();
}

function _renderContractionResult(idx) {
  const c = _contractions[idx];
  const list = document.getElementById('reps-list');
  if (!list) return;
  const li = document.createElement('li');
  li.className = 'rep-item';
  li.innerHTML =
    `<span class="rep-n">${idx + 1}</span>` +
    `<span class="rep-peak">${c.peak.toFixed(1)} kg</span>` +
    `<span class="rep-rfd">${c.rfd.toFixed(0)} kg/s</span>` +
    `<span class="rep-tt">${c.ttPeak.toFixed(0)} ms</span>`;
  list.appendChild(li);
}

function _renderSideBanner(side) {
  const el = document.getElementById('side-banner');
  if (!el) return;
  el.textContent = side === 'left' ? 'Lado izquierdo' : side === 'right' ? 'Lado derecho' : '';
  el.hidden = !side;
}

function _renderFinalResults(payload) {
  const el = document.getElementById('results-content');
  if (!el) return;
  el.textContent = JSON.stringify(payload, null, 2);
}

function _renderSavedResults() {
  // Show results screen if session already has force data
  if (_results && !_results._leftContractions) {
    _showScreen('screen-results');
    _renderFinalResults(_results);
  }
}

function _showBatteryWarning() {
  const el = document.getElementById('battery-warning');
  if (el) el.hidden = false;
}

function _initSessionChip() {
  const chip = document.getElementById('session-chip');
  if (chip) chip.hidden = true;
}

// ── Hub integration ───────────────────────────────────────────────────────────
(function detectHub() {
  try {
    if (window.self !== window.top) document.body.classList.add('in-hub');
  } catch (_) {
    document.body.classList.add('in-hub');
  }
}());

// ── SW ────────────────────────────────────────────────────────────────────────
function _registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { scope: './' });
  }
}
