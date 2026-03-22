const CACHE_NAME = 'pomodoro-v27';
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
    ).then(() => { checkStoredTimer(); checkStoredNags(); })
  );
  self.clients.claim();
});

// ── Fetch: cache-first for app assets, stale-while-revalidate for fonts & Firebase SDK ──
self.addEventListener('fetch', e => {
  // Piggyback: check stored timer on every fetch (any network activity = SW wakeup)
  checkStoredTimer();
  checkStoredNags();

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
    clearNagTimeout();
    idbClearNags();
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
    const data = await idbLoadNags();
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
  if (tag === 'loc-tracking' || tag === 'idle-nag') {
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

  // FCM push notifications (nudge, push-cascade, fcm-push, etc.) — focus/open app
  if (tag === 'nudge' || tag === 'push-cascade' || tag === 'fcm-push') {
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

  // FCM wraps custom data in a 'data' field
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
    })
  );
});
