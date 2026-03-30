const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

const REGION = 'europe-west1';
const STATUS_PATH = 'status/moritz';

async function sendPush(token, title, body, tag, vibrate, tokenField) {
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
      const field = tokenField || 'fcmToken';
      await admin.database().ref(STATUS_PATH + '/' + field).remove().catch(() => {});
    }
  }
}

// Rotating tag: prevents Android from throttling repeated notifications
function rotTag(base) {
  return base + '-' + (Math.floor(Date.now() / 60000) % 10);
}

// Alarm-grade vibration: 10s pattern to wake user
const ALARM_VIBRATE = [800, 200, 800, 200, 800, 200, 800, 200, 800, 200, 800, 200, 1500];
const URGENT_VIBRATE = [500, 60, 500, 60, 500, 60, 800];
const NORMAL_VIBRATE = [400, 80, 400, 80, 400];

function nowMinsCH() {
  const now = new Date();
  const ch = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Zurich' }));
  return ch.getHours() * 60 + ch.getMinutes();
}

function todayCH() {
  const now = new Date();
  const ch = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Zurich' }));
  return ch.getFullYear() + '-' + String(ch.getMonth() + 1).padStart(2, '0') + '-' + String(ch.getDate()).padStart(2, '0');
}

function isAwakeTime(d) {
  const wake = d.wakeMin ?? 320;
  const sleep = d.sleepMin ?? 1280;
  const now = nowMinsCH();
  if (wake < sleep) return now >= wake && now < sleep;
  return now >= wake || now < sleep;
}

// How many minutes past wake time right now?
function minsPastWake(d) {
  const wake = d.wakeMin ?? 320;
  const now = nowMinsCH();
  const diff = now - wake;
  return diff >= 0 ? diff : diff + 1440;
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
      'rabbit-hole', ALARM_VIBRATE);
  });


async function pushMoritz(d, token, status, staleMin, appDead, appVeryDead, awake, pastWake) {
    // Morning alarm: aggressive pushes starting 5min past wake if app is stale
    if (d.isSleeping) {
      if (!awake) return; // still sleep time
      if (appDead) {
        // App is stale AND it's past wake time → alarm!
        const urgency = pastWake < 30 ? 'alarm' : 'urgent';
        const msgs = [
          '\u2600\uFE0F AUFSTEHEN!',
          '\u{1F6A8} WECKER! App oeffnen!',
          '\u{1F525} ' + pastWake + ' min seit Aufstehzeit!',
          '\u{1F4A5} Morgenstrafe droht!'
        ];
        await sendPush(token,
          msgs[Math.floor(Date.now() / 60000) % msgs.length],
          pastWake + ' min seit Aufstehzeit. App oeffnen und Tag starten!',
          rotTag('morning-alarm'),
          urgency === 'alarm' ? ALARM_VIBRATE : URGENT_VIBRATE);
      }
      return;
    }

    // ── AT WORK ──
    if (d.isAtWork) {
      if (!appVeryDead) return;
      if (!awake) return;
      const workMin = d.todayWorkMinutes || 0;
      if ((d.todayCount || 0) === 0 && workMin > 60) {
        await sendPush(token,
          '\u{1F3E5}\u2192\u{1F3E0} Feierabend?',
          'Nach ' + Math.round(workMin / 60) + 'h Arbeit: App oeffnen!',
          rotTag('idle-nag'), URGENT_VIBRATE);
      } else {
        await sendPush(token,
          '\u{1F480} App seit ' + Math.round(staleMin) + 'min offline',
          'App oeffnen! Schandzeit laeuft.',
          rotTag('idle-nag'), URGENT_VIBRATE);
      }
      return;
    }

    if (status === 'working') {
      if (appVeryDead && awake) {
        await sendPush(token,
          '\u{1F480} App seit ' + Math.round(staleMin) + 'min offline',
          'Arbeit vorbei? App oeffnen!',
          rotTag('idle-nag'), NORMAL_VIBRATE);
      }
      return;
    }

    // ── TIMER RUNNING ──
    if (status === 'running') {
      if (d.timerEnd && Date.now() > d.timerEnd + 60000) {
        await sendPush(token,
          '\u{1F514} Timer abgelaufen!',
          'App oeffnen — Alarm verpasst!',
          rotTag('timer-alarm'), ALARM_VIBRATE);
      } else if (d.timerEnd && d.timerEnd > Date.now() && appDead) {
        const remMin = Math.round((d.timerEnd - Date.now()) / 60000);
        await sendPush(token,
          '\u26A0\uFE0F Timer evtl. gestoppt!',
          'App seit ' + Math.round(staleMin) + 'min offline. Noch ' + remMin + 'min. App oeffnen!',
          rotTag('idle-nag'), NORMAL_VIBRATE);
      }
      return;
    }

    // ── PAUSED ──
    if (status === 'paused') {
      if (staleMin >= 10) {
        await sendPush(token,
          '\u23F8 Zu lange pausiert! +' + Math.round(staleMin) + 'm',
          'Fortsetzen oder abbrechen!',
          rotTag('idle-nag'), NORMAL_VIBRATE);
      }
      return;
    }

    // ── COMPLETED (reward screen) ──
    if (status === 'completed') {
      if (staleMin >= 3) {
        await sendPush(token,
          '\u2B50 Reward-Screen blockiert',
          'Weiter zur naechsten Pomodoro!',
          rotTag('idle-nag'), NORMAL_VIBRATE);
      }
      return;
    }

    // ── BREAK ──
    if (status === 'break') {
      if (d.breakEnd && Date.now() > d.breakEnd) {
        const overMin = Math.round((Date.now() - d.breakEnd) / 60000);
        await sendPush(token,
          overMin > 0 ? '\u{1F480} Pause vorbei! +' + overMin + 'm idle' : '\u2615 Pause vorbei!',
          'Naechste Pomodoro starten!',
          rotTag('break-alarm'), URGENT_VIBRATE);
      } else if (d.breakEnd && d.breakEnd > Date.now() && appDead) {
        const remMin = Math.round((d.breakEnd - Date.now()) / 60000);
        await sendPush(token,
          '\u26A0\uFE0F Pausen-Alarm evtl. gestoppt!',
          'App seit ' + Math.round(staleMin) + 'min offline. Noch ' + remMin + 'min Pause.',
          rotTag('idle-nag'), NORMAL_VIBRATE);
      }
      return;
    }

    // ── OFFLINE ──
    if (status === 'offline') {
      if (staleMin < 3 || !awake) return;
      if ((d.todayCount || 0) === 0) {
        await sendPush(token,
          '\u{1F4A5} App nicht geoeffnet!',
          'Morgenstrafe droht! Jetzt oeffnen!',
          rotTag('morning-alarm'), ALARM_VIBRATE);
      } else {
        await sendPush(token,
          '\u{1F480} App offline seit ' + Math.round(staleMin) + 'min',
          'App oeffnen — Schandzeit laeuft!',
          rotTag('idle-nag'), URGENT_VIBRATE);
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
        rotTag('idle-nag'), URGENT_VIBRATE);
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
            pastWake + ' min seit Aufstehzeit. Morgenstrafe droht!',
            rotTag('morning-alarm'), ALARM_VIBRATE);
        } else if (d.morningAlert) {
          await sendPush(token,
            '\u2600\uFE0F Noch keine Pomodoro heute',
            'Tag starten!',
            rotTag('idle-nag'), URGENT_VIBRATE);
        }
      } else if (appDead) {
        await sendPush(token,
          '\u{1F480} App offline',
          'Naechste Pomodoro starten!',
          rotTag('idle-nag'), NORMAL_VIBRATE);
      }
    }


}

// ════════════════════════════════════════════
// 3. Scheduled Check — EVERY 1 MINUTE
// ════════════════════════════════════════════
exports.idleCheck = functions
  .region(REGION)
  .pubsub.schedule('every 1 minutes')
  .timeZone('Europe/Zurich')
  .onRun(async () => {
    const snap = await admin.database().ref(STATUS_PATH).once('value');
    const d = snap.val();
    if (!d) return;
    const status = d.status || 'offline';
    const ts = d.timestamp || 0;
    const staleMin = (Date.now() - ts) / 60000;
    const appDead = staleMin > 5;
    const appVeryDead = staleMin > 30;
    const awake = isAwakeTime(d);
    const pastWake = minsPastWake(d);

    // ── MORITZ PUSHES ──
    const token = d.fcmToken;
    if (token) await pushMoritz(d, token, status, staleMin, appDead, appVeryDead, awake, pastWake);


    // ═══════════════════════════════════════
    // WIEBKE PROACTIVE PUSHES
    // ═══════════════════════════════════════
    const wToken = d.wiebkeFcmToken;
    if (wToken && awake) {
      const wLastPush = d._wiebkeLastPush || 0;
      const wCooldownMin = (Date.now() - wLastPush) / 60000;

      // Minimum 10 min between Wiebke pushes to avoid spam
      if (wCooldownMin >= 10) {
        const todayMin = d.todayMinutes || 0;
        const todayIdle = d.todayIdleMinutes || 0;
        const todayCount = d.todayCount || 0;
        const goal = d.dailyGoal || 120;
        const pct = goal > 0 ? todayMin / goal : 0;
        const wMilestones = d._wiebkeMilestones || {};
        const today = todayCH();
        if (wMilestones._date !== today) {
          // Reset milestones for new day
          await admin.database().ref(STATUS_PATH + '/_wiebkeMilestones').set({ _date: today });
        }

        let pushed = false;

        // Perfect day — verify it's from today (flag persists across days)
        const pdTime = d.perfectDayTime || 0;
        const pdCH = new Date(new Date(pdTime).toLocaleString('en-US', { timeZone: 'Europe/Zurich' }));
        const pdDate = pdCH.getFullYear() + '-' + String(pdCH.getMonth() + 1).padStart(2, '0') + '-' + String(pdCH.getDate()).padStart(2, '0');
        if (d.perfectDay && pdDate === today && !wMilestones.perfect) {
          await sendPush(wToken, '\u{1F31F} Perfekter Tag!',
            'Moritz hat Tagesziel erreicht mit hoher Qualit\u00E4t und wenig Schandzeit!',
            'wiebke-perfect', [200, 100, 200, 100, 400], 'wiebkeFcmToken');
          await admin.database().ref(STATUS_PATH + '/_wiebkeMilestones/perfect').set(true);
          pushed = true;
        }

        // Goal reached (100%)
        if (!pushed && pct >= 1 && !wMilestones.goal100) {
          await sendPush(wToken, '\u2705 Tagesziel erreicht!',
            'Moritz hat ' + todayMin + '/' + goal + ' min geschafft. ' + todayCount + ' Sessions.',
            'wiebke-goal', [200, 80, 200], 'wiebkeFcmToken');
          await admin.database().ref(STATUS_PATH + '/_wiebkeMilestones/goal100').set(true);
          pushed = true;
        }

        // 50% milestone
        if (!pushed && pct >= 0.5 && !wMilestones.goal50) {
          await sendPush(wToken, '\u{1F4AA} 50% vom Tagesziel',
            todayMin + '/' + goal + ' min. ' + todayCount + ' Sessions.',
            'wiebke-progress', [150, 60, 150], 'wiebkeFcmToken');
          await admin.database().ref(STATUS_PATH + '/_wiebkeMilestones/goal50').set(true);
          pushed = true;
        }

        // Shame alert: 30+ min idle today (once per day)
        if (!pushed && todayIdle >= 30 && !wMilestones.shame30) {
          await sendPush(wToken, '\u{1F480} 30+ min Schandzeit',
            'Moritz hat heute ' + todayIdle + ' min verschwendet.',
            'wiebke-shame', URGENT_VIBRATE, 'wiebkeFcmToken');
          await admin.database().ref(STATUS_PATH + '/_wiebkeMilestones/shame30').set(true);
          pushed = true;
        }

        // Active shaming for 15+ min (repeat every 15 min)
        if (!pushed && d.isShaming && d.idleSince) {
          const idleNow = Math.round((Date.now() - d.idleSince) / 60000);
          if (idleNow >= 15 && wCooldownMin >= 15) {
            await sendPush(wToken, '\u{1F6A8} Moritz idle seit ' + idleNow + ' min!',
              'Heute: ' + todayCount + ' Sessions, ' + todayMin + '/' + goal + ' min.',
              rotTag('wiebke-shame-live'), URGENT_VIBRATE, 'wiebkeFcmToken');
            pushed = true;
          }
        }

        if (pushed) {
          await admin.database().ref(STATUS_PATH + '/_wiebkeLastPush').set(Date.now());
        }
      }
    }
  });
