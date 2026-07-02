# Session Panel Flow

Patrón de panel de sesión para satélites PhysiQ. Implementado y validado en `physiq-force`.

---

## Estados del panel

El panel tiene exactamente **dos estados**. No hay pantalla intermedia de información.

```
btn-session (clic)
  → si panel cerrado → estado 'edit'
  → si panel abierto → cierra

Estado 'edit'
  → input del nombre del paciente (guarda automáticamente al escribir)
  → icono papelera (visible solo con sesión activa) → estado 'delete'
  → clic en overlay / Enter → cierra

Estado 'delete'
  → Cancelar → vuelve a estado 'edit'
  → Confirmar → softReset + clearSession + emite SESSION_CLEAR + cierra
```

---

## Clicks por acción

| Acción | Clicks |
|--------|--------|
| Abrir panel y editar nombre | 1 clic + escribir |
| Cerrar panel | 1 clic (overlay) o Enter |
| Borrar sesión | 1 clic (abrir) + 1 clic (papelera) + 1 clic (confirmar) = **3** |

---

## Implementación

### `toggleSessionPanel`

Siempre va a `'edit'`, independientemente de si hay sesión activa o no.

```js
function toggleSessionPanel() {
  const overlay = document.getElementById('sessionPanelOverlay');
  if (!overlay) return;
  if (overlay.classList.contains('open')) { closeSessionPanel(); return; }
  _showSessionState('edit');
  overlay.classList.add('open');
}
```

### `_showSessionState(state)`

Solo dos ramas: `'edit'` y `'delete'`. No existe estado `'info'`.

```js
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
          <input class="patient-name-input" type="text" id="patientName" style="flex:1;"
                 placeholder="Nombre (opcional)" autocomplete="off">
          <button class="session-panel-clear" id="sessionPanelClear" title="Borrar sesión">
            <!-- icono papelera SVG -->
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
```

### `closeSessionPanel`

```js
function closeSessionPanel() {
  const overlay = document.getElementById('sessionPanelOverlay');
  const panel = document.getElementById('sessionPanel');
  overlay?.classList.remove('open');
  if (panel) { panel.style.transition = ''; panel.style.transform = ''; }
}
```

### `promptClearSession`

Acceso directo al estado `'delete'` desde fuera del panel (p. ej. botón de reinicio en la cabecera). Abre el overlay si no estaba visible.

```js
function promptClearSession() {
  _showSessionState('delete');
  const overlay = document.getElementById('sessionPanelOverlay');
  if (overlay && !overlay.classList.contains('open')) overlay.classList.add('open');
}
```

---

## CSS clave

El botón papelera se oculta cuando no hay sesión activa, de modo que en el estado `'edit'` sin paciente el panel solo muestra el input.

```css
.session-panel-clear {
  display: none;
  /* ... resto de estilos */
}
.session-panel.has-session .session-panel-clear {
  display: flex;
}
```

---

## Regla de diseño

> El estado `'info'` (pantalla intermedia con botones Cancelar / Editar / Borrar) **no existe** en este patrón. Fue eliminado porque toda su funcionalidad ya está cubierta por el estado `'edit'`: el título muestra el label de sesión, el input permite editar y el botón papelera da acceso a la confirmación de borrado.

Cualquier PR que introduzca un estado `'info'` en el panel de sesión debe rechazarse.
