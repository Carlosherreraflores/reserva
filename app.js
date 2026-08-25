// ─────────────────────────────────────────────
// CONFIGURACIÓN Y CONSTANTES
// ─────────────────────────────────────────────

const API = '/api';
const HERO_IMG  = 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=1200&q=80';
const CABIN_IMG = 'https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?auto=format&fit=crop&w=800&q=80';

const DOW_SHORT  = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
const DOW_LONG   = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const CAL_VIEWS  = ['inicio', 'nueva', 'reservas', 'calendario', 'pendientes'];
const LS_FS      = 'cb_fs';
const LS_GC      = 'cb_gcal';

const state = {
    cabins:       [],        // cargado desde la API
    reservations: [],        // cargado desde la API
    notifications: [],       // reservas pendientes del bot
    view:         'inicio',
    filter:       'proximas',
    search:       '',
    calY:  new Date().getFullYear(),
    calM:  new Date().getMonth(),
    gcal:  localStorage.getItem(LS_GC) === '1',
    lastSaved: null,
    loading: false,
};

let wiz = createNewWizard();
let toastTimer = null;
let confirmCallback = null;

// ─────────────────────────────────────────────
// API — HELPERS
// ─────────────────────────────────────────────

async function apiFetch(path, options = {}) {
    const res = await fetch(`${API}${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Error ${res.status}`);
    }
    return res.json();
}

async function loadCabins() {
    state.cabins = await apiFetch('/cabanas');
}

async function loadReservations() {
    const data = await apiFetch('/reservas?estado=todas');
    state.reservations = data.map(normalizeReservation);
}

async function loadNotifications() {
    state.notifications = await apiFetch('/notificaciones');
}

// Normaliza los nombres de campo de la API al formato que usa la UI
function normalizeReservation(r) {
    return {
        id:       r.id,
        cabinId:  r.cabinId  ?? r.cabana_id,
        checkIn:  typeof r.checkIn === 'string' ? r.checkIn.slice(0, 10) : new Date(r.check_in).toISOString().slice(0, 10),
        checkOut: typeof r.checkOut === 'string' ? r.checkOut.slice(0, 10) : new Date(r.check_out).toISOString().slice(0, 10),
        guestName: r.guestName ?? r.nombre_huesped,
        phone:    r.phone     ?? r.telefono,
        guests:   r.guests    ?? r.personas,
        notes:    r.notes     ?? r.notas ?? '',
        estado:   r.estado    ?? 'confirmada',
        origen:   r.origen    ?? 'web',
        whatsappJid: r.whatsappJid ?? r.whatsapp_jid ?? null,
        hue:      r.hue,
    };
}

// ─────────────────────────────────────────────
// HELPERS DE FECHA Y UTILIDADES
// ─────────────────────────────────────────────

function pad(v) { return String(v).padStart(2, '0'); }

function toISO(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function fromISO(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
}

function addDaysISO(iso, days) {
    const d = fromISO(iso);
    d.setDate(d.getDate() + days);
    return toISO(d);
}

function todayISO() { return toISO(new Date()); }

function escapeHTML(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function formatShortDate(iso) {
    return fromISO(iso).toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
}

function formatLongDate(iso) {
    return fromISO(iso).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function getNights(r) {
    return Math.round((fromISO(r.checkOut) - fromISO(r.checkIn)) / 86400000);
}

function getCabin(id) {
    return state.cabins.find(c => c.id === id) || { id, nombre: `Cabaña ${id}`, capacidad: 6, hue: 145 };
}

function generateUID() {
    return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function getReservationAt(cabinId, isoDate) {
    return state.reservations.find(r =>
        r.cabinId === cabinId &&
        r.checkIn <= isoDate && isoDate < r.checkOut &&
        (r.estado === 'confirmada' || r.estado === 'pendiente')
    ) || null;
}

function overlaps(ciA, coA, ciB, coB) { return ciA < coB && ciB < coA; }

function isCabinAvailable(cabinId, checkIn, checkOut) {
    return !state.reservations.some(r =>
        r.cabinId === cabinId &&
        (r.estado === 'confirmada' || r.estado === 'pendiente') &&
        overlaps(checkIn, checkOut, r.checkIn, r.checkOut)
    );
}

function getReservationById(id) {
    return state.reservations.find(r => r.id === id) || null;
}

function createNewWizard() {
    return { step: 1, cabinId: null, checkIn: todayISO(), checkOut: addDaysISO(todayISO(), 1), name: '', phone: '', guests: 2, notes: '' };
}

// ─────────────────────────────────────────────
// NAVEGACIÓN Y RENDER PRINCIPAL
// ─────────────────────────────────────────────

function renderGoogleChip() {
    const chip = document.getElementById('gchip');
    chip.className = state.gcal ? 'on' : 'off';
    chip.innerText = state.gcal ? '🟢 Google Calendar conectado' : '⚪ Conectar Google Calendar';
}

function setView(view) {
    state.view = view;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
    CAL_VIEWS.forEach(k => {
        const el = document.getElementById(`view-${k}`);
        if (el) el.classList.toggle('active', k === view);
    });
    renderView();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderView() {
    switch (state.view) {
        case 'inicio':     renderInicio();        break;
        case 'nueva':      renderWizard();         break;
        case 'reservas':   renderReservations();   break;
        case 'calendario': renderCalendar();       break;
        case 'pendientes': renderPendientes();     break;
    }
}

function renderAll() {
    renderGoogleChip();
    renderView();
    updateNotifBadge();
}

// ─────────────────────────────────────────────
// BADGE DE NOTIFICACIONES
// ─────────────────────────────────────────────

function updateNotifBadge() {
    const count = state.notifications.length;
    const tab = document.querySelector('[data-view="pendientes"]');
    if (!tab) return;
    const badge = tab.querySelector('.badge');
    if (count > 0) {
        if (badge) badge.textContent = count;
        else tab.insertAdjacentHTML('beforeend', `<span class="badge">${count}</span>`);
    } else {
        if (badge) badge.remove();
    }
}

// ─────────────────────────────────────────────
// VISTA: INICIO
// ─────────────────────────────────────────────

function countTodayStatuses() {
    const today = todayISO();
    const occupied  = state.cabins.filter(c => Boolean(getReservationAt(c.id, today))).length;
    const arrivals  = state.reservations.filter(r => r.checkIn === today && r.estado !== 'cancelada').length;
    const departures = state.reservations.filter(r => r.checkOut === today && r.estado !== 'cancelada').length;
    return { occupied, arrivals, departures };
}

function renderInicio() {
    const today = todayISO();
    const { occupied, arrivals, departures } = countTodayStatuses();
    const next30 = Array.from({ length: 30 }, (_, i) => addDaysISO(today, i));

    const statsHTML = `
      <div class="stats">
        <div class="stat g"><div class="num">${state.cabins.length - occupied}</div><div class="lbl">🟢 Libres hoy</div></div>
        <div class="stat r"><div class="num">${occupied}</div><div class="lbl">🔴 Ocupadas hoy</div></div>
        <div class="stat a"><div class="num">${arrivals}</div><div class="lbl">🛬 Llegadas hoy</div></div>
        <div class="stat a"><div class="num">${departures}</div><div class="lbl">🛫 Salidas hoy</div></div>
      </div>`;

    const cabinsHTML = state.cabins.map(cabin => {
        const res = getReservationAt(cabin.id, today);
        const next = state.reservations
            .filter(r => r.cabinId === cabin.id && r.checkIn >= today && r.estado !== 'cancelada')
            .sort((a, b) => a.checkIn.localeCompare(b.checkIn))[0] || null;
        return `
          <div class="cabrow">
            <img src="${CABIN_IMG}" alt="${cabin.nombre}">
            <div class="grow">
              <div class="nm">${cabin.nombre} <span class="muted" style="font-weight:700;font-size:.85rem">· ${cabin.capacidad} personas</span></div>
              <div class="sub">${res ? `Ocupada por ${escapeHTML(res.guestName)} hasta el ${formatShortDate(res.checkOut)}` : next ? `Próxima reserva: ${formatShortDate(next.checkIn)}` : 'Sin reservas próximas'}</div>
            </div>
            ${res ? '<span class="chip occ">🔴 Ocupada</span>' : `<span class="chip free">🟢 Libre</span><button class="btn primary small" data-act="quick-res" data-cabin="${cabin.id}" data-date="${today}">Reservar</button>`}
          </div>`;
    }).join('');

    const tlCols = `grid-template-columns:130px repeat(30,1fr)`;
    const availabilityGrid = `
      <div class="tl-wrap"><div class="tl" style="${tlCols}">
        <div></div>
        ${next30.map((date, i) => `<div class="tl-h${i === 0 ? ' today' : ''}">${fromISO(date).getDate()}<small>${DOW_SHORT[fromISO(date).getDay()]}</small></div>`).join('')}
        ${state.cabins.map(cabin => `
          <div class="tl-name">${cabin.nombre}</div>
          ${next30.map(date => {
              const past = date < today;
              const res  = getReservationAt(cabin.id, date);
              if (past) return '<div class="tl-cell past" title="Día pasado"></div>';
              if (res)  return `<div class="tl-cell occ" title="${cabin.nombre} ocupada: ${escapeHTML(res.guestName)}"></div>`;
              return `<div class="tl-cell free" data-act="quick-res" data-cabin="${cabin.id}" data-date="${date}" title="Reservar ${cabin.nombre} el ${formatShortDate(date)}"></div>`;
          }).join('')}
        `).join('')}
      </div></div>`;

    document.getElementById('view-inicio').innerHTML = `
      <div class="hero"><img src="${HERO_IMG}" alt="Playa Guanaqueros"><div class="txt"><h1>¡Bienvenido/a! 👋</h1><p>${formatLongDate(today)}</p></div></div>
      ${statsHTML}
      <div class="card" style="margin-bottom:1rem"><h2>🏡 Estado de las cabañas hoy</h2>${cabinsHTML}</div>
      <div class="card"><h2>📆 Próximos 30 días</h2><p class="muted" style="margin-bottom:.8rem;font-size:.92rem">Toque un cuadro <b style="color:var(--blue-d)">azul</b> para crear una reserva.</p>${availabilityGrid}<div class="legend"><span><i class="sw f"></i> Libre</span><span><i class="sw o"></i> Ocupada</span><span><i class="sw" style="background:#ececec;border:2px solid #e0e0e0"></i> Pasado</span></div></div>`;
}

// ─────────────────────────────────────────────
// VISTA: WIZARD NUEVA RESERVA
// ─────────────────────────────────────────────

function renderWizardSteps() {
    const labels = ['Fechas y cabaña', 'Datos del huésped', 'Confirmar'];
    return `<div class="steps">${labels.map((label, i) => {
        const n = i + 1;
        const cls = wiz.step === n ? 'active' : wiz.step > n || wiz.step === 4 ? 'done' : '';
        const sym = wiz.step > n || wiz.step === 4 ? '✓' : n;
        return `<div class="step ${cls}"><span class="n">${sym}</span> ${label}${n < 3 ? '<span class="bar"></span>' : ''}</div>`;
    }).join('')}</div>`;
}

function renderWizardCabins() {
    const container = document.getElementById('wiz-cabins');
    if (!container) return;
    container.innerHTML = state.cabins.map(cabin => {
        const available = isCabinAvailable(cabin.id, wiz.checkIn, wiz.checkOut);
        const conflict = available ? null : state.reservations.find(r =>
            r.cabinId === cabin.id && overlaps(wiz.checkIn, wiz.checkOut, r.checkIn, r.checkOut) && r.estado !== 'cancelada'
        );
        return `
          <button class="cab-card${wiz.cabinId === cabin.id ? ' sel' : ''}" data-act="pick-cabin" data-id="${cabin.id}" ${available ? '' : 'disabled'}>
            <img src="${CABIN_IMG}" alt="${cabin.nombre}">
            <div class="nm">${cabin.nombre}</div>
            <div class="muted" style="font-size:.8rem;font-weight:700">${cabin.capacidad} personas</div>
            <div class="st" style="color:${available ? 'var(--blue)' : 'var(--red)'}">
              ${available ? '✅ Libre' : `❌ Ocupada${conflict ? ` (${formatShortDate(conflict.checkIn)} → ${formatShortDate(conflict.checkOut)})` : ''}`}
            </div>
          </button>`;
    }).join('');
    const btn = document.getElementById('wiz-next1');
    if (btn) btn.disabled = !wiz.cabinId;
}

function renderWizard() {
    document.getElementById('view-nueva').innerHTML = `
      <div class="card">
        ${renderWizardSteps()}
        ${renderWizardStepContent()}
      </div>`;
    if (wiz.step === 1) renderWizardCabins();
}

function renderWizardStepContent() {
    if (wiz.step === 1) return `
      <h2>1️⃣ Elija las fechas y la cabaña</h2>
      <div class="wiz-dates">
        <div><label for="inp-in">🛬 Fecha de llegada</label><input type="date" id="inp-in" data-field="in" min="${todayISO()}" value="${wiz.checkIn}" required></div>
        <div><label for="inp-out">🛫 Fecha de salida</label><input type="date" id="inp-out" data-field="out" min="${addDaysISO(wiz.checkIn, 1)}" value="${wiz.checkOut}" required></div>
      </div>
      <label style="margin-bottom:.6rem">🏡 Cabaña disponible</label>
      <div class="cab-grid" id="wiz-cabins"></div>
      <div class="wiz-actions"><button class="btn primary" id="wiz-next1" data-act="wiz-next1" ${!wiz.cabinId ? 'disabled' : ''}>Continuar ➡</button></div>`;

    if (wiz.step === 2) {
        const cabin = getCabin(wiz.cabinId);
        const maxGuests = Array.from({ length: cabin.capacidad }, (_, i) => {
            const v = i + 1;
            return `<option value="${v}"${v === wiz.guests ? ' selected' : ''}>${v}</option>`;
        }).join('');
        return `
          <h2>2️⃣ Datos del huésped</h2>
          <div class="chip free" style="margin-bottom:1rem">🏡 ${cabin.nombre} · ${formatShortDate(wiz.checkIn)} → ${formatShortDate(wiz.checkOut)} · ${getNights(wiz)} noche(s)</div>
          <div class="form-grid">
            <div class="full"><label for="f-name">👤 Nombre del huésped *</label><input type="text" id="f-name" data-field="name" placeholder="Ej: Juan Pérez" value="${escapeHTML(wiz.name)}" required></div>
            <div><label for="f-phone">📞 Teléfono *</label><input type="tel" id="f-phone" data-field="phone" placeholder="Ej: 56912345678" value="${escapeHTML(wiz.phone)}" required></div>
            <div><label for="f-guests">👥 Personas</label><select id="f-guests" data-field="guests">${maxGuests}</select></div>
            <div class="full"><label for="f-notes">📝 Notas (opcional)</label><textarea id="f-notes" data-field="notes" rows="2" placeholder="Ej: llega por la tarde">${escapeHTML(wiz.notes)}</textarea></div>
          </div>
          <div class="wiz-actions">
            <button class="btn ghost" data-act="wiz-back1">⬅ Atrás</button>
            <button class="btn primary" data-act="wiz-next2">Continuar ➡</button>
          </div>`;
    }

    if (wiz.step === 3) {
        const cabin = getCabin(wiz.cabinId);
        return `
          <h2>3️⃣ Revise y confirme</h2>
          <div style="max-width:560px">
            <div class="sumrow"><span class="muted">Cabaña</span><b>🏡 ${cabin.nombre}</b></div>
            <div class="sumrow"><span class="muted">Llegada</span><b>${formatShortDate(wiz.checkIn)}</b></div>
            <div class="sumrow"><span class="muted">Salida</span><b>${formatShortDate(wiz.checkOut)}</b></div>
            <div class="sumrow"><span class="muted">Noches</span><b>${getNights(wiz)}</b></div>
            <div class="sumrow"><span class="muted">Huésped</span><b>${escapeHTML(wiz.name)}</b></div>
            <div class="sumrow"><span class="muted">Teléfono</span><b>${escapeHTML(wiz.phone)}</b></div>
            <div class="sumrow"><span class="muted">Personas</span><b>${wiz.guests}</b></div>
            ${wiz.notes ? `<div class="sumrow"><span class="muted">Notas</span><b>${escapeHTML(wiz.notes)}</b></div>` : ''}
          </div>
          <div class="wiz-actions">
            <button class="btn ghost" data-act="wiz-back2">⬅ Atrás</button>
            <button class="btn primary" data-act="save-res">✅ Guardar reserva</button>
          </div>`;
    }

    // Paso 4: éxito
    const saved = state.lastSaved;
    const cabin = saved ? getCabin(saved.cabinId) : null;
    return `
      <div class="success">
        <div class="big">🎉</div>
        <h2>¡Reserva guardada!</h2>
        <p style="font-weight:800;font-size:1.1rem;margin-bottom:.4rem">${cabin ? `${cabin.nombre} · ${escapeHTML(saved.guestName)}` : ''}</p>
        <p class="muted" style="margin-bottom:1.2rem">${saved ? `${formatShortDate(saved.checkIn)} → ${formatShortDate(saved.checkOut)} (${getNights(saved)} noches)` : ''}</p>
        <div class="wiz-actions" style="justify-content:center">
          <button class="btn primary" data-act="gcal-add">📅 Agregar a Google Calendar</button>
          <button class="btn soft" data-act="ics" data-id="${saved ? saved.id : ''}">⬇ Recordatorio (.ics)</button>
          <button class="btn ghost" data-act="nav" data-view="calendario">📅 Ver calendario</button>
          <button class="btn ghost" data-act="reset-wiz">➕ Nueva reserva</button>
        </div>
      </div>`;
}

// ─────────────────────────────────────────────
// VISTA: LISTA DE RESERVAS
// ─────────────────────────────────────────────

function getReservationStatus(r) {
    const today = todayISO();
    if (r.estado === 'cancelada')  return { text: '🗑 Cancelada', cls: 'gray' };
    if (r.estado === 'pendiente')  return { text: '🟡 Pendiente', cls: 'warn' };
    if (r.checkIn <= today && today < r.checkOut) return { text: '🟢 En curso', cls: 'free' };
    if (r.checkOut <= today)       return { text: '⚪ Pasada', cls: 'gray' };
    return { text: '🔵 Confirmada', cls: 'warn' };
}

function renderReservations() {
    document.getElementById('view-reservas').innerHTML = `
      <div class="toolbar">
        <input type="text" data-field="search" placeholder="🔍 Buscar por nombre o teléfono…" value="${escapeHTML(state.search)}">
        ${['proximas', 'todas', 'pasadas'].map(f => `<button class="fchip${state.filter === f ? ' active' : ''}" data-act="filter" data-f="${f}">${f === 'proximas' ? 'Próximas y activas' : f === 'todas' ? 'Todas' : 'Pasadas'}</button>`).join('')}
      </div>
      <div id="res-list"></div>`;
    renderReservationList();
}

function renderReservationList() {
    const container = document.getElementById('res-list');
    if (!container) return;
    const today = todayISO();

    let list = [...state.reservations].sort((a, b) => a.checkIn.localeCompare(b.checkIn));
    if (state.filter === 'proximas') list = list.filter(r => r.checkOut > today && r.estado !== 'cancelada');
    if (state.filter === 'pasadas')  list = list.filter(r => r.checkOut <= today);

    const q = state.search.trim().toLowerCase().replace(/\s+/g, '');
    if (q) list = list.filter(r =>
        r.guestName.toLowerCase().includes(q) ||
        r.phone.replace(/\s+/g, '').includes(q)
    );

    if (!list.length) {
        container.innerHTML = `
          <div class="card" style="text-align:center;padding:2.5rem">
            <div style="font-size:3rem">🗂</div>
            <h2 style="justify-content:center">No hay reservas aquí</h2>
            <p class="muted" style="margin-bottom:1rem">Cuando cree una reserva aparecerá en esta lista.</p>
            <button class="btn primary" data-act="nav" data-view="nueva">➕ Crear reserva</button>
          </div>`;
        return;
    }

    container.innerHTML = list.map(r => {
        const cabin  = getCabin(r.cabinId);
        const status = getReservationStatus(r);
        const origenTag = r.origen === 'whatsapp'
            ? '<span class="chip warn" style="font-size:.75rem">📱 WhatsApp</span>'
            : '';
        return `
          <div class="res-card">
            <div class="res-bar" style="background:hsl(${cabin.hue},55%,45%)"></div>
            <div class="res-body">
              <div class="res-top">
                <span class="ttl">🏡 ${cabin.nombre}</span>
                <span class="chip ${status.cls}">${status.text}</span>
                ${origenTag}
              </div>
              <div class="res-dates">📅 ${formatShortDate(r.checkIn)} → ${formatShortDate(r.checkOut)} · ${getNights(r)} noche(s)</div>
              <div class="res-meta">
                <span>👤 ${escapeHTML(r.guestName)}</span>
                <span>📞 ${escapeHTML(r.phone)}</span>
                <span>👥 ${r.guests} persona(s)</span>
                ${r.notes ? `<span>📝 ${escapeHTML(r.notes)}</span>` : ''}
              </div>
              <div class="res-actions">
                <button class="btn soft small" data-act="gcal-open" data-id="${r.id}">📅 Google Calendar</button>
                <button class="btn ghost small" data-act="ics" data-id="${r.id}">⬇ .ics</button>
                ${r.estado !== 'cancelada' ? `<button class="btn danger small" data-act="cancel-res" data-id="${r.id}">🗑 Cancelar</button>` : ''}
              </div>
            </div>
          </div>`;
    }).join('');
}

// ─────────────────────────────────────────────
// VISTA: CALENDARIO
// ─────────────────────────────────────────────

function renderCalendar() {
    const view = document.getElementById('view-calendario');
    const currentDate = new Date(state.calY, state.calM, 1);
    const monthLabel  = currentDate.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
    const startOffset = (currentDate.getDay() + 6) % 7;
    const startDate   = addDaysISO(toISO(currentDate), -startOffset);
    const today       = todayISO();
    const days        = Array.from({ length: 42 }, (_, i) => addDaysISO(startDate, i));

    const cells = days.map(date => {
        const inMonth = fromISO(date).getMonth() === state.calM;
        const events  = state.cabins
            .map(c => ({ cabin: c, reservation: getReservationAt(c.id, date) }))
            .filter(e => e.reservation);
        return `
          <div class="cal-cell${inMonth ? '' : ' dim'}${date === today ? ' today' : ''}" data-act="day" data-date="${date}" title="Ver ${formatShortDate(date)}">
            <div class="d">${fromISO(date).getDate()}</div>
            ${events.slice(0, 3).map(e => `
              <div class="ev" style="background:hsl(${e.cabin.hue},70%,90%);border-color:hsl(${e.cabin.hue},55%,45%);color:hsl(${e.cabin.hue},70%,22%)">
                C${e.cabin.id} · ${escapeHTML(e.reservation.guestName.split(' ')[0])}
              </div>`).join('')}
            ${events.length > 3 ? `<div class="cal-more">+${events.length - 3} más</div>` : ''}
          </div>`;
    }).join('');

    view.innerHTML = `
      <div class="card">
        <div class="cal-head">
          <h2>📅 ${monthLabel}</h2>
          <div class="cal-nav">
            <button class="btn ghost small" data-act="cal-prev">◀</button>
            <button class="btn soft small" data-act="cal-today">Hoy</button>
            <button class="btn ghost small" data-act="cal-next">▶</button>
          </div>
        </div>
        <div class="legend" style="margin:0 0 .9rem">
          ${state.cabins.map(c => `<span><i class="sw" style="background:hsl(${c.hue},70%,88%);border:2px solid hsl(${c.hue},55%,45%)"></i>${c.nombre}</span>`).join('')}
        </div>
        <div class="cal-grid">
          ${DOW_LONG.map(d => `<div class="cal-dow">${d}</div>`).join('')}
          ${cells}
        </div>
        <p class="muted" style="margin-top:.9rem;font-size:.92rem">Toque un día para ver el detalle.</p>
      </div>`;
}

// ─────────────────────────────────────────────
// VISTA: PENDIENTES DEL BOT
// ─────────────────────────────────────────────

function renderPendientes() {
    const view = document.getElementById('view-pendientes');
    if (!view) return;

    if (!state.notifications.length) {
        view.innerHTML = `
          <div class="card" style="text-align:center;padding:2.5rem">
            <div style="font-size:3rem">✅</div>
            <h2 style="justify-content:center">Sin solicitudes pendientes</h2>
            <p class="muted">Cuando el bot reciba una solicitud de reserva aparecerá aquí para tu confirmación.</p>
          </div>`;
        return;
    }

    view.innerHTML = `
      <div class="card">
        <h2>🔔 Solicitudes del bot pendientes de confirmación</h2>
        <p class="muted" style="margin-bottom:1rem;font-size:.93rem">Estas reservas fueron iniciadas por clientes via WhatsApp. Confirma o rechaza cada una.</p>
        ${state.notifications.map(n => `
          <div class="res-card" id="notif-${n.id}">
            <div class="res-bar" style="background:#e6a817"></div>
            <div class="res-body">
              <div class="res-top">
                <span class="ttl">🏡 Cabaña ${n.cabana_id}</span>
                <span class="chip warn">🟡 Pendiente</span>
                <span class="chip warn" style="font-size:.75rem">📱 WhatsApp</span>
              </div>
              <div class="res-dates">📅 ${formatShortDate(n.check_in)} → ${formatShortDate(n.check_out)}</div>
              <div class="res-meta">
                <span>👤 ${escapeHTML(n.nombre_huesped)}</span>
                <span>👥 ${n.personas} persona(s)</span>
                <span>📱 ${escapeHTML(n.whatsapp_jid || '')}</span>
              </div>
              <div style="background:#fdf3e0;border:2px solid #ecd0a1;border-radius:12px;padding:.7rem .9rem;margin:.5rem 0;font-size:.9rem;font-weight:700;white-space:pre-wrap">${escapeHTML(n.mensaje)}</div>
              <div class="res-actions">
                <button class="btn primary small" data-act="confirmar-notif" data-reserva="${n.reserva_id}" data-notif="${n.id}">✅ Confirmar reserva</button>
                <button class="btn danger small" data-act="rechazar-notif" data-reserva="${n.reserva_id}" data-notif="${n.id}">❌ Rechazar</button>
              </div>
            </div>
          </div>`).join('')}
      </div>`;
}

// ─────────────────────────────────────────────
// MODAL DÍA
// ─────────────────────────────────────────────

function openDayModal(dateISO) {
    const rows = state.cabins.map(cabin => {
        const r = getReservationAt(cabin.id, dateISO);
        return `
          <div class="dayrow">
            <div class="grow">
              <b>🏡 ${cabin.nombre}</b>
              <div class="muted" style="font-size:.9rem;font-weight:700">
                ${r ? `Ocupada por ${escapeHTML(r.guestName)} (${formatShortDate(r.checkIn)} → ${formatShortDate(r.checkOut)})` : 'Libre'}
              </div>
            </div>
            ${r ? '<span class="chip occ">Ocupada</span>' : `<button class="btn primary small" data-act="quick-res" data-cabin="${cabin.id}" data-date="${dateISO}">Reservar</button>`}
          </div>`;
    }).join('');

    const hasFree = state.cabins.some(c => !getReservationAt(c.id, dateISO));
    openModal(`
      <button class="x" data-act="close-modal">✕</button>
      <h3>📅 ${formatLongDate(dateISO)}</h3>
      ${rows}
      ${!hasFree ? '<p class="muted" style="margin-top:1rem;text-align:center">Todas las cabañas están ocupadas este día.</p>' : ''}`);
}

// ─────────────────────────────────────────────
// TOAST / MODAL
// ─────────────────────────────────────────────

function showToast(msg, type = '') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = `show${type === 'err' ? ' err' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.className = '', 3400);
}

function openModal(content) {
    modalRoot.innerHTML = `<div class="overlay" data-act="overlay"><div class="modal">${content}</div></div>`;
}

function closeModal() { modalRoot.innerHTML = ''; }

function askConfirm(title, msg, okLabel, cb) {
    confirmCallback = cb;
    openModal(`
      <button class="x" data-act="close-modal">✕</button>
      <h3>${title}</h3>
      <p style="font-weight:700;font-size:1.05rem;margin-bottom:1.2rem">${msg}</p>
      <div style="display:flex;gap:.8rem;flex-wrap:wrap">
        <button class="btn danger" data-act="confirm-ok" style="flex:1">${okLabel}</button>
        <button class="btn soft" data-act="close-modal" style="flex:1">No, mantener</button>
      </div>`);
}

// ─────────────────────────────────────────────
// GOOGLE CALENDAR / ICS
// ─────────────────────────────────────────────

function getGoogleCalendarUrl(r) {
    const cabin   = getCabin(r.cabinId);
    const d1      = r.checkIn.replace(/-/g, '');
    const d2      = r.checkOut.replace(/-/g, '');
    const text    = encodeURIComponent(`Reserva ${cabin.nombre} — ${r.guestName}`);
    const details = encodeURIComponent(`Huésped: ${r.guestName}\nTeléfono: ${r.phone}\nPersonas: ${r.guests}\nCabaña: ${cabin.nombre}`);
    return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${text}&dates=${d1}/${d2}&details=${details}&location=${encodeURIComponent('Cabañas Guanaquero')}`;
}

function downloadICS(r) {
    const cabin = getCabin(r.cabinId);
    const lines = [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CabanasGuanaquero//ES',
        'BEGIN:VEVENT',
        `UID:${r.id}@cabanasguanaqueros`,
        `DTSTAMP:${todayISO().replace(/-/g, '')}T090000`,
        `DTSTART;VALUE=DATE:${r.checkIn.replace(/-/g, '')}`,
        `DTEND;VALUE=DATE:${r.checkOut.replace(/-/g, '')}`,
        `SUMMARY:Reserva ${cabin.nombre} - ${r.guestName}`,
        `DESCRIPTION:Huésped: ${r.guestName} · Tel: ${r.phone} · Personas: ${r.guests}`,
        'LOCATION:Cabañas Guanaquero',
        'END:VEVENT', 'END:VCALENDAR',
    ];
    const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `reserva-${cabin.nombre.replace(/\s/g, '')}.ics`;
    document.body.appendChild(a);
    a.click();
    a.remove();
}

// ─────────────────────────────────────────────
// MANEJADORES DE ACCIONES
// ─────────────────────────────────────────────

async function handleSaveReservation() {
    if (!isCabinAvailable(wiz.cabinId, wiz.checkIn, wiz.checkOut)) {
        showToast('⚠ Esa cabaña ya no está disponible en esas fechas', 'err');
        wiz.step = 1; wiz.cabinId = null; renderWizard(); return;
    }

    const btn = document.querySelector('[data-act="save-res"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }

    try {
        const created = await apiFetch('/reservas', {
            method: 'POST',
            body: JSON.stringify({
                cabinId:   wiz.cabinId,
                checkIn:   wiz.checkIn,
                checkOut:  wiz.checkOut,
                guestName: wiz.name.trim(),
                phone:     wiz.phone.trim(),
                guests:    wiz.guests,
                notes:     wiz.notes.trim(),
            }),
        });
        const reservation = normalizeReservation(created);
        state.reservations.push(reservation);
        state.lastSaved = reservation;
        wiz.step = 4;
        renderWizard();
        showToast(`✅ Reserva guardada: ${getCabin(reservation.cabinId).nombre}`);
    } catch (err) {
        showToast(`⚠ ${err.message}`, 'err');
        if (btn) { btn.disabled = false; btn.textContent = '✅ Guardar reserva'; }
    }
}

async function handleCancelReservation(id) {
    const r = getReservationById(id);
    if (!r) return;
    askConfirm('Cancelar reserva',
        `¿Seguro que desea cancelar la reserva de <b>${escapeHTML(r.guestName)}</b> en <b>${getCabin(r.cabinId).nombre}</b>?`,
        'Sí, cancelar',
        async () => {
            try {
                await apiFetch(`/reservas/${id}`, { method: 'DELETE' });
                const idx = state.reservations.findIndex(x => x.id === id);
                if (idx !== -1) state.reservations[idx].estado = 'cancelada';
                renderAll();
                showToast('🗑 Reserva cancelada');
            } catch (err) {
                showToast(`⚠ ${err.message}`, 'err');
            }
        }
    );
}

async function handleConfirmarNotif(reservaId, notifId) {
    askConfirm('Confirmar reserva', '¿Confirmar esta reserva del bot?', 'Sí, confirmar', async () => {
        try {
            await apiFetch(`/reservas/${reservaId}`, {
                method: 'PATCH',
                body: JSON.stringify({ estado: 'confirmada', confirmadaPor: 'admin' }),
            });
            // Actualizar localmente
            const idx = state.reservations.findIndex(r => r.id === reservaId);
            if (idx !== -1) state.reservations[idx].estado = 'confirmada';
            state.notifications = state.notifications.filter(n => n.id !== parseInt(notifId));
            renderAll();
            showToast('✅ Reserva confirmada');
        } catch (err) {
            showToast(`⚠ ${err.message}`, 'err');
        }
    });
}

async function handleRechazarNotif(reservaId, notifId) {
    askConfirm('Rechazar solicitud', '¿Rechazar y cancelar esta solicitud del bot?', 'Sí, rechazar', async () => {
        try {
            await apiFetch(`/reservas/${reservaId}`, {
                method: 'PATCH',
                body: JSON.stringify({ estado: 'cancelada' }),
            });
            const idx = state.reservations.findIndex(r => r.id === reservaId);
            if (idx !== -1) state.reservations[idx].estado = 'cancelada';
            state.notifications = state.notifications.filter(n => n.id !== parseInt(notifId));
            renderAll();
            showToast('❌ Solicitud rechazada');
        } catch (err) {
            showToast(`⚠ ${err.message}`, 'err');
        }
    });
}

function handleFontSize(action) {
    const stored = localStorage.getItem(LS_FS);
    const idx = stored == null ? 1 : Number(stored);
    const next = action === 'fs-up' ? Math.min(2, idx + 1) : Math.max(0, idx - 1);
    localStorage.setItem(LS_FS, next);
    document.documentElement.style.fontSize = ['17px', '19px', '22px'][next];
    showToast(`Tamaño de letra: ${next === 0 ? 'pequeño' : next === 1 ? 'normal' : 'grande'}`);
}

function handleCalendarChip() {
    if (state.gcal) {
        askConfirm('Google Calendar', 'Su calendario está conectado. ¿Desea desconectarlo?', 'Desconectar', () => {
            state.gcal = false;
            localStorage.setItem(LS_GC, '0');
            renderGoogleChip();
            showToast('Google Calendar desconectado');
        });
        return;
    }
    openModal(`
      <button class="x" data-act="close-modal">✕</button>
      <h3>📅 Conectar Google Calendar</h3>
      <p style="font-weight:700;margin-bottom:1rem">Conecte su cuenta de Google para enviar reservas a su calendario.</p>
      <div id="gc-body">
        <button class="btn primary" data-act="connect-go" style="width:100%">🔗 Conectar con Google</button>
        <p class="muted" style="margin-top:.8rem;font-size:.85rem">También puede agregar cada reserva manualmente.</p>
      </div>`);
}

function handleConnectGoogle() {
    const body = document.getElementById('gc-body');
    if (!body) return;
    body.innerHTML = '<div class="spinner"></div><p style="text-align:center;font-weight:900">Conectando…</p>';
    setTimeout(() => {
        state.gcal = true;
        localStorage.setItem(LS_GC, '1');
        renderGoogleChip();
        closeModal();
        showToast('✅ Google Calendar conectado');
    }, 1600);
}

function handleQuickReserve(cabinId, date) {
    wiz = { ...createNewWizard(), step: 2, cabinId: Number(cabinId), checkIn: date, checkOut: addDaysISO(date, 1) };
    setView('nueva');
    showToast(`🏡 ${getCabin(wiz.cabinId).nombre} · ${formatShortDate(wiz.checkIn)} — complete los datos del huésped`);
}

function handleWizardNextStep() {
    if (!wiz.name.trim()) { showToast('⚠ Escriba el nombre del huésped', 'err'); return; }
    if (!wiz.phone.trim()) { showToast('⚠ Escriba el teléfono del huésped', 'err'); return; }
    wiz.step = 3;
    renderWizard();
}

function handleGcalAction(action, id) {
    const r = action === 'gcal-add' && state.lastSaved ? state.lastSaved : getReservationById(id);
    if (!r) return;
    window.open(getGoogleCalendarUrl(r), '_blank');
    showToast('Abriendo Google Calendar…');
}

function handleICS(id) {
    const r = getReservationById(id) || (state.lastSaved?.id === id ? state.lastSaved : null);
    if (!r) return;
    downloadICS(r);
    showToast('⬇ Recordatorio descargado');
}

function changeCalendarMonth(delta) {
    state.calM += delta;
    if (state.calM < 0)  { state.calM = 11; state.calY--; }
    if (state.calM > 11) { state.calM = 0;  state.calY++; }
    renderCalendar();
}

// ─────────────────────────────────────────────
// EVENT LISTENERS
// ─────────────────────────────────────────────

const modalRoot = document.getElementById('modal-root');

function handleGlobalClick(event) {
    const btn = event.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;

    switch (act) {
        case 'overlay':       if (event.target === btn) closeModal(); break;
        case 'close-modal':   closeModal(); break;
        case 'confirm-ok':    closeModal(); if (confirmCallback) confirmCallback(); confirmCallback = null; break;
        case 'nav':           setView(btn.dataset.view); break;
        case 'fs-down':
        case 'fs-up':         handleFontSize(act); break;
        case 'gcal-chip':     handleCalendarChip(); break;
        case 'connect-go':    handleConnectGoogle(); break;
        case 'quick-res':     handleQuickReserve(btn.dataset.cabin, btn.dataset.date); break;
        case 'pick-cabin':    wiz.cabinId = Number(btn.dataset.id); renderWizardCabins(); break;
        case 'wiz-next1':     if (wiz.cabinId) { wiz.step = 2; renderWizard(); } break;
        case 'wiz-back1':     wiz.step = 1; renderWizard(); break;
        case 'wiz-back2':     wiz.step = 2; renderWizard(); break;
        case 'wiz-next2':     handleWizardNextStep(); break;
        case 'save-res':      handleSaveReservation(); break;
        case 'reset-wiz':     wiz = createNewWizard(); renderWizard(); break;
        case 'gcal-add':
        case 'gcal-open':     handleGcalAction(act, btn.dataset.id); break;
        case 'ics':           handleICS(btn.dataset.id); break;
        case 'cancel-res':    handleCancelReservation(btn.dataset.id); break;
        case 'confirmar-notif': handleConfirmarNotif(btn.dataset.reserva, btn.dataset.notif); break;
        case 'rechazar-notif':  handleRechazarNotif(btn.dataset.reserva, btn.dataset.notif); break;
        case 'filter':        state.filter = btn.dataset.f; renderReservations(); break;
        case 'cal-prev':      changeCalendarMonth(-1); break;
        case 'cal-next':      changeCalendarMonth(1); break;
        case 'cal-today':     state.calY = new Date().getFullYear(); state.calM = new Date().getMonth(); renderCalendar(); break;
        case 'day':           openDayModal(btn.dataset.date); break;
    }
}

function handleInputChange(event) {
    const field = event.target.dataset.field;
    if (!field) return;
    switch (field) {
        case 'search': state.search = event.target.value; renderReservationList(); break;
        case 'name':   wiz.name  = event.target.value; break;
        case 'phone':  wiz.phone = event.target.value; break;
        case 'notes':  wiz.notes = event.target.value; break;
        case 'guests': wiz.guests = Number(event.target.value); break;
    }
}

function handleFieldChange(event) {
    const field = event.target.dataset.field;
    if (!field) return;
    if (field === 'in') {
        wiz.checkIn  = event.target.value || todayISO();
        if (wiz.checkOut <= wiz.checkIn) wiz.checkOut = addDaysISO(wiz.checkIn, 1);
        wiz.cabinId = null; renderWizard();
    }
    if (field === 'out') {
        wiz.checkOut = event.target.value || addDaysISO(wiz.checkIn, 1);
        if (wiz.checkOut <= wiz.checkIn) wiz.checkOut = addDaysISO(wiz.checkIn, 1);
        wiz.cabinId = null; renderWizard();
    }
}

document.addEventListener('click', handleGlobalClick);
document.addEventListener('input', handleInputChange);
document.addEventListener('change', handleFieldChange);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// ─────────────────────────────────────────────
// INICIALIZACIÓN
// ─────────────────────────────────────────────

async function init() {
    // Tamaño de letra guardado
    const storedFs = localStorage.getItem(LS_FS);
    document.documentElement.style.fontSize = ['17px', '19px', '22px'][storedFs == null ? 1 : Number(storedFs)];

    // Mostrar pantalla de carga
    document.getElementById('view-inicio').innerHTML = `
      <div style="text-align:center;padding:4rem 1rem">
        <div class="spinner"></div>
        <p style="font-weight:900;color:var(--muted)">Cargando datos…</p>
      </div>`;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === 'inicio'));
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-inicio'));

    try {
        await Promise.all([loadCabins(), loadReservations(), loadNotifications()]);
    } catch (err) {
        document.getElementById('view-inicio').innerHTML = `
          <div class="card" style="text-align:center;padding:3rem;color:var(--red)">
            <div style="font-size:3rem">❌</div>
            <h2 style="justify-content:center">Error de conexión</h2>
            <p style="font-weight:700">${escapeHTML(err.message)}</p>
            <p class="muted" style="margin-top:.5rem">Verifica que el servidor esté corriendo con <code>npm start</code></p>
          </div>`;
        return;
    }

    renderGoogleChip();
    setView('inicio');
    updateNotifBadge();

    // Recargar notificaciones cada 30 segundos
    setInterval(async () => {
        try {
            await loadNotifications();
            updateNotifBadge();
            if (state.view === 'pendientes') renderPendientes();
        } catch { /* silencioso */ }
    }, 30000);
}

init();
