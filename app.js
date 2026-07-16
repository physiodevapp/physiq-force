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
let _bleStatus  = 'disconnected';
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
let _liveThresholdMin    = null;
let _liveThresholdMax    = null;
let _measurementsType    = null;
let _selectedPeakResult  = null;
let _mvcSortBy           = 'date';   // 'date' | 'alpha'
let _mvcSortDir          = 'desc';   // 'desc' | 'asc'
let _sliderMinPct        = 40;
let _sliderMaxPct        = 60;

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
const TEST_LABELS = { peak: 'Fuerza Pico', rfd: 'RFD', live: 'Datos en Vivo' };
let _rfdCountdown = 3;

// ── RFD new measurement state ─────────────────────────────────────────────────
const RFD_RECORD_MS   = 5000;
const RFD_WIN_OPTIONS = [100, 150, 200, 250, 300, 1000];
let _rfdMethod        = 'percent';  // 'percent' | 'interval'
let _rfdWindowMs      = 100;
let _rfdIntervalThr   = 0.5;
let _rfdIfeEnabled    = false;
let _rfdMvcRef        = null;       // selected MVC result for IFE
let _rfdClip          = [];         // {kg, t} for current side
let _rfdLeftClip      = [];
let _rfdRightClip     = [];
let _rfdAutoStop      = null;       // setTimeout id for 5s auto-stop
let _rfdRecTimer      = null;       // setInterval id for countdown display
let _rfdResMethod     = 'percent';  // chart overlay method in results
let _rfdResWindowMs   = 100;
let _rfdResThreshold  = 0.5;
let _rfdResIfeEnabled = false;
let _rfdResMvcRef     = null;
let _rfdLastPayload   = null;       // last saved result (single or comparison)
let _mvcSheetCtx      = 'live';    // 'live' | 'rfd' | 'rfd-res'

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
  _initDualSlider();
  _initRfdPicker('rfd-window-picker', _rfdWindowMs, v => { _rfdWindowMs = v; });
  _loadSession();
  _registerSW();
});

window.addEventListener('popstate', async () => {
  if (_measuring || _liveMode) {
    history.pushState({ physiqForce: true }, '');
    return;
  }
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
  _updateBLEDialog();
  const dlg = document.getElementById('dialog-ble');
  try {
    _device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'Progressor' }],
      optionalServices: [PROGRESSOR_SERVICE],
    });
    _device.addEventListener('gattserverdisconnected', _onDisconnect);

    // El selector nativo cierra el <dialog> — reabrirlo con el spinner
    _updateBLEDialog();
    if (!dlg.open) dlg.showModal();

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
    if (!dlg.open) dlg.showModal();
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
  document.getElementById('measure-backdrop').classList.add('open');
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
  document.getElementById('measure-backdrop').classList.remove('open');
  clearTimeout(_debTimer);
  if (_rfdAutoStop) { clearTimeout(_rfdAutoStop);  _rfdAutoStop = null; }
  if (_rfdRecTimer) { clearInterval(_rfdRecTimer); _rfdRecTimer = null; }
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

  if (_currentTest === 'rfd') {
    _rfdClip.push({ kg, t });
    return;
  }

  // legacy contraction detection (not used by current test types)
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
function _initDualSlider() {
  const track    = document.getElementById('dual-track');
  const thumbMin = document.getElementById('thumb-min');
  const thumbMax = document.getElementById('thumb-max');
  if (!track || !thumbMin || !thumbMax) return;
  let active = null;

  const pctFromX = clientX => {
    const r = track.getBoundingClientRect();
    return Math.max(0, Math.min(100, (clientX - r.left) / r.width * 100));
  };
  const onStart = (thumb, e) => { active = thumb; thumb.classList.add('dragging'); e.preventDefault(); };
  const onMove  = clientX => {
    if (!active) return;
    const p = pctFromX(clientX);
    if (active === thumbMin) _sliderMinPct = Math.min(p, _sliderMaxPct);
    else                     _sliderMaxPct = Math.max(p, _sliderMinPct);
    _updateDualSlider();
  };
  const onEnd = () => { if (active) active.classList.remove('dragging'); active = null; };

  thumbMin.addEventListener('mousedown',  e => onStart(thumbMin, e));
  thumbMax.addEventListener('mousedown',  e => onStart(thumbMax, e));
  document.addEventListener('mousemove',  e => onMove(e.clientX));
  document.addEventListener('mouseup',    onEnd);
  thumbMin.addEventListener('touchstart', e => onStart(thumbMin, e), { passive: false });
  thumbMax.addEventListener('touchstart', e => onStart(thumbMax, e), { passive: false });
  document.addEventListener('touchmove',  e => { if (active) onMove(e.touches[0].clientX); }, { passive: false });
  document.addEventListener('touchend',   onEnd);

  [thumbMin, thumbMax].forEach(thumb => {
    thumb.addEventListener('keydown', e => {
      const step = e.shiftKey ? 5 : 1;
      if (thumb === thumbMin) {
        if (e.key === 'ArrowLeft')  { _sliderMinPct = Math.max(0, _sliderMinPct - step); e.preventDefault(); }
        if (e.key === 'ArrowRight') { _sliderMinPct = Math.min(_sliderMaxPct, _sliderMinPct + step); e.preventDefault(); }
      } else {
        if (e.key === 'ArrowLeft')  { _sliderMaxPct = Math.max(_sliderMinPct, _sliderMaxPct - step); e.preventDefault(); }
        if (e.key === 'ArrowRight') { _sliderMaxPct = Math.min(100, _sliderMaxPct + step); e.preventDefault(); }
      }
      _updateDualSlider();
    });
  });
}

function _updateDualSlider() {
  const fill     = document.getElementById('dual-fill');
  const thumbMin = document.getElementById('thumb-min');
  const thumbMax = document.getElementById('thumb-max');
  if (!fill || !thumbMin || !thumbMax) return;
  const minR = Math.round(_sliderMinPct);
  const maxR = Math.round(_sliderMaxPct);
  thumbMin.style.left  = `${_sliderMinPct}%`;
  thumbMax.style.left  = `${_sliderMaxPct}%`;
  fill.style.left      = `${_sliderMinPct}%`;
  fill.style.width     = `${_sliderMaxPct - _sliderMinPct}%`;
  thumbMin.dataset.pct = `${minR}%`;
  thumbMax.dataset.pct = `${maxR}%`;
  const kg = _selectedPeakResult ? _getRefPeakKg(_selectedPeakResult) : null;
  if (kg) {
    const minKg = (_sliderMinPct / 100 * kg).toFixed(1);
    const maxKg = (_sliderMaxPct / 100 * kg).toFixed(1);
    const minInput = document.getElementById('live-min-input');
    const maxInput = document.getElementById('live-max-input');
    if (minInput) minInput.value = minKg;
    if (maxInput) maxInput.value = maxKg;
    const minKgEl = document.getElementById('slider-min-kg');
    const maxKgEl = document.getElementById('slider-max-kg');
    if (minKgEl) minKgEl.textContent = `${minKg} kg`;
    if (maxKgEl) maxKgEl.textContent = `${maxKg} kg`;
  }
}

function _showLiveSection(name) {
  ['config', 'measure'].forEach(s => {
    const el = document.getElementById(`live-section-${s}`);
    if (el) el.hidden = s !== name;
  });
}

function _getRefPeakKg(r) {
  if (r.laterality === 'comparison') {
    const l = r.sides?.left?.peak, g = r.sides?.right?.peak;
    if (l != null && g != null) return Math.min(l, g);
    return l ?? g ?? null;
  }
  return r.peak ?? null;
}

function _validateLiveZoneInputs() {
  const minEl = document.getElementById('live-min-input');
  const maxEl = document.getElementById('live-max-input');
  const btn   = document.getElementById('btn-start-live');
  const errMsg = document.getElementById('live-threshold-error');
  const minVal = parseFloat(minEl.value);
  const maxVal = parseFloat(maxEl.value);
  const invalid = !isNaN(minVal) && minEl.value !== '' &&
                  !isNaN(maxVal) && maxEl.value !== '' &&
                  minVal >= maxVal;
  minEl.classList.toggle('error', invalid);
  maxEl.classList.toggle('error', invalid);
  btn.disabled = invalid;
  if (errMsg) errMsg.hidden = !invalid;
}

function _populateLivePeakSelector() {
  const row = document.getElementById('live-peak-row');
  if (!row) return;
  row.hidden = !_savedResults.some(r => r.testType === 'peak');
}

function _openMvcSheet() {
  const searchInput = document.getElementById('mvc-search-input');
  if (searchInput) searchInput.value = '';
  _renderMvcSheetItems('');
  document.getElementById('mvc-backdrop').classList.add('open');
  document.getElementById('mvc-sheet').classList.add('open');
}

function _closeMvcSheet() {
  document.getElementById('mvc-backdrop').classList.remove('open');
  document.getElementById('mvc-sheet').classList.remove('open');
}

function _updateMvcSortButtons() {
  const alphaBtn   = document.getElementById('mvc-sort-alpha');
  const alphaLabel = document.getElementById('mvc-sort-alpha-label');
  const alphaArrow = document.getElementById('mvc-sort-alpha-arrow');
  const dateBtn    = document.getElementById('mvc-sort-date');
  const dateLabel  = document.getElementById('mvc-sort-date-label');
  const dateArrow  = document.getElementById('mvc-sort-date-arrow');
  if (!alphaBtn || !dateBtn) return;

  const byAlpha = _mvcSortBy === 'alpha';
  alphaBtn.classList.toggle('active', byAlpha);
  dateBtn.classList.toggle('active', !byAlpha);

  if (alphaLabel) alphaLabel.textContent = (!byAlpha || _mvcSortDir === 'asc') ? 'A-Z' : 'Z-A';
  if (alphaArrow) alphaArrow.style.transform = (byAlpha && _mvcSortDir === 'desc') ? 'rotate(180deg)' : '';

  if (dateLabel) dateLabel.textContent = (byAlpha || _mvcSortDir === 'desc') ? 'Reciente' : 'Antiguo';
  if (dateArrow) dateArrow.style.transform = (!byAlpha && _mvcSortDir === 'asc') ? '' : 'rotate(180deg)';
}

function _renderMvcSheetItems(query = '') {
  const list = document.getElementById('mvc-sheet-list');
  if (!list) return;

  let peaks = _savedResults.filter(r => r.testType === 'peak');
  if (_mvcSortBy === 'alpha') {
    peaks = [...peaks].sort((a, b) => {
      const cmp = (a.label ?? '').localeCompare(b.label ?? '');
      return _mvcSortDir === 'asc' ? cmp : -cmp;
    });
  } else if (_mvcSortDir === 'desc') {
    peaks = [...peaks].reverse();
  }

  const q = query.trim().toLowerCase();
  if (q) peaks = peaks.filter(r => (r.label ?? '').toLowerCase().includes(q));

  if (!peaks.length) {
    list.innerHTML = `<p class="mvc-empty">${q ? `Sin resultados para "${query}"` : 'Sin mediciones MVC en esta sesión'}</p>`;
    return;
  }

  list.innerHTML = peaks.map(r => {
    const kg     = _getRefPeakKg(r);
    const kgStr  = kg != null ? `${kg.toFixed(1)} kg` : '—';
    const ts     = r.timestamp ? new Date(r.timestamp).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '';
    const sel    = r === _selectedPeakResult ? ' selected' : '';
    return `<div class="mvc-item${sel}"><span class="mvc-item-label">${r.label ?? 'MVC'}</span><span class="mvc-item-meta">${kgStr}${ts ? ' · ' + ts : ''}</span></div>`;
  }).join('');

  list.querySelectorAll('.mvc-item').forEach((el, i) => {
    el.addEventListener('click', () => {
      const r   = peaks[i];
      const kg  = _getRefPeakKg(r);
      const kgStr = kg != null ? ` — ${kg.toFixed(1)} kg` : '';
      const name  = (r.label ?? 'MVC') + kgStr;

      if (_mvcSheetCtx === 'rfd') {
        _rfdMvcRef = r;
        const lbl = document.getElementById('rfd-mvc-label');
        if (lbl) lbl.textContent = name;
      } else if (_mvcSheetCtx === 'rfd-res') {
        _rfdResMvcRef = r;
        const lbl = document.getElementById('rfd-res-mvc-label');
        if (lbl) lbl.textContent = name;
        _redrawResultChart();
      } else {
        _selectedPeakResult = r;
        const lbl = document.getElementById('live-peak-trigger-label');
        if (lbl) lbl.textContent = name;
        _sliderMinPct = 40;
        _sliderMaxPct = 60;
        _updateDualSlider();
      }
      _closeMvcSheet();
    });
  });
}

async function _startLive() {
  _liveChartPoints  = [];
  _liveMeasureStart = performance.now();
  _liveTimerSec     = 0;
  _liveMaxKg        = 0;
  _liveSumKg        = 0;
  _liveSampleCount  = 0;
  _liveMode         = true;
  document.querySelector('.app-header').classList.add('measuring');
  document.getElementById('measure-backdrop').classList.add('open');
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
  document.getElementById('measure-backdrop').classList.remove('open');
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
  const tick = () => {
    if (_currentTest === 'rfd') {
      _drawRfdChart('rfd-canvas', _rfdClip, {
        showMethod: _rfdMethod,
        threshold:  _rfdMethod === 'interval' ? _rfdIntervalThr : null,
      });
    } else {
      _drawChart(`${id}-canvas`, _chartPoints, _measureStart);
    }
    if (_measuring) _rafId = requestAnimationFrame(tick);
  };
  _rafId = requestAnimationFrame(tick);
}

function _stopChartLoop() {
  cancelAnimationFrame(_rafId);
  _rafId = null;
  if (_currentTest === 'rfd') {
    _drawRfdChart('rfd-canvas', _rfdClip, {
      showMethod: _rfdMethod,
      threshold:  _rfdMethod === 'interval' ? _rfdIntervalThr : null,
    });
  } else {
    _drawChart(`${_currentTest}-canvas`, _chartPoints, _measureStart);
  }
}

function _liveChartOpts() {
  return { absoluteLabels: true, labelStep: 1, lineColor: '#fb923c', showThreshold: false, thresholdMin: _liveThresholdMin, thresholdMax: _liveThresholdMax };
}

function _startLiveChartLoop() {
  cancelAnimationFrame(_liveRafId);
  const tick = () => { _drawChart('force-canvas-live', _liveChartPoints, _liveMeasureStart, _liveChartOpts()); if (_liveMode) _liveRafId = requestAnimationFrame(tick); };
  _liveRafId = requestAnimationFrame(tick);
}

function _stopLiveChartLoop() {
  cancelAnimationFrame(_liveRafId);
  _liveRafId = null;
  _drawChart('force-canvas-live', _liveChartPoints, _liveMeasureStart, _liveChartOpts());
}

function _drawChart(canvasId, points, measureStart, opts = {}) {
  const { absoluteLabels = false, labelStep = 2, lineColor = '#e8edf5', showThreshold = true, thresholdMin = null, thresholdMax = null } = opts;
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
  const maxKg  = Math.max(showThreshold ? _thresholdKg * 2.5 : 5, ...points.map(s => s.kg), thresholdMax ?? 0, 20) * 1.1;

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

  if (thresholdMin !== null || thresholdMax !== null) {
    const yBandTop    = thresholdMax !== null ? yOf(thresholdMax) : yOf(maxKg / 1.1);
    const yBandBottom = thresholdMin !== null ? yOf(thresholdMin) : yOf(0);
    ctx.fillStyle = 'rgba(251,146,60,0.08)';
    ctx.fillRect(ml, yBandTop, cw, yBandBottom - yBandTop);
    ctx.lineWidth = 1.5 * dpr;
    ctx.setLineDash([5 * dpr, 4 * dpr]);
    ctx.strokeStyle = 'rgba(251,146,60,0.45)';
    if (thresholdMin !== null) {
      ctx.beginPath(); ctx.moveTo(ml, yOf(thresholdMin)); ctx.lineTo(ml + cw, yOf(thresholdMin)); ctx.stroke();
    }
    if (thresholdMax !== null) {
      ctx.beginPath(); ctx.moveTo(ml, yOf(thresholdMax)); ctx.lineTo(ml + cw, yOf(thresholdMax)); ctx.stroke();
    }
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
  let strokeColor = lineColor;
  if ((thresholdMin !== null || thresholdMax !== null) && visible.length > 0) {
    const lastKg = visible[visible.length - 1].kg;
    const aboveMin = thresholdMin === null || lastKg >= thresholdMin;
    const belowMax = thresholdMax === null || lastKg <= thresholdMax;
    strokeColor = (aboveMin && belowMax) ? '#4ade80' : '#f87171';
  }
  ctx.strokeStyle = strokeColor;
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

// ── RFD countdown (two-phase overlay) ────────────────────────────────────────
function _runRfdCountdown() {
  return new Promise(resolve => {
    const overlay  = document.getElementById('rfd-countdown-overlay');
    const phaseEl  = document.getElementById('rfd-cd-phase');
    const numEl    = document.getElementById('rfd-cd-num');
    const cancelEl = document.getElementById('btn-rfd-cancel-cd');

    let cancelled = false;
    let ticks = 0;

    const cancel = () => {
      cancelled = true;
      clearInterval(iv);
      overlay.style.display = 'none';
      _showTestSection('rfd', 'config');
    };
    cancelEl.addEventListener('click', cancel, { once: true });

    const show = (phase, num) => {
      if (phaseEl) phaseEl.textContent = phase;
      if (numEl)   numEl.textContent   = num;
    };

    overlay.style.display = 'flex';
    show('La sesión empieza en', String(_rfdCountdown));

    const iv = setInterval(() => {
      if (cancelled) { clearInterval(iv); return; }
      ticks++;
      const remaining = _rfdCountdown - ticks;
      if (remaining > 0) {
        show('La sesión empieza en', String(remaining));
      } else {
        clearInterval(iv);
        show('Tira ahora', '');
        cancelEl.removeEventListener('click', cancel);
        setTimeout(() => {
          if (!cancelled) { overlay.style.display = 'none'; resolve(); }
        }, 700);
      }
    }, 1000);
  });
}

// ── RFD recording (fixed 5 s window) ─────────────────────────────────────────
function _startRfdRecording() {
  _rfdClip      = [];
  _chartPoints  = [];
  _measuring    = true;
  _measureStart = performance.now();

  document.querySelector('.app-header').classList.add('measuring');
  document.getElementById('measure-backdrop').classList.add('open');
  _initCanvas('rfd-canvas');
  _startChartLoop();
  _doSoftTare();

  let remaining = 5;
  const timerEl = document.getElementById('rfd-rec-timer');
  if (timerEl) timerEl.textContent = `${remaining} s`;

  _rfdRecTimer = setInterval(() => {
    remaining--;
    if (timerEl) timerEl.textContent = remaining > 0 ? `${remaining} s` : '0 s';
  }, 1000);

  _rfdAutoStop = setTimeout(_endRfdRecording, RFD_RECORD_MS);
}

async function _endRfdRecording() {
  clearTimeout(_rfdAutoStop);
  clearInterval(_rfdRecTimer);
  _rfdAutoStop = null;
  _rfdRecTimer = null;

  if (!_measuring) return;
  _measuring = false;
  document.querySelector('.app-header').classList.remove('measuring');
  document.getElementById('measure-backdrop').classList.remove('open');
  _stopChartLoop();

  if (_laterality === 'comparison' && _activeSide === 'left') {
    _rfdLeftClip  = [..._rfdClip];
    _rfdClip      = [];
    _activeSide   = 'right';
    _renderSideBanner('right');
    // brief pause then countdown again for right side
    await new Promise(r => setTimeout(r, 600));
    await _runRfdCountdown();
    _startRfdRecording();
    return;
  }

  if (_laterality === 'comparison') _rfdRightClip = [..._rfdClip];

  const payload = _buildResults();
  _rfdLastPayload = payload;
  _saveResults(payload);
  _showTestSection('rfd', 'results');
  _renderFinalResults(payload);
}

// ── RFD calculations ──────────────────────────────────────────────────────────
function _calcRfd2080(buf) {
  if (buf.length < 2) return { rfd: 0, peak: 0 };
  const peak    = Math.max(...buf.map(s => s.kg));
  if (peak <= 0) return { rfd: 0, peak };
  const peakIdx = buf.findIndex(s => s.kg === peak);
  const f20 = 0.20 * peak;
  const f80 = 0.80 * peak;
  let t20 = null, t80 = null;

  for (let i = 0; i <= peakIdx; i++) {
    if (t20 === null && buf[i].kg >= f20) {
      t20 = i > 0
        ? buf[i-1].t + (f20 - buf[i-1].kg) / (buf[i].kg - buf[i-1].kg) * (buf[i].t - buf[i-1].t)
        : buf[i].t;
    }
    if (t80 === null && buf[i].kg >= f80) {
      t80 = i > 0
        ? buf[i-1].t + (f80 - buf[i-1].kg) / (buf[i].kg - buf[i-1].kg) * (buf[i].t - buf[i-1].t)
        : buf[i].t;
    }
  }
  if (t20 === null || t80 === null || t80 <= t20) return { rfd: 0, peak, t20, t80, f20, f80 };
  return { rfd: (f80 - f20) / ((t80 - t20) / 1000), peak, t20, t80, f20, f80 };
}

function _calcRfdInterval(buf, threshold, windowMs) {
  if (buf.length < 2) return { rfd: 0, t0: null };
  let t0 = null, f0 = threshold;

  for (let i = 0; i < buf.length; i++) {
    if (buf[i].kg >= threshold) {
      t0 = i > 0
        ? buf[i-1].t + (threshold - buf[i-1].kg) / (buf[i].kg - buf[i-1].kg) * (buf[i].t - buf[i-1].t)
        : buf[i].t;
      break;
    }
  }
  if (t0 === null) return { rfd: 0, t0: null };

  const targetT = t0 + windowMs;
  let ft = buf[buf.length - 1].kg;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i].t >= targetT) {
      ft = i > 0
        ? buf[i-1].kg + (targetT - buf[i-1].t) / (buf[i].t - buf[i-1].t) * (buf[i].kg - buf[i-1].kg)
        : buf[i].kg;
      break;
    }
  }
  return { rfd: Math.max(0, (ft - f0) / (windowMs / 1000)), t0, f0, targetT, ft };
}

// ── RFD chart (fixed 5-second window) ────────────────────────────────────────
function _drawRfdChart(canvasId, points, opts = {}) {
  const {
    threshold    = null,   // draw threshold line (interval method)
    peakKg       = null,   // draw 20/80% lines
    t20 = null, t80 = null,
    f20 = null, f80 = null,
    t0  = null, targetT = null, ft = null,
    showMethod   = 'percent',
  } = opts;

  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  if (!canvas.width || !canvas.height) {
    canvas.width  = canvas.clientWidth  * dpr;
    canvas.height = canvas.clientHeight * dpr;
  }
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const mt = 8*dpr, mb = 28*dpr, ml = 42*dpr, mr = 8*dpr;
  const cw = W - ml - mr, ch = H - mt - mb;

  ctx.clearRect(0, 0, W, H);

  const maxKg = Math.max(peakKg ? peakKg * 1.2 : 5, threshold ? threshold * 2.5 : 0, 5, ...points.map(s => s.kg)) * 1.1;
  const xOf = t  => ml + (t / RFD_RECORD_MS) * cw;
  const yOf = kg => mt + ch * (1 - kg / maxKg);

  const gridStep = maxKg > 50 ? 20 : maxKg > 25 ? 10 : maxKg > 10 ? 5 : 2;
  ctx.font      = `${9*dpr}px "DM Mono", monospace`;
  ctx.textAlign = 'right';
  for (let kg = 0; kg <= maxKg; kg += gridStep) {
    const y = yOf(kg);
    ctx.strokeStyle = 'rgba(35,45,69,0.9)';
    ctx.lineWidth   = dpr;
    ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + cw, y); ctx.stroke();
    ctx.fillStyle = 'rgba(90,110,138,0.85)';
    ctx.fillText(kg, ml - 4*dpr, y + 3*dpr);
  }

  // X-axis labels (0s … 5s)
  ctx.fillStyle = 'rgba(90,110,138,0.7)';
  ctx.textAlign = 'center';
  for (let s = 0; s <= 5; s++) {
    ctx.fillText(`${s}`, xOf(s * 1000), mt + ch + 18*dpr);
  }

  // Overlay lines
  if (showMethod === 'interval' && threshold !== null) {
    ctx.strokeStyle = 'rgba(251,146,60,0.55)';
    ctx.lineWidth   = 1.5*dpr;
    ctx.setLineDash([5*dpr, 4*dpr]);
    const yt = yOf(threshold);
    ctx.beginPath(); ctx.moveTo(ml, yt); ctx.lineTo(ml + cw, yt); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(251,146,60,0.7)';
    ctx.textAlign = 'left';
    ctx.fillText('Umbral de inicio', ml + 4*dpr, yt - 4*dpr);

    if (t0 !== null && targetT !== null) {
      ctx.strokeStyle = 'rgba(56,217,169,0.6)';
      ctx.lineWidth   = 1.5*dpr;
      ctx.setLineDash([4*dpr, 3*dpr]);
      const x0 = xOf(t0), x1 = xOf(Math.min(targetT, RFD_RECORD_MS));
      ctx.beginPath(); ctx.moveTo(x0, mt); ctx.lineTo(x0, mt + ch); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x1, mt); ctx.lineTo(x1, mt + ch); ctx.stroke();
      ctx.setLineDash([]);
    }
  } else if (showMethod === 'percent' && f20 !== null && f80 !== null) {
    [[f20, '20% del máximo'], [f80, '80% del máximo']].forEach(([fv, label]) => {
      ctx.strokeStyle = 'rgba(251,146,60,0.55)';
      ctx.lineWidth   = 1.5*dpr;
      ctx.setLineDash([5*dpr, 4*dpr]);
      const y = yOf(fv);
      ctx.beginPath(); ctx.moveTo(ml, y); ctx.lineTo(ml + cw, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(251,146,60,0.7)';
      ctx.textAlign = 'left';
      ctx.fillText(label, ml + 4*dpr, y - 4*dpr);
    });
  }

  // Max annotation
  if (peakKg) {
    ctx.fillStyle = 'rgba(56,217,169,0.85)';
    ctx.textAlign = 'right';
    ctx.fillText(`Max: ${peakKg.toFixed(1)} kg`, ml + cw - 4*dpr, mt + 14*dpr);
  }

  // RFD slope line — spans exactly the interval used for the calculation
  if (showMethod === 'percent' && t20 !== null && t80 !== null && f20 !== null && f80 !== null) {
    ctx.strokeStyle = '#f87171';
    ctx.lineWidth   = 2.5 * dpr;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(xOf(t20), yOf(f20));
    ctx.lineTo(xOf(t80), yOf(f80));
    ctx.stroke();
  } else if (showMethod === 'interval' && t0 !== null && targetT !== null && ft !== null) {
    ctx.strokeStyle = '#f87171';
    ctx.lineWidth   = 2.5 * dpr;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(xOf(t0), yOf(threshold ?? 0));
    ctx.lineTo(xOf(Math.min(targetT, RFD_RECORD_MS)), yOf(ft));
    ctx.stroke();
  }

  // Force curve
  if (points.length < 2) return;
  ctx.strokeStyle = '#fb923c';
  ctx.lineWidth   = 1.5*dpr;
  ctx.lineJoin    = 'round';
  ctx.beginPath();
  points.forEach((s, i) => {
    const x = xOf(s.t), y = yOf(s.kg);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
}

// ── Scroll picker init ────────────────────────────────────────────────────────
function _initRfdPicker(pickerId, initialVal, onChange) {
  const picker = document.getElementById(pickerId);
  if (!picker) return;
  const ITEM_H = 30;
  const idx0 = RFD_WIN_OPTIONS.indexOf(initialVal);
  if (idx0 >= 0) picker.scrollTop = idx0 * ITEM_H;

  const updateActive = () => {
    const idx = Math.round(picker.scrollTop / ITEM_H);
    picker.querySelectorAll('.rfd-picker-item').forEach((el, i) => {
      el.classList.toggle('active', i === idx);
    });
    const val = RFD_WIN_OPTIONS[Math.max(0, Math.min(RFD_WIN_OPTIONS.length - 1, idx))];
    onChange(val);
  };

  picker.addEventListener('scroll', updateActive, { passive: true });
  picker.querySelectorAll('.rfd-picker-item').forEach((el, i) => {
    el.addEventListener('click', () => picker.scrollTo({ top: i * ITEM_H, behavior: 'smooth' }));
  });
  updateActive();
}

// ── Comparison & asymmetry ────────────────────────────────────────────────────
function _calcAI(left, right) {
  const avg = (left + right) / 2;
  return avg === 0 ? 0 : (Math.abs(left - right) / avg) * 100;
}

// ── Results builder ───────────────────────────────────────────────────────────
function _genLabel() {
  const typeLabel  = _currentTest === 'peak' ? 'MVC' : 'RFD';
  const latLabel   = _laterality === 'comparison' ? ' bilateral'
                   : _laterality === 'left'        ? ' (Izq)'
                   : _laterality === 'right'        ? ' (Der)'
                   : '';
  const sameType   = _savedResults.filter(r => r.testType === _currentTest && r.laterality === _laterality).length;
  const autoLabel  = sameType > 0 ? `${typeLabel}${latLabel} · ${sameType + 1}` : `${typeLabel}${latLabel}`;
  const movementId = _currentTest === 'peak' ? 'peak-label-input' : _currentTest === 'rfd' ? 'rfd-label-input' : null;
  const movement   = movementId ? (document.getElementById(movementId)?.value.trim() ?? '') : '';
  return movement ? `${movement} · ${autoLabel}` : autoLabel;
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

  if (_currentTest === 'rfd') {
    const _rfdSide = (clip) => {
      const p2080 = _calcRfd2080(clip);
      const pInt  = _calcRfdInterval(clip, _rfdIntervalThr, _rfdWindowMs);
      const mvcKg = _rfdMvcRef ? _getRefPeakKg(_rfdMvcRef) : null;
      const ife   = (_rfdIfeEnabled && mvcKg && p2080.peak > 0)
        ? (p2080.rfd / mvcKg) * 100 : null;
      return { peak: p2080.peak, rfd2080: p2080.rfd, rfdTime: pInt.rfd, ife };
    };

    if (_laterality === 'comparison') {
      const l = _rfdSide(_rfdLeftClip);
      const r = _rfdSide(_rfdRightClip);
      const ai = (l.peak > 0 && r.peak > 0) ? _calcAI(l.rfd2080, r.rfd2080) : null;
      return {
        label: _genLabel(), testType: 'rfd', laterality: 'comparison',
        rfdWindowMs: _rfdWindowMs, rfdThreshold: _rfdIntervalThr,
        sides: { left: { ...l, clip: _rfdLeftClip }, right: { ...r, clip: _rfdRightClip } },
        asymmetryIndex: ai, timestamp: new Date().toISOString(),
      };
    }
    const s = _rfdSide(_rfdClip);
    return {
      label: _genLabel(), testType: 'rfd', laterality: _laterality, side: _activeSide,
      peak: s.peak, rfd2080: s.rfd2080, rfdTime: s.rfdTime,
      rfdWindowMs: _rfdWindowMs, rfdThreshold: _rfdIntervalThr,
      ife: s.ife, clip: _rfdClip,
      timestamp: new Date().toISOString(),
    };
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
  if (data.type === 'SESSION_CLEAR') { _softReset(); clearSession(); }
  if (data.type === 'SESSION_FORCE' && data._relay) {
    _savedResults = Array.isArray(data.force) ? data.force : [];
    _renderSessionState();
    const measScreen = document.getElementById('screen-measurements');
    if (measScreen && !measScreen.hidden) _renderMeasurementsList(_measurementsType);
  }
  if (data.type === 'SESSION_BLE_STATUS' && data._relay) _setRemoteBLEStatus(data.bleStatus);
};

function _saveResults(payload) {
  _savedResults = [..._savedResults, payload];
  if (!_sessionDate) _sessionDate = new Date().toLocaleDateString('es-ES');
  _renderSessionState();
  _sessionCh.postMessage({ type: 'SESSION_FORCE', force: _savedResults });
  if (!_patient) return;
  writeSession({ force: _savedResults, patient: _patient, date: _sessionDate }).then(() => {
    _sessionCh.postMessage({ type: 'SESSION_PATIENT', patient: _patient });
  });
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
  _sessionCh.postMessage({ type: 'SESSION_FORCE', force: [] });
  _syncPatientInputs('');
  _renderSessionState();
  _showScreen('screen-menu');
}

function _deleteSavedResult(timestamp) {
  _savedResults = _savedResults.filter(r => r.timestamp !== timestamp);
  writeSession({ force: _savedResults });
  _sessionCh.postMessage({ type: 'SESSION_FORCE', force: _savedResults });
  _renderSessionState();
  _renderMeasurementsList(_measurementsType);
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
  const existing = document.querySelector('.confirm-banner');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.className = 'confirm-banner';
  overlay.innerHTML = `
    <div class="confirm-box">
      <div class="confirm-box-title">${title}</div>
      <div class="confirm-box-text">${text}</div>
      <div class="confirm-box-btns">
        <button class="confirm-btn-cancel" id="confirmCancel"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Cancelar</button>
        <button class="confirm-btn-ok"     id="confirmAction"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg> ${actionLabel}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const dismiss = () => overlay.remove();
  overlay.querySelector('#confirmCancel').onclick = dismiss;
  overlay.querySelector('#confirmAction').onclick = () => { dismiss(); onConfirm(); };
}

function promptClearSession() {
  _showSessionState('delete');
  const overlay = document.getElementById('sessionPanelOverlay');
  if (overlay && !overlay.classList.contains('open')) overlay.classList.add('open');
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
  // RFD method toggle (config)
  document.querySelectorAll('#rfd-method-toggle .mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#rfd-method-toggle .mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _rfdMethod = btn.dataset.method;
      const cfg = document.getElementById('rfd-interval-cfg');
      if (cfg) cfg.hidden = _rfdMethod !== 'interval';
    });
  });

  // RFD threshold input (config)
  document.getElementById('rfd-threshold-input')?.addEventListener('change', e => {
    _rfdIntervalThr = Math.max(0.1, Math.min(20, parseFloat(e.target.value) || 0.5));
    e.target.value = _rfdIntervalThr.toFixed(2);
  });

  // RFD IFE checkbox (config)
  document.getElementById('rfd-ife-check')?.addEventListener('change', function () {
    _rfdIfeEnabled = this.checked;
    const cfg = document.getElementById('rfd-ife-cfg');
    if (cfg) cfg.hidden = !_rfdIfeEnabled;
  });

  // RFD MVC selector (config)
  document.getElementById('rfd-mvc-trigger')?.addEventListener('click', () => {
    _mvcSheetCtx = 'rfd';
    _openMvcSheet();
  });

  // IFE info button (config)
  document.getElementById('btn-rfd-ife-info')?.addEventListener('click', e => _showIFEInfo(e));

  // Start buttons
  document.getElementById('btn-start-peak').addEventListener('click', () => {
    if (!_device?.gatt?.connected) { _updateBLEDialog(); document.getElementById('dialog-ble').showModal(); return; }
    _startTest();
  });
  document.getElementById('btn-start-rfd').addEventListener('click', async () => {
    if (!_device?.gatt?.connected) { _updateBLEDialog(); document.getElementById('dialog-ble').showModal(); return; }
    _showTestSection('rfd', 'measure');
    await _runRfdCountdown();
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
  // btn-stop-rfd no longer exists (RFD auto-stops after 5 s)
  document.getElementById('btn-start-live').addEventListener('click', () => {
    if (!_device?.gatt?.connected) {
      _updateBLEDialog();
      document.getElementById('dialog-ble').showModal();
      return;
    }
    const zoneActive = document.getElementById('live-zone-check')?.checked;
    if (zoneActive) {
      const minVal = parseFloat(document.getElementById('live-min-input').value);
      const maxVal = parseFloat(document.getElementById('live-max-input').value);
      _liveThresholdMin = isNaN(minVal) || minVal <= 0 ? null : minVal;
      _liveThresholdMax = isNaN(maxVal) || maxVal <= 0 ? null : maxVal;
    } else {
      _liveThresholdMin = null;
      _liveThresholdMax = null;
    }
    _showLiveSection('measure');
    _startLive();
  });
  document.getElementById('live-peak-trigger').addEventListener('click', _openMvcSheet);
  document.getElementById('mvc-backdrop').addEventListener('click', _closeMvcSheet);
  document.getElementById('mvc-sheet-close').addEventListener('click', _closeMvcSheet);
  document.getElementById('mvc-sort-alpha').addEventListener('click', () => {
    if (_mvcSortBy === 'alpha') {
      _mvcSortDir = _mvcSortDir === 'asc' ? 'desc' : 'asc';
    } else {
      _mvcSortBy = 'alpha';
      _mvcSortDir = 'asc';
    }
    _updateMvcSortButtons();
    _renderMvcSheetItems(document.getElementById('mvc-search-input').value);
  });
  document.getElementById('mvc-sort-date').addEventListener('click', () => {
    if (_mvcSortBy === 'date') {
      _mvcSortDir = _mvcSortDir === 'desc' ? 'asc' : 'desc';
    } else {
      _mvcSortBy = 'date';
      _mvcSortDir = 'desc';
    }
    _updateMvcSortButtons();
    _renderMvcSheetItems(document.getElementById('mvc-search-input').value);
  });
  document.getElementById('mvc-search-input').addEventListener('input', e => _renderMvcSheetItems(e.target.value));
  document.getElementById('live-min-input').addEventListener('change', _validateLiveZoneInputs);
  document.getElementById('live-max-input').addEventListener('change', _validateLiveZoneInputs);
  document.getElementById('live-zone-check').addEventListener('change', function () {
    const body = document.getElementById('live-zone-body');
    body.hidden = !this.checked;
    if (this.checked) {
      _updateDualSlider();
    } else {
      document.getElementById('live-min-input').value = '';
      document.getElementById('live-max-input').value = '';
      document.getElementById('live-min-input').classList.remove('error');
      document.getElementById('live-max-input').classList.remove('error');
      document.getElementById('btn-start-live').disabled = false;
      const errMsg = document.getElementById('live-threshold-error');
      if (errMsg) errMsg.hidden = true;
      _selectedPeakResult = null;
      _sliderMinPct = 40;
      _sliderMaxPct = 60;
      const lbl = document.getElementById('live-peak-trigger-label');
      if (lbl) lbl.textContent = 'Seleccionar…';
    }
  });
  document.getElementById('btn-live-borrar').addEventListener('click', async () => {
    await _stopLive();
    if (_inSubScreen) history.back(); else _showScreen('screen-menu');
  });
  document.getElementById('btn-live-restaurar').addEventListener('click', _resetLive);

  // Results buttons
  document.getElementById('btn-peak-new-test').addEventListener('click', () => {
    if (!_device?.gatt?.connected) { _updateBLEDialog(); document.getElementById('dialog-ble').showModal(); return; }
    const titleEl = document.getElementById('peak-results-title');
    if (titleEl) titleEl.textContent = 'Resultados del test';
    _openTest('peak');
  });
  // RFD results — "Nueva medición" and "Medir" inside panel both restart
  const _rfdStartNew = async () => {
    if (!_device?.gatt?.connected) { _updateBLEDialog(); document.getElementById('dialog-ble').showModal(); return; }
    _showTestSection('rfd', 'measure');
    await _runRfdCountdown();
    _startTest();
  };
  document.getElementById('btn-rfd-new-test')?.addEventListener('click', _rfdStartNew);
  document.getElementById('btn-rfd-medir')?.addEventListener('click',    _rfdStartNew);

  // RFD settings toggle (results panel)
  document.getElementById('rfd-settings-toggle')?.addEventListener('click', function () {
    const panel = document.getElementById('rfd-settings-panel');
    if (!panel) return;
    panel.hidden = !panel.hidden;
    this.classList.toggle('open', !panel.hidden);
  });

  // RFD result method toggle
  document.querySelectorAll('#rfd-res-method-toggle .mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#rfd-res-method-toggle .mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _rfdResMethod = btn.dataset.method;
      const cfg = document.getElementById('rfd-res-interval-cfg');
      if (cfg) cfg.hidden = _rfdResMethod !== 'interval';
      _redrawResultChart();
    });
  });

  // RFD result threshold
  document.getElementById('rfd-res-threshold')?.addEventListener('change', e => {
    _rfdResThreshold = Math.max(0.1, Math.min(20, parseFloat(e.target.value) || 0.5));
    e.target.value = _rfdResThreshold.toFixed(2);
    _redrawResultChart();
  });

  // RFD result IFE checkbox
  document.getElementById('rfd-res-ife-check')?.addEventListener('change', function () {
    _rfdResIfeEnabled = this.checked;
    const mvc = document.getElementById('rfd-res-ife-mvc');
    if (mvc) mvc.hidden = !_rfdResIfeEnabled;
    _redrawResultChart();
  });

  // RFD result MVC selector
  document.getElementById('rfd-res-mvc-trigger')?.addEventListener('click', () => {
    _mvcSheetCtx = 'rfd-res';
    _openMvcSheet();
  });

  // IFE info button (results)
  document.getElementById('btn-rfd-res-ife-info')?.addEventListener('click', e => _showIFEInfo(e));
  document.getElementById('btn-peak-session').addEventListener('click', () => {
    _measurementsType = 'peak';
    _setNewMeasurementBtn('peak');
    _renderMeasurementsList('peak');
    _showScreen('screen-measurements');
  });
  document.getElementById('btn-rfd-session').addEventListener('click', () => {
    _measurementsType = 'rfd';
    _setNewMeasurementBtn('rfd');
    _renderMeasurementsList('rfd');
    _showScreen('screen-measurements');
  });
  document.getElementById('btn-new-measurement').addEventListener('click', () => {
    if (_measurementsType) { _openTestOrConnect(_measurementsType); return; }
    if (_inSubScreen) history.back(); else _showScreen('screen-menu');
  });

  // Resumen global — copy button and chip clicks
  document.getElementById('btn-copy-force').addEventListener('click', _copyForceToClipboard);
  document.getElementById('globalExportChips').addEventListener('click', e => {
    const chip = e.target.closest('.region-chip');
    if (!chip) return;
    _measurementsType = chip.dataset.type ?? null;
    _setNewMeasurementBtn(_measurementsType);
    _renderMeasurementsList(_measurementsType);
    _showScreen('screen-measurements');
  });

  // Reset (measurements only — not full session clear)
  document.getElementById('btn-reset').addEventListener('click', () => {
    showConfirmBanner(
      '↺ Borrar mediciones',
      'Se eliminarán las mediciones de dinamometría. Los datos de otros satélites se conservarán.',
      'Borrar',
      () => {
        _savedResults = [];
        writeSession({ force: [] });
        _sessionCh.postMessage({ type: 'SESSION_FORCE', force: [] });
        _renderSessionState();
        _showScreen('screen-menu');
      }
    );
  });

  // Session icon → panel / info banner
  document.getElementById('btn-session').addEventListener('click', toggleSessionPanel);
  document.getElementById('sessionPanelOverlay').addEventListener('click', closeSessionPanel);
  document.getElementById('sessionPanel').addEventListener('click', e => e.stopPropagation());

  _setupSessionPanelDrag();

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
  const input = document.getElementById('patientName');
  if (input) input.value = value;
}

function _renderSessionState() {
  const active = !!_patient;
  const btn = document.getElementById('btn-session');
  if (btn) btn.classList.toggle('active', active);
  const date = _sessionDate || new Date().toLocaleDateString('es-ES');
  _sessionLabel = active ? `${_patient} · ${date}` : '';
  const panel = document.getElementById('sessionPanel');
  const panelTitle = document.getElementById('sessionPanelTitle');
  if (panel) panel.classList.toggle('has-session', active);
  if (panelTitle) panelTitle.textContent = active ? _sessionLabel : 'Sin sesión activa';
  const resetBtn = document.getElementById('btn-reset');
  if (resetBtn) resetBtn.style.display = _savedResults.length > 0 ? '' : 'none';
  _renderGlobalExport();
}

function _showSessionState(state) {
  const panel = document.getElementById('sessionPanel');
  if (!panel) return;
  const hasSession = !!_patient;
  const label = _sessionLabel || (hasSession
    ? `${_patient} · ${_sessionDate || new Date().toLocaleDateString('es-ES')}` : '');
  panel.classList.toggle('has-session', hasSession);

  if (state === 'edit') {
    panel.innerHTML = `
      <div class="session-panel-handle"></div>
      <div class="session-panel-title" id="sessionPanelTitle">${label || 'Sin sesión activa'}</div>
      <div class="patient-name-field">
        <label class="patient-name-label">Paciente</label>
        <div style="display:flex;align-items:center;gap:8px;">
          <input class="patient-name-input" type="text" id="patientName" style="flex:1;" placeholder="Nombre (opcional)" autocomplete="off">
          <button class="session-panel-clear" id="sessionPanelClear" title="Borrar sesión">
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h9M5 4V2h3v2M3.5 4l.5 7h5l.5-7"/></svg>
          </button>
        </div>
      </div>`;
    const input = panel.querySelector('#patientName');
    input.value = _patient || '';
    input.addEventListener('keydown', e => { if (e.key === 'Enter') closeSessionPanel(); });
    input.addEventListener('input', () => {
      _patient = input.value.trim();
      const titleEl = panel.querySelector('#sessionPanelTitle');
      if (titleEl) titleEl.textContent = _patient
        ? `${_patient} · ${_sessionDate || new Date().toLocaleDateString('es-ES')}`
        : 'Sin sesión activa';
      panel.classList.toggle('has-session', !!_patient);
      _persistPatient();
    });
    panel.querySelector('#sessionPanelClear').onclick = () => _showSessionState('delete');
    setTimeout(() => input.focus(), 60);

  } else if (state === 'delete') {
    panel.innerHTML = `
      <div class="session-panel-handle"></div>
      <div class="session-panel-title">${label || 'Sin sesión activa'}</div>
      <div class="confirm-box-text" style="margin:12px 0 0;">¿Borrar y empezar de nuevo?</div>
      <div class="confirm-box-btns" style="margin-top:1rem;">
        <button class="confirm-btn-cancel" id="confirmCancel">Cancelar</button>
        <button class="confirm-btn-ok" id="confirmAction">Borrar sesión</button>
      </div>`;
    panel.querySelector('#confirmCancel').onclick = () => _showSessionState('edit');
    panel.querySelector('#confirmAction').onclick = () => {
      closeSessionPanel();
      _softReset();
      clearSession().then(() => _sessionCh.postMessage({ type: 'SESSION_CLEAR' }));
    };
  }
}

function closeSessionPanel() {
  const overlay = document.getElementById('sessionPanelOverlay');
  const panel = document.getElementById('sessionPanel');
  overlay?.classList.remove('open');
  if (panel) { panel.style.transition = ''; panel.style.transform = ''; }
}

function toggleSessionPanel() {
  const overlay = document.getElementById('sessionPanelOverlay');
  if (!overlay) return;
  if (overlay.classList.contains('open')) { closeSessionPanel(); return; }
  _showSessionState('edit');
  overlay.classList.add('open');
}

function _setupSessionPanelDrag() {
  const panel = document.getElementById('sessionPanel');
  if (!panel) return;
  const EASE = 'transform 0.3s cubic-bezier(0.32,0.72,0,1)';
  let startY = 0, startTime = 0, dragging = false, delta = 0, snapTimer = null;
  let vvHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      const newHeight = window.visualViewport.height;
      if (dragging) startY += newHeight - vvHeight;
      vvHeight = newHeight;
    });
  }
  panel.addEventListener('touchstart', e => {
    if (window.innerWidth > 768) return;
    if (e.touches[0].clientY - panel.getBoundingClientRect().top > 72) return;
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    startY = e.touches[0].clientY; startTime = Date.now(); delta = 0; dragging = true;
    clearTimeout(snapTimer); panel.style.transition = 'none';
  }, { passive: true });
  panel.addEventListener('touchmove', e => {
    if (!dragging) return;
    delta = Math.max(0, e.touches[0].clientY - startY);
    panel.style.transform = delta > 0 ? `translateY(${delta}px)` : 'translateY(0)';
  }, { passive: true });
  function onRelease() {
    if (!dragging) return;
    dragging = false;
    const velocity = delta / (Date.now() - startTime);
    if (delta > 80 || velocity > 0.3) {
      panel.style.transition = EASE;
      panel.style.transform = 'translateY(110%)';
      setTimeout(() => { panel.style.transition = 'none'; closeSessionPanel(); panel.style.transform = ''; panel.style.transition = ''; }, 300);
    } else {
      panel.style.transition = EASE; panel.style.transform = 'translateY(0)';
      snapTimer = setTimeout(() => { panel.style.transform = ''; panel.style.transition = ''; }, 310);
    }
  }
  panel.addEventListener('touchend', onRelease, { passive: true });
  panel.addEventListener('touchcancel', () => { if (!dragging) return; dragging = false; panel.style.transform = ''; panel.style.transition = ''; }, { passive: true });
}

// ── Test routing ──────────────────────────────────────────────────────────────
function _openTestOrConnect(test) {
  if (!_device?.gatt?.connected) {
    _updateBLEDialog();
    document.getElementById('dialog-ble').showModal();
    return;
  }
  _openTest(test);
}

function _openTest(test) {
  _currentTest = test;
  if (test === 'peak') {
    const labelInput = document.getElementById('peak-label-input');
    if (labelInput) labelInput.value = '';
    const active = document.querySelector('#peak-section-config .mode-btn.active');
    _laterality = active?.dataset.laterality ?? 'single';
    _showScreen('screen-peak');
    _showTestSection('peak', 'config');
  } else if (test === 'rfd') {
    _laterality = 'single';
    // Sync method toggle + interval settings visibility
    document.querySelectorAll('#rfd-method-toggle .mode-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.method === _rfdMethod);
    });
    const iCfg = document.getElementById('rfd-interval-cfg');
    if (iCfg) iCfg.hidden = _rfdMethod !== 'interval';
    _initRfdPicker('rfd-window-picker', _rfdWindowMs, v => { _rfdWindowMs = v; });
    _rfdLastPayload = null;
    _showScreen('screen-rfd');
    _showTestSection('rfd', 'config');
  } else if (test === 'live') {
    _selectedPeakResult = null;
    _sliderMinPct = 40;
    _sliderMaxPct = 60;
    const lbl = document.getElementById('live-peak-trigger-label');
    if (lbl) lbl.textContent = 'Seleccionar…';
    const zoneCheck = document.getElementById('live-zone-check');
    if (zoneCheck) zoneCheck.checked = false;
    const zoneBody = document.getElementById('live-zone-body');
    if (zoneBody) zoneBody.hidden = true;
    _showScreen('screen-live');
    _showLiveSection('config');
    _populateLivePeakSelector();
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
    startMeasurement();
    return;
  }

  if (_currentTest === 'rfd') {
    _rfdClip      = [];
    _rfdLeftClip  = [];
    _rfdRightClip = [];
    _renderSideBanner(_activeSide);
    _startRfdRecording();
    return;
  }

  _renderSideBanner(_activeSide);
  _updateRepsCounter();
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
    if (btn) {
      const cardTitle = document.querySelector(`[data-test="${test}"] .menu-card-title`)?.textContent;
      btn.textContent = cardTitle ? `+ ${cardTitle}` : `+ Nueva medición`;
    }
  }
}

// ── Render helpers ────────────────────────────────────────────────────────────
function _setBLEStatus(state) {
  _bleStatus = state;
  const badge = document.getElementById('btn-ble');
  if (!badge) return;
  badge.classList.remove('active', 'pending', 'error', 'remote');
  if (state === 'connected') badge.classList.add('active');
  else                       badge.classList.add('pending');
  _sessionCh.postMessage({ type: 'SESSION_BLE_STATUS', bleStatus: state });
}

function _setRemoteBLEStatus(status) {
  if (_bleStatus === 'connected') return;
  const badge = document.getElementById('btn-ble');
  if (!badge) return;
  badge.classList.remove('active', 'pending', 'error', 'remote');
  if (status === 'connected') badge.classList.add('remote');
  else                        badge.classList.add('pending');
}

function _updateBLEDialog() {
  const connecting = _bleStatus === 'connecting';
  const connected  = _bleStatus === 'connected';
  document.getElementById('ble-state-disconnected').hidden = connecting || connected;
  document.getElementById('ble-state-connecting').hidden   = !connecting;
  document.getElementById('ble-state-connected').hidden    = !connected;
  document.getElementById('btn-ble-close').hidden          = connecting;
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
  // pctEl intentionally unused (no battery % text element)
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
  if (payload.testType === 'rfd')  { _renderRfdResults(payload);  return; }

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

function _renderRfdResults(payload) {
  const isComp = payload.laterality === 'comparison';

  // Pick which clip/values to display (first side or single)
  const clip    = isComp ? (payload.sides?.left?.clip ?? []) : (payload.clip ?? []);
  const rfd2080 = isComp ? (payload.sides?.left?.rfd2080 ?? 0) : (payload.rfd2080 ?? 0);
  const rfdTime = isComp ? (payload.sides?.left?.rfdTime  ?? 0) : (payload.rfdTime  ?? 0);
  const peakKg  = isComp ? (payload.sides?.left?.peak ?? 0)    : (payload.peak ?? 0);
  const ife     = isComp ? (payload.sides?.left?.ife   ?? null) : (payload.ife   ?? null);
  const winMs   = payload.rfdWindowMs ?? _rfdWindowMs;

  // Numeric values
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('rfd-lbl-interval', `RFD ${winMs}ms`);
  set('rfd-num-interval', rfdTime > 0 ? rfdTime.toFixed(1) : '—');
  set('rfd-num-percent',  rfd2080 > 0 ? rfd2080.toFixed(1) : '—');

  // IFE
  const ifeRes = document.getElementById('rfd-ife-res');
  if (ife !== null && ifeRes) {
    set('rfd-ife-res-val', ife.toFixed(2) + ' %');
    ifeRes.hidden = false;
  } else if (ifeRes) { ifeRes.hidden = true; }

  // AI (comparison)
  const aiSection = document.getElementById('rfd-ai-section');
  if (isComp && payload.asymmetryIndex !== null && payload.asymmetryIndex !== undefined) {
    const ai = payload.asymmetryIndex;
    set('rfd-ai-value', ai.toFixed(1) + ' %');
    document.getElementById('rfd-ai-badge').dataset.level = ai < 10 ? 'green' : ai < 20 ? 'yellow' : 'red';
    if (aiSection) aiSection.hidden = false;
  } else {
    if (aiSection) aiSection.hidden = true;
  }

  // Draw result chart with 20-80% overlay by default
  const rc = document.getElementById('rfd-result-canvas');
  if (rc) {
    rc.width  = rc.clientWidth  * (window.devicePixelRatio || 1);
    rc.height = rc.clientHeight * (window.devicePixelRatio || 1);
    const p2080 = _calcRfd2080(clip);
    const pInt0 = _calcRfdInterval(clip, _rfdIntervalThr, winMs);
    _drawRfdChart('rfd-result-canvas', clip, {
      showMethod: _rfdResMethod,
      threshold:  _rfdIntervalThr,
      peakKg,
      t20: p2080.t20, t80: p2080.t80, f20: p2080.f20, f80: p2080.f80,
      t0: pInt0.t0, targetT: pInt0.targetT, ft: pInt0.ft,
    });
  }

  // Sync results settings panel to config values + init pickers
  _rfdResMethod    = _rfdMethod;
  _rfdResWindowMs  = _rfdWindowMs;
  _rfdResThreshold = _rfdIntervalThr;
  _rfdResIfeEnabled = _rfdIfeEnabled;
  _rfdResMvcRef    = _rfdMvcRef;
  _initRfdPicker('rfd-res-window-picker', _rfdResWindowMs, v => { _rfdResWindowMs = v; _redrawResultChart(); });
  _syncResSettingsPanel();
}

function _syncResSettingsPanel() {
  // Sync method toggle
  document.querySelectorAll('#rfd-res-method-toggle .mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.method === _rfdResMethod);
  });
  const resIntervalCfg = document.getElementById('rfd-res-interval-cfg');
  if (resIntervalCfg) resIntervalCfg.hidden = _rfdResMethod !== 'interval';

  // Sync IFE checkbox
  const ifeCheck = document.getElementById('rfd-res-ife-check');
  if (ifeCheck) ifeCheck.checked = _rfdResIfeEnabled;
  const ifeMvc = document.getElementById('rfd-res-ife-mvc');
  if (ifeMvc) ifeMvc.hidden = !_rfdResIfeEnabled;
}

function _redrawResultChart() {
  const payload = _rfdLastPayload;
  if (!payload || payload.testType !== 'rfd') return;
  const isComp = payload.laterality === 'comparison';
  const clip   = isComp ? (payload.sides?.left?.clip ?? []) : (payload.clip ?? []);
  const peakKg = isComp ? (payload.sides?.left?.peak ?? 0)  : (payload.peak ?? 0);
  const winMs  = _rfdResWindowMs;

  const rc = document.getElementById('rfd-result-canvas');
  if (!rc) return;
  if (!rc.width) { rc.width = rc.clientWidth * (window.devicePixelRatio||1); rc.height = rc.clientHeight * (window.devicePixelRatio||1); }
  const p2080 = _calcRfd2080(clip);
  const pInt  = _calcRfdInterval(clip, _rfdResThreshold, winMs);
  _drawRfdChart('rfd-result-canvas', clip, {
    showMethod: _rfdResMethod,
    threshold:  _rfdResThreshold,
    peakKg,
    t20: p2080.t20, t80: p2080.t80, f20: p2080.f20, f80: p2080.f80,
    t0: pInt.t0, targetT: pInt.targetT, ft: pInt.ft,
  });

  // Update interval RFD label + value
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('rfd-lbl-interval', `RFD ${winMs}ms`);
  const rfdTimeNew = _calcRfdInterval(clip, _rfdResThreshold, winMs).rfd;
  set('rfd-num-interval', rfdTimeNew > 0 ? rfdTimeNew.toFixed(1) : '—');

  // IFE recalc
  const mvcKg = _rfdResMvcRef ? _getRefPeakKg(_rfdResMvcRef) : null;
  const rfd2080 = p2080.rfd;
  const ifeNew = (_rfdResIfeEnabled && mvcKg && rfd2080 > 0) ? (rfd2080 / mvcKg) * 100 : null;
  const ifeRes = document.getElementById('rfd-ife-res');
  if (ifeNew !== null && ifeRes) { set('rfd-ife-res-val', ifeNew.toFixed(2) + ' %'); ifeRes.hidden = false; }
  else if (ifeRes) { ifeRes.hidden = true; }
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
      const win = r.rfdWindowMs ?? 100;
      if (r.sides) {
        const l2080 = r.sides.left?.rfd2080?.toFixed(1)  ?? '—';
        const r2080 = r.sides.right?.rfd2080?.toFixed(1) ?? '—';
        const lTime = r.sides.left?.rfdTime?.toFixed(1)  ?? '—';
        const rTime = r.sides.right?.rfdTime?.toFixed(1) ?? '—';
        let line = `  ${r.label}: Izq 2080=${l2080} ${win}ms=${lTime} | Der 2080=${r2080} ${win}ms=${rTime} kg/s`;
        if (r.asymmetryIndex != null) line += ` | AI ${r.asymmetryIndex.toFixed(1)} %`;
        return line;
      }
      let line = `  ${r.label}: 2080=${r.rfd2080?.toFixed(1) ?? '—'} ${win}ms=${r.rfdTime?.toFixed(1) ?? '—'} kg/s | Pico ${r.peak?.toFixed(1) ?? '—'} kg`;
      if (r.ife != null) line += ` | IFE ${r.ife.toFixed(2)} %`;
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

function _showIFEInfo(e) {
  document.getElementById('_ife-tip')?.remove();
  const msg = 'IFE = RFD / MVC × 100 — indica qué porcentaje de la fuerza máxima se desarrolla por segundo.';
  const tip = document.createElement('div');
  tip.id = '_ife-tip';
  tip.textContent = msg;
  const anchorX = e.clientX || (e.currentTarget.getBoundingClientRect().left + e.currentTarget.offsetWidth / 2);
  const anchorY = e.clientY || e.currentTarget.getBoundingClientRect().top;
  tip.style.cssText = `position:fixed;left:${anchorX}px;top:${anchorY}px;transform:translate(-50%,calc(-100% - 10px));background:var(--surface);border:1px solid var(--border2);color:var(--text2);font-size:.78rem;font-family:'Outfit',sans-serif;padding:9px 14px;border-radius:8px;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,.4);max-width:260px;text-align:center;line-height:1.5;pointer-events:none;`;
  document.body.appendChild(tip);
  requestAnimationFrame(() => {
    const r = tip.getBoundingClientRect();
    let left = anchorX;
    if (r.left < 8) left += 8 - r.left;
    if (r.right > window.innerWidth - 8) left -= r.right - window.innerWidth + 8;
    tip.style.left = left + 'px';
    if (r.top < 8) { tip.style.top = (anchorY + 14) + 'px'; tip.style.transform = 'translateX(-50%)'; }
  });
  setTimeout(() => tip.remove(), 3500);
  setTimeout(() => {
    const dismiss = () => { tip.remove(); document.removeEventListener('pointerdown', dismiss); };
    document.addEventListener('pointerdown', dismiss);
  }, 50);
}

function _showToast(msg, durationMs = 3500) {
  document.getElementById('_toast')?.remove();
  const el = document.createElement('div');
  el.id = '_toast';
  el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--surface);border:1px solid var(--border2);color:var(--text2);font-size:.8rem;font-family:\'Outfit\',sans-serif;padding:10px 18px;border-radius:8px;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,.4);max-width:320px;text-align:center;line-height:1.4;';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), durationMs);
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
function _setNewMeasurementBtn(type) {
  const btn = document.getElementById('btn-new-measurement');
  if (!btn) return;
  const cardTitle = type ? document.querySelector(`[data-test="${type}"] .menu-card-title`)?.textContent : null;
  btn.textContent = cardTitle ? `+ ${cardTitle}` : '+ Nueva medición';
}

function _renderMeasurementsList(type = null) {
  const list    = document.getElementById('measurements-list');
  const titleEl = document.getElementById('measurements-title');
  if (!list) return;

  const titles = { peak: 'Fuerza Pico / MVC', rfd: 'RFD', live: 'Datos en Vivo' };
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
      valStr = parts.join('<br>') || '—';
    } else if (m.testType === 'rfd' && m.laterality === 'comparison') {
      const l2 = m.sides?.left?.rfd2080;
      const r2 = m.sides?.right?.rfd2080;
      const parts = [];
      if (l2 != null) parts.push(`I: ${l2.toFixed(1)} kg/s`);
      if (r2 != null) parts.push(`D: ${r2.toFixed(1)} kg/s`);
      valStr = parts.join('<br>');
    } else if (m.testType === 'rfd') {
      const sideLabel = m.side === 'left' ? 'Izq · ' : m.side === 'right' ? 'Der · ' : '';
      const v2080 = m.rfd2080 != null ? `${sideLabel}2080=${m.rfd2080.toFixed(1)} kg/s` : '—';
      const vTime = m.rfdTime != null ? `<br>${m.rfdWindowMs ?? '?'}ms=${m.rfdTime.toFixed(1)} kg/s` : '';
      valStr = v2080 + vTime;
    } else if (m.laterality === 'comparison') {
      const l = m.sides?.left?.peak;
      const r = m.sides?.right?.peak;
      const parts = [];
      if (l != null) parts.push(`I: ${l.toFixed(1)} kg`);
      if (r != null) parts.push(`D: ${r.toFixed(1)} kg`);
      valStr = parts.join('<br>');
    } else {
      const peak      = m.peak;
      const sideLabel = m.side === 'left' ? 'Izq · ' : m.side === 'right' ? 'Der · ' : '';
      valStr = peak != null ? `${sideLabel}${peak.toFixed(1)} kg` : '—';
    }

    const _l = m.sides?.left?.peak, _r = m.sides?.right?.peak;
    const ai = m.asymmetryIndex ?? (_l != null && _r != null ? (() => { const avg = (_l + _r) / 2; return avg ? Math.abs(_l - _r) / avg * 100 : null; })() : null);
    const aiLevel = ai != null ? (ai < 10 ? 'green' : ai < 20 ? 'yellow' : 'red') : null;

    const typeLabel = m.testType === 'live' ? 'Tiempo real' : m.testType === 'rfd' ? 'RFD' : 'Fuerza Pico';

    card.innerHTML =
      `<div class="mcard-label">${m.label ?? `Medición ${i + 1}`}</div>` +
      `<div class="mcard-type">${typeLabel}</div>` +
      `<div class="mcard-values">${valStr}</div>` +
      `<div class="mcard-footer">` +
        `<span class="mcard-time">${timeStr}</span>` +
        (aiLevel ? `<span class="mcard-ai" data-level="${aiLevel}">AI ${ai.toFixed(1)} %</span>` : `<span></span>`) +
        `<button class="mcard-delete" aria-label="Eliminar">✕</button>` +
      `</div>`;

    card.querySelector('.mcard-delete').addEventListener('click', e => {
      e.stopPropagation();
      const label = m.label ?? `Medición ${i + 1}`;
      showConfirmBanner(
        'Borrar resultado',
        `Se eliminará el resultado de ${label}.`,
        'Borrar',
        () => _deleteSavedResult(m.timestamp)
      );
    });
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

// ========= SWIPE-TO-DISMISS BOTTOM SHEET =========
(function () {
  function initSwipe(sheet, closeFn) {
    let startY = 0, startTime = 0, dragging = false, delta = 0, snapTimer = null;
    const EASE = 'transform 0.3s cubic-bezier(.32,1,.23,1)';

    sheet.addEventListener('touchstart', e => {
      if (e.touches[0].clientY - sheet.getBoundingClientRect().top > 72) return;
      startY = e.touches[0].clientY;
      startTime = Date.now();
      delta = 0;
      dragging = true;
      clearTimeout(snapTimer);
      sheet.style.transition = 'none';
    }, { passive: true });

    sheet.addEventListener('touchmove', e => {
      if (!dragging) return;
      delta = Math.max(0, e.touches[0].clientY - startY);
      sheet.style.transform = delta > 0 ? `translateY(${delta}px)` : 'translateY(0)';
    }, { passive: true });

    function onRelease() {
      if (!dragging) return;
      dragging = false;
      const velocity = delta / (Date.now() - startTime);
      if (delta > 80 || velocity > 0.3) {
        sheet.style.transition = EASE;
        sheet.style.transform = 'translateY(110%)';
        setTimeout(() => {
          sheet.style.transition = 'none';
          closeFn();
          sheet.style.transform = '';
          sheet.style.transition = '';
        }, 300);
      } else {
        sheet.style.transition = EASE;
        sheet.style.transform = 'translateY(0)';
        snapTimer = setTimeout(() => {
          sheet.style.transform = '';
          sheet.style.transition = '';
        }, 310);
      }
    }

    sheet.addEventListener('touchend', onRelease, { passive: true });
    sheet.addEventListener('touchcancel', () => {
      if (!dragging) return;
      dragging = false;
      sheet.style.transform = '';
      sheet.style.transition = '';
    }, { passive: true });
  }

  const sheet = document.getElementById('mvc-sheet');
  if (sheet) initSwipe(sheet, _closeMvcSheet);
}());
