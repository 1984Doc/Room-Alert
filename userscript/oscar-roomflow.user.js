// ==UserScript==
// @name         Oscar RoomFlow (Save & Load / Save & Clean)
// @namespace    roomflow
// @version      2.5.0
// @description  Physician: splits the billing Save button into Save & Load / Save & Clean. Reception: shows room tasks on the schedule screen. Rooms are read from the Oscar schedule page; no database access.
// @match        *://*/oscar*/*
// @include      /^https?:\/\/[^\/]+\/oscar[^\/]*\//
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      YOUR-SERVER-HOSTNAME-OR-IP
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // CONFIG — edit these (and the @match / @connect lines above)
  // ---------------------------------------------------------------------------
  const SERVER_URL = 'http://YOUR-SERVER-HOSTNAME-OR-IP:8765'; // no trailing slash; must match @connect above
  const API_TOKEN = 'CHANGE_ME';  // <-- paste the api_token value from config.toml here
  const POLL_MS = 3000;

  // Which appointment statuses count as rooms, by the name shown on the schedule
  // (the status description set in Administration > Schedule Management > Appointment Status).
  // A room is any status whose name ends in a number: "Smith 1", "Jones 2", "Room 3".
  // To accept EVERY custom status instead, set: const ROOM_TITLE_INCLUDE = null;
  const ROOM_TITLE_INCLUDE = /\s\d+$/;
  const ROOM_TITLE_EXCLUDE = /\b(to ?do|day ?sheet|here|picked|empty|no ?show|cancel+ed|billed|unbilled|confirmed|signed|verified)\b/i;

  // How long a room sighting stays usable (a patient isn't in a room for 12 h).
  const ROOM_CACHE_MAX_AGE_MS = 12 * 3600 * 1000;

  // Ontario billing pages. Any page under /billing/CA/ON/ (or billing.do) that has a
  // button labelled exactly "Save" gets it split — normally the review page
  //   OSCAR 19:  /billing/CA/ON/billingONReview.jsp
  //   Carlos:    /billing/CA/ON/ViewBillingONReview
  // Bill-correction pages are left alone.
  const BILLING_PATH_RE = /\/billing(\/CA\/ON\/|\.do)/i;
  const BILLING_EXCLUDE_RE = /correction/i;
  const SAVE_BUTTON_RE = /^\s*save\s*$/i;

  // Schedule (day view) pages.
  //   OSCAR 19 / Open-O:  /provider/providercontrol.jsp, /provider/appointmentprovideradminday.jsp
  //   Carlos:             /provider/providercontrol, /provider/ViewAppointmentAdminDay
  const SCHEDULE_PATH_RE = /\/provider\/(providercontrol(\.jsp)?|appointmentprovideradminday\.jsp|ViewAppointmentAdminDay)$/i;

  const ACTIONS = {
    load: { label: 'Save & Load', short: 'LOAD', verb: 'Load next patient', bg: '#1f7a3a' },
    clean: { label: 'Save & Clean', short: 'CLEAN & LOAD', verb: 'Clean room, then load', bg: '#b45309' },
  };

  // ---------------------------------------------------------------------------
  // Role / name settings (Tampermonkey menu)
  // ---------------------------------------------------------------------------
  const getRole = () => GM_getValue('roomflow_role', 'none'); // 'physician' | 'receptionist' | 'none'
  const getName = () => GM_getValue('roomflow_name', '');

  GM_registerMenuCommand('RoomFlow role: Physician', () => { GM_setValue('roomflow_role', 'physician'); location.reload(); });
  GM_registerMenuCommand('RoomFlow role: Receptionist', () => { GM_setValue('roomflow_role', 'receptionist'); location.reload(); });
  GM_registerMenuCommand('RoomFlow role: Off', () => { GM_setValue('roomflow_role', 'none'); location.reload(); });
  GM_registerMenuCommand('RoomFlow: set my name (reception)', () => {
    const n = prompt('Name shown when you acknowledge a task:', getName());
    if (n !== null) GM_setValue('roomflow_name', n.trim().slice(0, 40));
  });
  GM_registerMenuCommand('RoomFlow: diagnose this page', () => {
    const btns = [...document.querySelectorAll('input[type=submit], input[type=button], button')]
      .map((b) => (b.tagName === 'INPUT' ? b.value : b.textContent).trim()).filter(Boolean);
    let rooms = {};
    try { rooms = JSON.parse(GM_getValue('roomflow_rooms', '{}')); } catch (_) {}
    const apptInput = document.querySelector('input[name="appointment_no"]');
    alert([
      'RoomFlow diagnostics (v' + GM_info.script.version + ')',
      '',
      'Role: ' + getRole(),
      'Page path: ' + location.pathname,
      'Billing page? ' + (BILLING_PATH_RE.test(location.pathname) && !BILLING_EXCLUDE_RE.test(location.pathname) ? 'YES' : 'no'),
      'Schedule page? ' + (isSchedulePage() ? 'YES' : 'no'),
      'Appointments on page: ' + findAppts().length,
      'Statuses on this page: ' + (findAppts().slice(0, 12)
        .map((x) => '#' + x.appt + ' ' + (x.title || '(blank)') + ' ' + (x.color || 'no colour') + (isRoomTitle(x.title) ? ' = ROOM' : ' = not a room')).join('\n   ') || '(none)'),
      'This appointment remembered as: ' + (function () {
        const n = (document.querySelector('input[name="appointment_no"]') || {}).value;
        return n ? (rooms[n] ? rooms[n].n + ' ' + (rooms[n].c || '') : 'NOTHING remembered for #' + n) : '(not a billing page)';
      })(),
      'appointment_no on page: ' + (apptInput ? apptInput.value : '(none)'),
      'Rooms remembered: ' + Object.keys(rooms).length +
        (Object.keys(rooms).length ? ' — e.g. ' + Object.values(rooms).slice(0, 3).map((r) => r.n).join(', ') : ''),
      'Buttons: ' + (btns.length ? btns.join(' | ') : '(none)'),
      'In a frame? ' + (window.top !== window ? 'yes' : 'no'),
    ].join('\n'));
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function api(method, path, body, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: SERVER_URL + path,
        headers: { 'Content-Type': 'application/json', 'X-RoomFlow-Token': API_TOKEN },
        data: body ? JSON.stringify(body) : undefined,
        timeout: timeoutMs,
        onload: (r) => {
          if (r.status >= 200 && r.status < 300) {
            try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(e); }
          } else reject(new Error('HTTP ' + r.status));
        },
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  function toHex(c) {
    if (!c) return null;
    c = c.trim();
    const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(c);
    if (m) return '#' + [m[1], m[2], m[3]].map((x) => (+x).toString(16).padStart(2, '0')).join('');
    if (/^#[0-9a-f]{3}$/i.test(c)) return '#' + c.slice(1).split('').map((x) => x + x).join('');
    return c;
  }

  function textColorFor(bg) {
    const m = /^#([0-9a-f]{6})$/i.exec(toHex(bg) || '');
    if (!m) return '#111';
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#111' : '#fff';
  }

  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'style') Object.assign(e.style, v);
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const k of kids) e.append(k);
    return e;
  }

  const isRoomTitle = (t) => !!t && (!ROOM_TITLE_INCLUDE || ROOM_TITLE_INCLUDE.test(t)) && !ROOM_TITLE_EXCLUDE.test(t);

  // ===========================================================================
  // ROOM CACHE — read straight off the Oscar schedule page
  //
  // Each appointment on the day view is a <td class="appt"> whose bgcolor is the
  // appointment-status colour. Inside it, <a class="apptStatus" title="Room 3">
  // carries the status name, and its links contain appointment_no=NNNN.
  // Every time a schedule page is shown, we remember the last ROOM status seen
  // for each appointment. When Oscar later flips it to Billed, the remembered
  // room is still there.
  // ===========================================================================
  function loadCache() {
    try { return JSON.parse(GM_getValue('roomflow_rooms', '{}')); } catch (_) { return {}; }
  }
  function saveCache(cache) {
    const cutoff = Date.now() - ROOM_CACHE_MAX_AGE_MS;
    for (const k of Object.keys(cache)) if (cache[k].t < cutoff) delete cache[k];
    GM_setValue('roomflow_rooms', JSON.stringify(cache));
  }

  // Every appointment shown on the page, read from its own status link:
  //   <a class="apptStatus" onclick="refreshSameLoc('providercontrol.jsp?appointment_no=12345&...')" title="Smith 2 ">
  //     <img src="/oscar/images/empty.gif" title="Smith 2"></a>
  // The appointment number, the status name and the colour all come from that one
  // link and its nearest coloured container, so it doesn't matter how Oscar lays out
  // the cells or how many appointments share one table cell.
  function cleanTitle(t) { return (t || '').replace(/\s+/g, ' ').trim(); }

  function statusTitleOf(a) {
    const img = a.querySelector('img');
    return cleanTitle(a.getAttribute('title') || (img && (img.getAttribute('title') || img.getAttribute('alt'))));
  }

  // Background colour behind an element: first ancestor with a bgcolor attribute,
  // inline background or computed background that isn't transparent.
  function colorBehind(node) {
    for (let el = node && node.parentElement, i = 0; el && i < 8; el = el.parentElement, i++) {
      const c = el.getAttribute('bgcolor') || el.style.backgroundColor || getComputedStyle(el).backgroundColor;
      if (c && !/^(transparent|rgba\(0,\s*0,\s*0,\s*0\)|initial|inherit)$/i.test(c.trim())) return toHex(c);
    }
    return null;
  }

  function findAppts() {
    const out = new Map(); // appointment_no -> { appt, title, color }
    document.querySelectorAll('a.apptStatus').forEach((a) => {
      const m = /appointment_no=(\d+)/.exec((a.getAttribute('onclick') || '') + ' ' + (a.getAttribute('href') || ''));
      if (!m || out.has(m[1])) return;
      out.set(m[1], { appt: m[1], title: statusTitleOf(a), color: colorBehind(a) });
    });
    // Fallback for any appointment cell without a status link.
    document.querySelectorAll('td.appt').forEach((td) => {
      const m = /appointment_no=(\d+)/.exec(td.innerHTML);
      if (!m || out.has(m[1])) return;
      const img = td.querySelector('img[title], img[alt]');
      out.set(m[1], { appt: m[1], title: cleanTitle(img && (img.getAttribute('title') || img.getAttribute('alt'))), color: colorBehind(td.firstElementChild || td) });
    });
    return [...out.values()];
  }

  function isSchedulePage() {
    return SCHEDULE_PATH_RE.test(location.pathname) ||
           !!document.querySelector('a.apptStatus, td.appt');
  }

  function scanSchedule() {
    const appts = findAppts();
    if (!appts.length) return 0;
    const cache = loadCache();
    const now = Date.now();
    let found = 0;
    for (const { appt, title, color } of appts) {
      if (!isRoomTitle(title)) continue; // Here, Billed, etc. don't overwrite the last room seen
      cache[appt] = { n: title, c: color, t: now };
      found++;
    }
    if (found) saveCache(cache);
    return found;
  }

  function watchSchedule() {
    if (!isSchedulePage()) return;
    scanSchedule();
    let pending = null;
    new MutationObserver(() => {
      clearTimeout(pending);
      pending = setTimeout(scanSchedule, 300);
    }).observe(document.body, { childList: true, subtree: true });
    // Capture the room at the exact moment a billing / encounter link is clicked.
    document.addEventListener('mousedown', scanSchedule, true);
    setInterval(scanSchedule, 15000);
  }

  // ===========================================================================
  // PHYSICIAN — billing review page
  // ===========================================================================
  function findAppointmentNo() {
    // The review page echoes every incoming request parameter as a hidden input.
    for (const k of ['appointment_no', 'appointmentNo']) {
      const inp = document.querySelector(`input[name="${k}"]`);
      if (inp && /^\d+$/.test(inp.value)) return inp.value;
    }
    const qs = new URLSearchParams(location.search);
    for (const k of ['appointment_no', 'appointmentNo']) {
      if (/^\d+$/.test(qs.get(k) || '')) return qs.get(k);
    }
    return null;
  }

  function buttonLabel(b) {
    return (b.tagName === 'INPUT' ? b.value : b.textContent) || '';
  }

  function toast(msg, ok = true) {
    const t = el('div', {
      style: {
        position: 'fixed', top: '12px', right: '12px', zIndex: 999999,
        padding: '10px 14px', borderRadius: '6px', font: '14px/1.3 sans-serif',
        background: ok ? '#1f7a3a' : '#b91c1c', color: '#fff', boxShadow: '0 2px 8px rgba(0,0,0,.3)',
      },
    }, msg);
    document.body.append(t);
    setTimeout(() => t.remove(), 4000);
  }

  function splitSaveButton(orig) {
    if (orig.dataset.roomflow) return;
    orig.dataset.roomflow = '1';

    const wrap = el('span', { style: { display: 'inline-flex', gap: '6px', margin: '0 4px' } });
    let busy = false;

    for (const [key, a] of Object.entries(ACTIONS)) {
      const b = el('button', {
        type: 'button',
        title: `Save the bill and tell reception: ${a.verb}`,
        style: {
          background: a.bg, color: '#fff', border: 'none', borderRadius: '4px',
          padding: '6px 12px', cursor: 'pointer', font: 'bold 13px sans-serif',
        },
        onclick: async (ev) => {
          ev.preventDefault();
          if (busy) return;
          busy = true;
          wrap.querySelectorAll('button').forEach((x) => (x.disabled = true));

          const appt = findAppointmentNo();
          const seen = appt ? loadCache()[appt] : null;
          try {
            const res = await api('POST', '/api/notify', {
              action: key,
              appointment_no: appt,
              room_name: seen ? seen.n : null,
              room_color: seen ? seen.c : null,
              room_seen_at: seen ? seen.t / 1000 : null,
            }, 2500);
            toast(`Reception notified: ${res.task.room_name || 'room from their schedule'} — ${a.short}`);
          } catch (e) {
            alert('RoomFlow: reception was NOT notified (' + e.message + ').\nThe bill will still save — please tell the front desk.');
          }
          // Hand off to Oscar's own Save (its normal validation + submit, unchanged).
          orig.click();
          setTimeout(() => { busy = false; wrap.querySelectorAll('button').forEach((x) => (x.disabled = false)); }, 1500);
        },
      }, a.label);
      wrap.append(b);
    }

    orig.style.display = 'none';
    orig.after(wrap);
  }

  function isBillingPage() {
    return BILLING_PATH_RE.test(location.pathname) && !BILLING_EXCLUDE_RE.test(location.pathname);
  }

  function initPhysician() {
    watchSchedule();
    if (!isBillingPage()) return;
    const scan = () => {
      document.querySelectorAll('input[type=submit], input[type=button], button').forEach((b) => {
        if (!b.dataset.roomflow && SAVE_BUTTON_RE.test(buttonLabel(b))) splitSaveButton(b);
      });
    };
    scan();
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  }

  // ===========================================================================
  // RECEPTIONIST — schedule page
  // ===========================================================================
  let audioCtx = null;
  function chime() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const now = audioCtx.currentTime;
      [880, 1175].forEach((f, i) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, now + i * 0.18);
        g.gain.exponentialRampToValueAtTime(0.25, now + i * 0.18 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.18 + 0.35);
        o.connect(g).connect(audioCtx.destination);
        o.start(now + i * 0.18);
        o.stop(now + i * 0.18 + 0.4);
      });
    } catch (_) { /* sound is best-effort */ }
  }

  // Cross-compare: the physician's sighting vs this screen's own sighting of the
  // same appointment. Whichever saw the room most recently wins.
  function resolveRoom(t, cache) {
    const fromDoc = t.room_name ? { n: t.room_name, c: t.room_color, t: (t.room_seen_at || 0) * 1000, src: 'doc' } : null;
    const mine = t.appointment_no && cache[t.appointment_no] ? { ...cache[t.appointment_no], src: 'desk' } : null;
    if (fromDoc && mine) return mine.t >= fromDoc.t ? mine : fromDoc;
    return mine || fromDoc || null;
  }

  function initReceptionist() {
    if (!isSchedulePage()) return;
    watchSchedule();
    if (window.top !== window) return; // one panel per window

    const seen = new Set(JSON.parse(GM_getValue('roomflow_seen', '[]')));
    const baseTitle = document.title;

    const list = el('div');
    const status = el('span', { style: { fontWeight: 'normal', fontSize: '11px', opacity: '.8' } });
    const soundBtn = el('button', {
      type: 'button',
      style: { display: 'none', marginLeft: '6px', fontSize: '11px', cursor: 'pointer' },
      onclick: () => { chime(); soundBtn.style.display = 'none'; },
    }, 'enable sound');

    const panel = el('div', {
      id: 'roomflow-panel',
      style: {
        position: 'fixed', right: '10px', bottom: '10px', width: '280px', maxHeight: '70vh',
        overflowY: 'auto', zIndex: 999999, background: '#fff', border: '1px solid #999',
        borderRadius: '8px', boxShadow: '0 4px 16px rgba(0,0,0,.25)', font: '13px/1.3 sans-serif',
      },
    },
      el('div', {
        style: { padding: '6px 10px', background: '#333', color: '#fff', fontWeight: 'bold',
          borderRadius: '8px 8px 0 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
      }, el('span', {}, 'Rooms ', soundBtn), status),
      list,
    );
    document.body.append(panel);

    function ago(ts, now) {
      const m = Math.floor((now - ts) / 60);
      return m < 1 ? 'just now' : `${m} min ago`;
    }

    function render(data) {
      const cache = loadCache();
      list.innerHTML = '';
      const open = data.tasks.filter((t) => !t.acked_at);
      document.title = open.length ? `(${open.length}) ${baseTitle}` : baseTitle;
      if (!data.tasks.length) {
        list.append(el('div', { style: { padding: '10px', color: '#666' } }, 'No room tasks'));
        return;
      }
      for (const t of data.tasks) {
        const a = ACTIONS[t.action] || { short: t.action.toUpperCase(), bg: '#555' };
        const room = resolveRoom(t, cache);
        const roomBg = (room && room.c) || '#ddd';
        const done = !!t.acked_at;
        const card = el('div', {
          style: { margin: '8px', border: '1px solid #ccc', borderRadius: '6px', overflow: 'hidden', opacity: done ? '.5' : '1' },
        },
          el('div', {
            style: { background: roomBg, color: textColorFor(roomBg), padding: '8px 10px', fontSize: '16px', fontWeight: 'bold' },
          }, room ? room.n : 'Room not identified — check schedule'),
          el('div', { style: { padding: '6px 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            el('span', {},
              el('span', { style: { background: a.bg, color: '#fff', padding: '2px 6px', borderRadius: '3px', fontWeight: 'bold' } }, a.short),
              el('span', { style: { color: '#666', marginLeft: '6px', fontSize: '11px' } }, ago(t.created_at, data.now)),
            ),
            done
              ? el('span', { style: { fontSize: '11px', color: '#444' } }, `✓ ${t.acked_by || ''}`)
              : el('button', {
                  type: 'button',
                  style: { cursor: 'pointer', padding: '4px 10px', fontWeight: 'bold' },
                  onclick: async (ev) => {
                    ev.target.disabled = true;
                    try { await api('POST', `/api/tasks/${t.id}/ack`, { by: getName() || 'Reception' }); poll(); }
                    catch (e) { ev.target.disabled = false; alert('RoomFlow: could not acknowledge (' + e.message + ')'); }
                  },
                }, 'Got it'),
          ),
        );
        list.append(card);
      }
    }

    async function poll() {
      try {
        const data = await api('GET', '/api/tasks');
        status.textContent = '';
        let fresh = false;
        for (const t of data.tasks) {
          const key = `${t.id}:${t.action}`;
          if (!t.acked_at && !seen.has(key)) { seen.add(key); fresh = true; }
        }
        if (fresh) {
          GM_setValue('roomflow_seen', JSON.stringify([...seen].slice(-200)));
          chime();
          if (audioCtx && audioCtx.state === 'suspended') soundBtn.style.display = 'inline';
        }
        render(data);
      } catch (e) {
        status.textContent = 'offline';
      }
    }

    poll();
    setInterval(poll, POLL_MS);
  }

  // ---------------------------------------------------------------------------
  const role = getRole();
  if (role === 'physician') initPhysician();
  else if (role === 'receptionist') initReceptionist();
})();
