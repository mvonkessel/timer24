const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

const REGION = 'europe-west1';
const STATUS_PATH = 'status/moritz';

// Helper: send FCM data message (data-only = SW handles display)
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
      // Android high priority ensures delivery even in Doze mode
      android: { priority: 'high', ttl: 120000 },
      webpush: { headers: { Urgency: 'high', TTL: '120' } }
    });
  } catch (err) {
    // Token may be expired — clean it up
    if (err.code === 'messaging/registration-token-not-registered' ||
        err.code === 'messaging/invalid-registration-token') {
      await admin.database().ref(STATUS_PATH + '/fcmToken').remove().catch(() => {});
    }
    console.warn('[FCM] Send error:', err.code || err.message);
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
    // Ignore stale nudges (>60s old)
    if (Date.now() - data.time > 60000) return;

    const tokenSnap = await admin.database().ref(STATUS_PATH + '/fcmToken').once('value');
    const token = tokenSnap.val();

    await sendPush(
      token,
      '\u{1F4E2} ' + (data.from || 'Wiebke') + ' sagt:',
      data.message || 'Fang an!',
      'nudge',
      [500, 100, 500, 100, 500, 100, 800]
    );
  });

// ════════════════════════════════════════════
// 2. Scheduled Idle Check — every 2 minutes
//    Reads status from RTDB, sends FCM if needed
// ════════════════════════════════════════════
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

    // Don't push if: timer running, at work, offline, on break, completing, sleeping
    if (['running', 'paused', 'completed', 'break', 'working', 'offline'].includes(status)) return;
    if (d.isAtWork) return;
    if (d.isSleeping) return;

    // ── Schandzeit: aggressive push ──
    if (d.isShaming) {
      const shameMin = d.idleSessionMin || 0;
      await sendPush(
        token,
        '\u{1F480} +' + shameMin + 'm Schandzeit',
        'Wiebke sieht das. Jetzt starten!',
        'idle-nag',
        [500, 60, 500, 60, 500, 60, 800]
      );
      return;
    }

    // ── Grace period warning (>66% elapsed) ──
    if (d.idleSince && d.idleGrace) {
      const elapsed = (Date.now() - d.idleSince) / 60000;
      const grace = d.idleGrace;
      if (elapsed > grace * 0.66) {
        const remaining = Math.max(1, Math.round(grace - elapsed));
        await sendPush(
          token,
          '\u26A0\uFE0F Grace Period endet bald',
          'Noch ' + remaining + ' min. Dann Schandzeit.',
          'idle-nag',
          [400, 80, 400, 80, 400]
        );
      }
      return;
    }

    // ── Morning: 0 sessions, morning alert active ──
    if ((d.todayCount || 0) === 0 && d.morningAlert) {
      await sendPush(
        token,
        '\u2600\uFE0F Noch keine Pomodoro heute',
        'Tag starten!',
        'push-cascade',
        [400, 80, 400, 80, 400]
      );
    }
  });
