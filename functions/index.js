const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

const REGION = 'europe-west1';
const STATUS_PATH = 'status/moritz';

async function sendPush(token, title, body, tag, vibrate) {
  if (!token) return;
  try {
    await admin.messaging().send({
      token,
      data: {
        title: title || 'Timer7',
        body: body || '',
        tag: tag || 'fcm-push',
        vibrate: JSON.stringify(vibrate || [400, 80, 400, 80, 400])
      },
      android: { priority: 'high', ttl: 120000 },
      webpush: { headers: { Urgency: 'high', TTL: '120' } }
    });
  } catch (err) {
    if (err.code === 'messaging/registration-token-not-registered' ||
        err.code === 'messaging/invalid-registration-token') {
      await admin.database().ref(STATUS_PATH + '/fcmToken').remove().catch(() => {});
    }
  }
}

// Current time in minutes since midnight (Europe/Zurich)
function nowMinsCH() {
  const now = new Date();
  const ch = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Zurich' }));
  return ch.getHours() * 60 + ch.getMinutes();
}

// Is current time within the user's awake window?
function isAwakeTime(d) {
  const wake = d.wakeMin ?? 320;   // default 5:20
  const sleep = d.sleepMin ?? 1280; // default 21:20
  const now = nowMinsCH();
  if (wake < sleep) return now >= wake && now < sleep;
  return now >= wake || now < sleep; // crosses midnight
}

// ════════════════════════════════════════════
// 1. Wiebke Nudge
// ════════════════════════════════════════════
exports.onNudge = functions
  .region(REGION)
  .database.instance('pomodoro-status-default-rtdb')
  .ref(STATUS_PATH + '/nudge')
  .onWrite(async (change) => {
    const data = change.after.val();
    if (!data || !data.time) return;
    if (Date.now() - data.time > 60000) return;
    const tokenSnap = await admin.database().ref(STATUS_PATH + '/fcmToken').once('value');
    await sendPush(tokenSnap.val(),
      '\u{1F4E2} ' + (data.from || 'Wiebke') + ' sagt:',
      data.message || 'Fang an!', 'nudge',
      [500, 100, 500, 100, 500, 100, 800]);
  });

// ════════════════════════════════════════════
// 2. Rabbit Hole SOS
// ════════════════════════════════════════════
exports.onRabbitHole = functions
  .region(REGION)
  .database.instance('pomodoro-status-default-rtdb')
  .ref(STATUS_PATH + '/rabbitHole')
  .onWrite(async (change) => {
    const data = change.after.val();
    if (!data || !data.time) return;
    if (Date.now() - data.time > 60000) return;
    const tokenSnap = await admin.database().ref(STATUS_PATH + '/fcmToken').once('value');
    await sendPush(tokenSnap.val(),
      '\u{1F573}\uFE0F RABBIT HOLE!',
      data.message || 'Wiebke hat SOS ausgeloest. SOFORT aufhoeren!',
      'rabbit-hole',
      [800, 100, 800, 100, 800, 100, 800, 100, 1200]);
  });

// ════════════════════════════════════════════
// 3. Scheduled Check — EVERY 1 MINUTE
//    THE primary background mechanism when Chrome kills the tab.
//    Uses timestamp staleness to detect dead app and override state.
// ════════════════════════════════════════════
exports.idleCheck = functions
  .region(REGION)
  .pubsub.schedule('every 1 minutes')
  .timeZone('Europe/Zurich')
  .onRun(async () => {
    const snap = await admin.database().ref(STATUS_PATH).once('value');
    const d = snap.val();
    if (!d || !d.fcmToken) return;
    const token = d.fcmToken;
    const status = d.status || 'offline';
    const ts = d.timestamp || 0;
    const staleMin = (Date.now() - ts) / 60000;
    const appDead = staleMin > 5;
    const appVeryDead = staleMin > 30;
    const awake = isAwakeTime(d);

    // ── SLEEPING ──
    // Only intervene if app is dead AND user should be awake
    if (d.isSleeping) {
      if (appVeryDead && awake) {
        // todayCount in Firebase may be stale from yesterday (app died overnight)
        await sendPush(token,
          '\u2600\uFE0F Aufstehen!',
          'App oeffnen und Tag starten!',
          'morning-penalty',
          [800, 100, 800, 100, 800, 100, 1200]);
      }
      return;
    }

    // ── AT WORK ──
    // Fresh sync: genuinely at work, skip.
    // Dead app: user probably left hours ago. Push.
    if (d.isAtWork) {
      if (!appVeryDead) return;
      if (!awake) return;
      const workMin = d.todayWorkMinutes || 0;
      if ((d.todayCount || 0) === 0 && workMin > 60) {
        await sendPush(token,
          '\u{1F3E5}\u2192\u{1F3E0} Feierabend?',
          'Nach ' + Math.round(workMin / 60) + 'h Arbeit: App oeffnen und Pomodoro starten!',
          'idle-nag', [500, 60, 500, 60, 500, 60, 800]);
      } else {
        await sendPush(token,
          '\u{1F480} App seit ' + Math.round(staleMin) + 'min offline',
          'App oeffnen! Schandzeit laeuft.',
          'idle-nag', [500, 60, 500, 60, 500, 60, 800]);
      }
      return;
    }

    if (status === 'working') {
      if (appVeryDead && awake) {
        await sendPush(token,
          '\u{1F480} App seit ' + Math.round(staleMin) + 'min offline',
          'Arbeit vorbei? App oeffnen!',
          'idle-nag', [400, 80, 400, 80, 400]);
      }
      return;
    }

    // ── TIMER RUNNING ──
    if (status === 'running') {
      if (d.timerEnd && Date.now() > d.timerEnd + 60000) {
        // Timer expired but app never updated → definitely dead
        await sendPush(token,
          '\u{1F514} Timer abgelaufen!',
          'App oeffnen — Alarm verpasst!', 'idle-nag',
          [800, 100, 800, 100, 800, 100, 800]);
      } else if (d.timerEnd && d.timerEnd > Date.now() && appDead) {
        // Timer still running but app hasn't synced in >5min → probably dead
        const remMin = Math.round((d.timerEnd - Date.now()) / 60000);
        await sendPush(token,
          '\u26A0\uFE0F Timer evtl. gestoppt!',
          'App seit ' + Math.round(staleMin) + 'min offline. Noch ' + remMin + 'min \u00FCbrig. App oeffnen!',
          'idle-nag', [400, 80, 400, 80, 400]);
      }
      return;
    }

    // ── PAUSED ──
    if (status === 'paused') {
      if (staleMin >= 10) {
        await sendPush(token,
          '\u23F8 Zu lange pausiert! +' + Math.round(staleMin) + 'm',
          'Fortsetzen oder abbrechen!', 'idle-nag',
          [400, 80, 400, 80, 400]);
      }
      return;
    }

    // ── COMPLETED (reward screen) ──
    if (status === 'completed') {
      if (staleMin >= 3) {
        await sendPush(token,
          '\u2B50 Reward-Screen blockiert',
          'Weiter zur naechsten Pomodoro!', 'idle-nag',
          [400, 80, 400, 80, 400]);
      }
      return;
    }

    // ── BREAK ──
    if (status === 'break') {
      if (d.breakEnd && Date.now() > d.breakEnd) {
        const overMin = Math.round((Date.now() - d.breakEnd) / 60000);
        await sendPush(token,
          overMin > 0 ? '\u{1F480} Pause vorbei! +' + overMin + 'm idle' : '\u2615 Pause vorbei!',
          'Naechste Pomodoro starten!', 'idle-nag',
          [500, 60, 500, 60, 500, 60, 800]);
      } else if (d.breakEnd && d.breakEnd > Date.now() && appDead) {
        // Break active but app stale → alarm may not fire
        const remMin = Math.round((d.breakEnd - Date.now()) / 60000);
        await sendPush(token,
          '\u26A0\uFE0F Pausen-Alarm evtl. gestoppt!',
          'App seit ' + Math.round(staleMin) + 'min offline. Noch ' + remMin + 'min Pause. App oeffnen!',
          'idle-nag', [400, 80, 400, 80, 400]);
      }
      return;
    }

    // ── OFFLINE ──
    if (status === 'offline') {
      if (staleMin < 3 || !awake) return;
      if ((d.todayCount || 0) === 0) {
        await sendPush(token,
          '\u{1F4A5} App nicht geoeffnet!',
          'Morgenstrafe droht: 2 Level Verlust. Jetzt oeffnen!',
          'morning-penalty',
          [800, 100, 800, 100, 800, 100, 1200]);
      } else {
        await sendPush(token,
          '\u{1F480} App offline seit ' + Math.round(staleMin) + 'min',
          'App oeffnen — Schandzeit laeuft!',
          'idle-nag', [500, 60, 500, 60, 500, 60, 800]);
      }
      return;
    }

    // ── ACTIVE SCHANDZEIT ──
    if (d.isShaming && d.idleSince) {
      const idleMin = Math.round((Date.now() - d.idleSince) / 60000);
      const msgs = [
        'Jetzt starten!',
        'Wiebke sieht das.',
        idleMin + ' min verschwendet.',
        'Heute: ' + (d.todayIdleMinutes || 0) + ' min Schandzeit total.'
      ];
      await sendPush(token,
        '\u{1F480} +' + idleMin + 'm Schandzeit',
        msgs[Math.min(Math.floor(idleMin / 5), msgs.length - 1)],
        'idle-nag', [500, 60, 500, 60, 500, 60, 800]);
      return;
    }

    // ── IDLE without shaming ──
    if (status === 'idle') {
      if (!awake) return;
      if ((d.todayCount || 0) === 0) {
        const appOpened = d.appOpenedToday || 0;
        const hoursSinceOpen = appOpened ? (Date.now() - appOpened) / 3600000 : 999;
        if (hoursSinceOpen > 2 || !appOpened) {
          await sendPush(token,
            '\u{1F4A5} Noch keine Session heute!',
            'Morgenstrafe droht. Jetzt oeffnen!',
            'morning-penalty',
            [800, 100, 800, 100, 800, 100, 1200]);
        } else if (d.morningAlert) {
          await sendPush(token,
            '\u2600\uFE0F Noch keine Pomodoro heute',
            'Tag starten!', 'push-cascade',
            [400, 80, 400, 80, 400]);
        }
      } else if (appDead) {
        await sendPush(token,
          '\u{1F480} App offline',
          'Naechste Pomodoro starten!',
          'idle-nag', [400, 80, 400, 80, 400]);
      }
    }
  });
