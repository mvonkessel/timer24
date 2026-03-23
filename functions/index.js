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

exports.idleCheck = functions
  .region(REGION)
  .pubsub.schedule('every 2 minutes')
  .timeZone('Europe/Zurich')
  .onRun(async () => {
    const snap = await admin.database().ref(STATUS_PATH).once('value');
    const d = snap.val();
    if (!d || !d.fcmToken) return;
    const token = d.fcmToken;
    const status = d.status || 'offline';
    if (['running', 'paused', 'completed', 'break', 'working', 'offline'].includes(status)) return;
    if (d.isAtWork) return;
    if (d.isSleeping) return;

    if (d.isShaming) {
      await sendPush(token,
        '\u{1F480} +' + (d.idleSessionMin || 0) + 'm Schandzeit',
        'Wiebke sieht das. Jetzt starten!', 'idle-nag',
        [500, 60, 500, 60, 500, 60, 800]);
      return;
    }
    if (d.idleSince && d.idleGrace) {
      const elapsed = (Date.now() - d.idleSince) / 60000;
      if (elapsed > d.idleGrace * 0.66) {
        await sendPush(token,
          '\u26A0\uFE0F Grace Period endet bald',
          'Noch ' + Math.max(1, Math.round(d.idleGrace - elapsed)) + ' min.',
          'idle-nag', [400, 80, 400, 80, 400]);
      }
      return;
    }
    if ((d.todayCount || 0) === 0) {
      const appOpened = d.appOpenedToday || 0;
      const hoursSinceOpen = appOpened ? (Date.now() - appOpened) / 3600000 : 999;
      if (hoursSinceOpen > 2 || !appOpened) {
        await sendPush(token,
          '\u{1F4A5} App nicht geoeffnet!',
          'Morgenstrafe droht: 2 Level Verlust. Jetzt oeffnen!',
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
