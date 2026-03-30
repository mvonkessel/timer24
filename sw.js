const CACHE_NAME = 'pomodoro-v64';
const ASSETS = ['./index.html', './manifest.json', './icon-192.png', './icon-512.png'];

// ── Install: cache all assets for offline use ──
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// ── Activate: clean old caches + check stored timer ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => { checkStoredTimer(); checkStoredNags(); checkStoredBreak(); })
  );
  self.clients.claim();
});

// ── Fetch: cache-first for app assets, stale-while-revalidate for fonts & Firebase SDK ──
self.addEventListener('fetch', e => {
  // Piggyback: check stored timers on every fetch (any network activity = SW wakeup)
  // Firebase RTDB long-polling keeps triggering fetches in background — this is the
  // primary mechanism that makes timer/break/nag alarms work reliably.
  // Gen guards prevent false alarms on foreground page loads.
  checkStoredTimer();
  checkStoredNags();
  checkStoredBreak();

  const url = new URL(e.request.url);

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com' || url.hostname === 'www.gstatic.com') {
    e.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(e.request).then(cached => {
          const fetching = fetch(e.request).then(response => {
            if (response.ok) cache.put(e.request, response.clone());
            return response;
          }).catch(() => cached);
          return cached || fetching;
        })
      )
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});

// ── Timer state ──
let alarmTimeout = null;
let checkInterval = null;
let timerState = null;
let alarmActive = false;
let _timerGen = 0; // incremented on every timer lifecycle event to detect stale async reads

// ── IndexedDB persistence ──
// Stores timer state so if SW is killed & restarted, it can recover
const IDB_NAME = 'pomo-sw';
const IDB_STORE = 'timer';

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSave(state) {
  try {
    const db = await idbOpen();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(state, 'current');
    db.close();
  } catch (e) {}
}

async function idbClear() {
  try {
    const db = await idbOpen();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete('current');
    db.close();
  } catch (e) {}
}

async function idbLoad() {
  try {
    const db = await idbOpen();
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get('current');
      req.onsuccess = () => { db.close(); resolve(req.result || null); };
      req.onerror = () => { db.close(); resolve(null); };
    });
  } catch (e) { return null; }
}

// Check if stored timer has expired (called on any SW wake-up)
let _checking = false;
async function checkStoredTimer() {
  if (alarmActive || _checking) return;
  _checking = true;
  try {
    const gen = _timerGen;
    const state = await idbLoad();
    if (!state || !state.endTime) { _checking = false; return; }
    // If any timer lifecycle event (START/CANCEL/STOP) occurred during our
    // async idbLoad, the data is stale — abort to avoid firing wrong alarm.
    if (_timerGen !== gen || alarmActive) { _checking = false; return; }
    if (Date.now() >= state.endTime) {
      timerState = state;
      _checking = false;
      fireAlarm(state.task, state.duration);
    } else if (!alarmTimeout) {
      timerState = state;
      const ms = state.endTime - Date.now();
      alarmTimeout = setTimeout(() => fireAlarm(state.task, state.duration), ms);
      if (!checkInterval) {
        checkInterval = setInterval(() => {
          if (timerState && Date.now() >= timerState.endTime) {
            clearInterval(checkInterval);
            checkInterval = null;
            fireAlarm(timerState.task, timerState.duration);
          }
        }, 3000);
      }
      _checking = false;
    } else {
      _checking = false;
    }
  } catch (e) {
    _checking = false;
  }
}


function clearTimers() {
  clearTimeout(alarmTimeout);
  clearInterval(checkInterval);
  alarmTimeout = null;
  checkInterval = null;
}


// ── Message handling ──
self.addEventListener('message', e => {
  const data = e.data;

  if (data.type === 'START_TIMER') {
    clearTimers();
    clearNagTimeout();idbClearNags();
    clearTimeout(_breakTimeout);_breakTimeout=null;clearInterval(_breakCheckInterval);_breakCheckInterval=null;idbClearBreak();
    alarmActive = false;
    _timerGen++;
    timerState = { task: data.task, duration: data.duration, endTime: data.endTime };
    idbSave(timerState);
    const ms = data.endTime - Date.now();
    if (ms > 0) {
      alarmTimeout = setTimeout(() => fireAlarm(data.task, data.duration), ms);
      // Adaptive check: faster near end, slower otherwise
      checkInterval = setInterval(() => {
        if (timerState && Date.now() >= timerState.endTime) {
          clearInterval(checkInterval);
          checkInterval = null;
          fireAlarm(timerState.task, timerState.duration);
        }
      }, ms < 30000 ? 1000 : 3000);
    } else {
      fireAlarm(data.task, data.duration);
    }
  }

  if (data.type === 'CANCEL_TIMER') {
    clearTimers();
    clearNagTimeout();idbClearNags();
    alarmActive = false;
    _timerGen++;
    timerState = null;
    idbClear();
    self.registration.getNotifications().then(notifs => notifs.forEach(n => {
      if (n.tag === 'pomodoro-alarm') n.close();
    }));
  }

  if (data.type === 'STOP_ALARM') {
    clearTimers();
    clearInterval(self._alarmRepeat);
    clearNagTimeout();idbClearNags();
    alarmActive = false;
    _timerGen++;
    timerState = null;
    idbClear();
    self.registration.getNotifications().then(notifs => notifs.forEach(n => {
      if (n.tag === 'pomodoro-alarm') n.close();
    }));
  }

  if (data.type === 'HEARTBEAT') {
    if (data.endTime && data.isRunning) {
      const remaining = data.endTime - Date.now();
      if (remaining <= 0) {
        fireAlarm(data.task, data.duration);
      } else if (!alarmTimeout) {
        timerState = { task: data.task, duration: data.duration, endTime: data.endTime };
        idbSave(timerState);
        alarmTimeout = setTimeout(() => fireAlarm(data.task, data.duration), remaining);
        if (!checkInterval) {
          checkInterval = setInterval(() => {
            if (timerState && Date.now() >= timerState.endTime) {
              clearInterval(checkInterval);
              checkInterval = null;
              fireAlarm(timerState.task, timerState.duration);
            }
          }, 5000);
        }
      }
    }
  }


  if (data.type === 'PING') {
    e.source && e.source.postMessage({ type: 'PONG' });
  }

  // ── Background Notification Scheduler (IDB-persistent) ──
  if (data.type === 'SCHEDULE_NAGS') {
    _nagGen++;
    // data: { messages: [{title,body,delay},...], vibrate, tag }
    // Convert relative delays to absolute fireAt timestamps
    let cumulative = Date.now();
    const entries = (data.messages || []).map(m => {
      cumulative += (m.delay || 60000);
      return { title: m.title, body: m.body, fireAt: cumulative };
    });
    const nagData = { entries, vibrate: data.vibrate || [400,80,400,80,400], tag: data.tag || 'idle-nag', nextIndex: 0 };
    idbSaveNags(nagData).then(() => {
      clearNagTimeout();
      scheduleNextNagFromIDB();
    });
  }

  if (data.type === 'STOP_NAGS') {
    _nagGen++;
    clearNagTimeout();
    idbClearNags();
  }

  // ── IDB Break-End Timer (survives SW kill) ──
  if (data.type === 'SCHEDULE_BREAK') {
    _breakGen++;
    // data: { breakEnd: timestamp }
    idbSaveBreak({ breakEnd: data.breakEnd, notified: false }).then(() => {
      clearTimeout(_breakTimeout);
      clearInterval(_breakCheckInterval);
      const ms = Math.max(0, data.breakEnd - Date.now());
      _breakTimeout = setTimeout(() => checkStoredBreak(), ms);
      // Repeating backup check every 5s (catches break end if setTimeout lost)
      _breakCheckInterval = setInterval(() => checkStoredBreak(), 5000);
    });
  }
  if (data.type === 'CLEAR_BREAK') {
    _breakGen++;
    clearTimeout(_breakTimeout); _breakTimeout = null;
    clearInterval(_breakCheckInterval); _breakCheckInterval = null;
    idbClearBreak();
  }

});

// ── IDB Nag Helpers ──
async function idbSaveNags(data) {
  try {
    const db = await idbOpen();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(data, 'nags');
    db.close();
  } catch (e) {}
}

async function idbLoadNags() {
  try {
    const db = await idbOpen();
    return new Promise(resolve => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get('nags');
      req.onsuccess = () => { db.close(); resolve(req.result || null); };
      req.onerror = () => { db.close(); resolve(null); };
    });
  } catch (e) { return null; }
}

async function idbClearNags() {
  try {
    const db = await idbOpen();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete('nags');
    db.close();
  } catch (e) {}
}

// ── Persistent Nag Scheduler ──
let _nagTimeout = null;
let _nagGen = 0; // incremented on SCHEDULE_NAGS/STOP_NAGS to detect stale reads
let _breakTimeout = null;
let _breakCheckInterval = null;
let _breakGen = 0; // incremented on SCHEDULE_BREAK/CLEAR_BREAK to detect stale reads

// ── IDB Break-End Helpers ──
async function idbSaveBreak(data) {
  try { const db = await idbOpen(); const tx = db.transaction(IDB_STORE, 'readwrite'); tx.objectStore(IDB_STORE).put(data, 'break'); db.close(); } catch (e) {}
}
async function idbLoadBreak() {
  try { const db = await idbOpen(); return new Promise(r => { const tx = db.transaction(IDB_STORE, 'readonly'); const req = tx.objectStore(IDB_STORE).get('break'); req.onsuccess = () => { db.close(); r(req.result || null); }; req.onerror = () => { db.close(); r(null); }; }); } catch (e) { return null; }
}
async function idbClearBreak() {
  try { const db = await idbOpen(); const tx = db.transaction(IDB_STORE, 'readwrite'); tx.objectStore(IDB_STORE).delete('break'); db.close(); } catch (e) {}
}

// Called on EVERY SW wake-up: check if break ended
async function checkStoredBreak() {
  try {
    const gen = _breakGen;
    const data = await idbLoadBreak();
    if (_breakGen !== gen) return; // SCHEDULE_BREAK or CLEAR_BREAK arrived during async read → stale
    if (!data || !data.breakEnd) { clearInterval(_breakCheckInterval); _breakCheckInterval = null; return; }
    if (Date.now() >= data.breakEnd) {
      clearInterval(_breakCheckInterval); _breakCheckInterval = null;
      if (!data.notified) {
        data.notified = true;
        await idbSaveBreak(data);
        // Fire break-end notification
        await self.registration.showNotification('\u2615 Pause vorbei!', {
          body: 'N\u00E4chste Pomodoro starten!',
          icon: './icon-192.png',
          badge: './icon-192.png',
          tag: 'idle-nag',
          renotify: true,
          requireInteraction: true,
          vibrate: [500, 60, 500, 60, 500, 60, 800],
          silent: false
        });
      }
      // Clean up break data after 30 min (stale)
      if (Date.now() - data.breakEnd > 1800000) await idbClearBreak();
    } else {
      // Break not ended yet — reschedule check
      clearTimeout(_breakTimeout);
      const ms = Math.max(1000, data.breakEnd - Date.now());
      _breakTimeout = setTimeout(() => checkStoredBreak(), ms);
      // Ensure repeating backup check is running
      if (!_breakCheckInterval) _breakCheckInterval = setInterval(() => checkStoredBreak(), 5000);
    }
  } catch (e) {}
}

function clearNagTimeout() {
  clearTimeout(_nagTimeout);
  _nagTimeout = null;
}

// Called on every SW wakeup — fires any past-due nags, schedules next
let _checkingNags = false;
async function checkStoredNags() {
  if (_checkingNags) return;
  _checkingNags = true;
  try {
    const gen = _nagGen;
    const data = await idbLoadNags();
    if (_nagGen !== gen) { _checkingNags = false; return; } // SCHEDULE_NAGS or STOP_NAGS arrived during read
    if (!data || !data.entries || data.nextIndex >= data.entries.length) {
      _checkingNags = false;
      return;
    }

    const now = Date.now();
    let idx = data.nextIndex;
    let fired = false;

    // Fire all past-due nags
    while (idx < data.entries.length && data.entries[idx].fireAt <= now) {
      const entry = data.entries[idx];
      try {
        await self.registration.showNotification(entry.title, {
          body: entry.body,
          icon: './icon-192.png',
          badge: './icon-192.png',
          tag: data.tag || 'idle-nag',
          renotify: true,
          requireInteraction: true,
          vibrate: data.vibrate || [400,80,400,80,400],
          silent: false
        });
      } catch (e) {}
      idx++;
      fired = true;
    }

    // Update index in IDB
    if (fired) {
      data.nextIndex = idx;
      await idbSaveNags(data);
    }

    // Schedule timeout for next upcoming nag
    if (idx < data.entries.length) {
      clearNagTimeout();
      const delay = Math.max(1000, data.entries[idx].fireAt - Date.now());
      _nagTimeout = setTimeout(() => checkStoredNags(), delay);
    } else {
      // All nags consumed — clean up
      await idbClearNags();
    }
  } finally {
    _checkingNags = false;
  }
}

async function scheduleNextNagFromIDB() {
  await checkStoredNags();
}

async function fireAlarm(task, duration) {
  if (alarmActive) return; // guard against race conditions
  clearTimers();
  clearInterval(self._alarmRepeat); // prevent interval leak from previous call
  self._alarmRepeat = null;
  timerState = null;
  alarmActive = true;
  idbClear();

  try {
    await self.registration.showNotification('Pomodoro fertig!', {
      body: task + ' — ' + duration + ' min abgeschlossen',
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: 'pomodoro-alarm',
      renotify: true,
      requireInteraction: true,
      vibrate: [500,200,500,200,500,200,500,200,500,200,500],
      actions: [{ action: 'stop', title: 'Ausschalten' }],
      silent: false,
      urgency: 'high'
    });
  } catch (err) {
    console.error('Notification error:', err);
  }

  self._alarmRepeat = setInterval(async () => {
    try {
      await self.registration.showNotification('🔔 Pomodoro fertig!', {
        body: task + ' — Zeit ist um!',
        icon: './icon-192.png',
        tag: 'pomodoro-alarm',
        renotify: true,
        requireInteraction: true,
        vibrate: [500,200,500,200,500,200,500],
        actions: [{ action: 'stop', title: 'Ausschalten' }],
        silent: false,
        urgency: 'high'
      });
    } catch (err) {}
  }, 8000);

  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach(client => client.postMessage({ type: 'ALARM_FIRED' }));
}


self.addEventListener('notificationclick', e => {
  const tag = e.notification.tag;
  e.notification.close();

  if (tag === 'pomodoro-alarm') {
    clearInterval(self._alarmRepeat);
    alarmActive = false;
    timerState = null;

    e.waitUntil(
      self.clients.matchAll({ type: 'window' }).then(clients => {
        clients.forEach(c => c.postMessage({ type: 'ALARM_STOPPED' }));
        if (clients.length > 0) {
          clients[0].focus();
        } else {
          self.clients.openWindow('./index.html');
        }
      })
    );
  }

  // Location tracking or idle nag notification — just focus the app
  if (tag === 'loc-tracking' || tag === 'idle-nag' || tag === 'break-alarm') {
    e.waitUntil(
      self.clients.matchAll({ type: 'window' }).then(clients => {
        if (clients.length > 0) {
          clients[0].focus();
        } else {
          self.clients.openWindow('./index.html');
        }
      })
    );
  }

  // FCM push notifications — focus/open app
  if (tag === 'nudge' || tag === 'push-cascade' || tag === 'fcm-push' || tag === 'rabbit-hole' || tag === 'morning-penalty') {
    e.waitUntil(
      self.clients.matchAll({ type: 'window' }).then(clients => {
        if (clients.length > 0) {
          clients[0].focus();
        } else {
          self.clients.openWindow('./index.html');
        }
      })
    );
  }

});

self.addEventListener('notificationclose', e => {
  const tag = e.notification.tag;

  if (tag === 'pomodoro-alarm') {
    if (!alarmActive) return;

    setTimeout(() => {
      if (!alarmActive) return;
      if (!self._alarmRepeat) return;

      clearInterval(self._alarmRepeat);
      self._alarmRepeat = null;
      alarmActive = false;
      timerState = null;

      self.clients.matchAll({ type: 'window' }).then(clients => {
        clients.forEach(c => c.postMessage({ type: 'ALARM_STOPPED' }));
      });
    }, 500);
  }
});

// ── FCM Push Handler ──
// Receives data-only messages from Cloud Functions
self.addEventListener('push', e => {
  if (!e.data) return;
  let payload;
  try { payload = e.data.json(); } catch (err) {
    try { payload = { data: { title: 'Timer7', body: e.data.text() } }; } catch (e2) { return; }
  }

  const d = payload.data || payload.notification || payload;
  const title = d.title || 'Timer7';
  const body = d.body || '';
  const tag = d.tag || 'fcm-push';
  let vibrate = [400, 80, 400, 80, 400];
  try { if (d.vibrate) vibrate = JSON.parse(d.vibrate); } catch (e) {}

  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag,
      renotify: true,
      requireInteraction: true,
      vibrate,
      silent: false
    }).then(() => {
      // FCM push = reliable SW wake-up. Fire any missed IDB nags + check timer + break.
      checkStoredNags();
      checkStoredTimer();
      checkStoredBreak();
    })
  );
});
