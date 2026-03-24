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

// ════════════════════════════════════════════
// 1. Wiebke Nudge → Immediate FCM push
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
// 2. Rabbit Hole SOS → Aggressive FCM push
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
//    Most reliable background notification channel.
//    Handles: idle shame, expired breaks, morning penalty, stale app state.
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

    // Skip: at work, sleeping
    if (d.isAtWork) return;
    if (d.isSleeping) return;

    // Timer running: check if expired (tab may be killed)
    if (status === 'running') {
      if (d.timerEnd && Date.now() > d.timerEnd + 60000) {
        // Timer expired >1 min ago but status never updated → app is dead
        await sendPush(token,
          '\u{1F514} Timer abgelaufen!',
          'App oeffnen — Alarm verpasst!', 'idle-nag',
          [800, 100, 800, 100, 800, 100, 800]);
      }
      // Timer active: keepalive audio handles alarm. No push needed.
      return;
    }
    if (status === 'working') return;

    // Paused: skip if brief, push if stale (>10 min = idle in disguise)
    if (status === 'paused') {
      const ts = d.timestamp || 0;
      const staleMin = (Date.now() - ts) / 60000;
      if (staleMin < 10) return;
      await sendPush(token,
        '\u23F8 Zu lange pausiert! +' + Math.round(staleMin) + 'm',
        'Fortsetzen oder abbrechen!', 'idle-nag',
        [400, 80, 400, 80, 400]);
      return;
    }

    // Completed (reward screen): skip if fresh, push if stale (>3 min = stuck)
    if (status === 'completed') {
      const ts = d.timestamp || 0;
      const staleMin = (Date.now() - ts) / 60000;
      if (staleMin < 3) return;
      await sendPush(token,
        '\u2B50 Reward-Screen blockiert',
        'Weiter zur naechsten Pomodoro!', 'idle-nag',
        [400, 80, 400, 80, 400]);
      return;
    }

    // ── Expired break: app backgrounded during break ──
    if (status === 'break') {
      if (d.breakEnd && Date.now() > d.breakEnd) {
        const overMin = Math.round((Date.now() - d.breakEnd) / 60000);
        await sendPush(token,
          overMin > 0 ? '\u{1F480} Pause vorbei! +' + overMin + 'm idle' : '\u2615 Pause vorbei!',
          'Naechste Pomodoro starten!', 'idle-nag',
          [500, 60, 500, 60, 500, 60, 800]);
      }
      // Active break: keepalive audio handles break-end alarm. No push needed.
      return;
    }

    // ── Offline but was recently idle: app was killed ──
    if (status === 'offline') {
      // Check timestamp staleness — if last sync > 3 min ago, app is dead
      const ts = d.timestamp || 0;
      const staleMin = (Date.now() - ts) / 60000;
      if (staleMin < 3) return; // recently synced, probably just a blip
      // App is dead. If 0 sessions today → morning warning
      if ((d.todayCount || 0) === 0) {
        const appOpened = d.appOpenedToday || 0;
        const hoursSinceOpen = appOpened ? (Date.now() - appOpened) / 3600000 : 999;
        if (hoursSinceOpen > 2 || !appOpened) {
          await sendPush(token,
            '\u{1F4A5} App nicht geoeffnet!',
            'Morgenstrafe droht: 2 Level Verlust. Jetzt oeffnen!',
            'morning-penalty',
            [800, 100, 800, 100, 800, 100, 1200]);
        }
      }
      return;
    }

    // ── Active Schandzeit ──
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
        'idle-nag',
        [500, 60, 500, 60, 500, 60, 800]);
      return;
    }

    // ── Idle but isShaming=false: penalty may not have started yet (app just loaded) ──
    if (status === 'idle' && (d.todayCount || 0) === 0) {
      const appOpened = d.appOpenedToday || 0;
      const hoursSinceOpen = appOpened ? (Date.now() - appOpened) / 3600000 : 999;
      if (hoursSinceOpen > 2 || !appOpened) {
        await sendPush(token,
          '\u{1F4A5} App nicht geoeffnet!',
          'Morgenstrafe droht. Jetzt oeffnen!',
          'morning-penalty',
          [800, 100, 800, 100, 800, 100, 1200]);
      } else if (d.morningAlert) {
        await sendPush(token,
          '\u2600\uFE0F Noch keine Pomodoro heute',
          'Tag starten!', 'push-cascade',
          [400, 80, 400, 80, 400]);
      }
    }
  });
