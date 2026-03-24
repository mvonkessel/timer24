# Timer7 FCM Setup — Schritt für Schritt

## Voraussetzungen
- Firebase Projekt: `pomodoro-status` (bereits vorhanden)
- **Blaze-Plan** (Pay-as-you-go) — nötig für Cloud Functions + Cloud Scheduler
  → Firebase Console → Upgrade → Blaze. Kostenlos innerhalb der Free-Tier-Limits (~21.600 Aufrufe/Monat).

## 1. VAPID Key generieren

1. Firebase Console → Project Settings (Zahnrad) → Cloud Messaging
2. Unter "Web Push certificates" → "Generate key pair"
3. Öffentlichen Schlüssel kopieren (langer Base64-String)
4. In `index.html` ersetzen:
   ```
   const FCM_VAPID_KEY='PASTE_YOUR_VAPID_KEY_HERE';
   ```
   mit deinem Key:
   ```
   const FCM_VAPID_KEY='BLa8x9y...dein-key...';
   ```

## 2. Cloud Functions deployen

```bash
# Firebase CLI installieren (einmalig)
npm install -g firebase-tools

# Einloggen
firebase login

# In das Projektverzeichnis wechseln (wo firebase.json liegt)
cd timer7/

# Dependencies installieren
cd functions && npm install && cd ..

# Cloud Functions deployen
firebase deploy --only functions
```

## 3. Cloud Scheduler API aktivieren

Beim ersten Deploy von `idleCheck` fragt Firebase automatisch:
"Would you like to enable the Cloud Scheduler API?" → **Yes**

Falls nicht automatisch:
- Google Cloud Console → APIs & Services → Cloud Scheduler API → Enable

## 4. RTDB Rules aktualisieren

Firebase Console → Realtime Database → Rules:
```json
{
  "rules": {
    "status": {
      "moritz": {
        ".read": true,
        ".write": true
      }
    }
  }
}
```

## 5. App deployen

`index.html`, `sw.js`, `manifest.json`, Icons auf deinen Webserver hochladen.

## So funktioniert es

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│  Timer7 App  │────▶│  Firebase RTDB    │────▶│ Cloud Func  │
│  (Browser)   │     │  status/moritz    │     │ idleCheck   │
│              │◀────│                   │     │ (alle 2min) │
└─────────────┘     └──────────────────┘     └──────┬──────┘
                                                     │ FCM Push
┌─────────────┐     ┌──────────────────┐             │
│ Status App  │────▶│  status/moritz/   │             ▼
│  (Wiebke)   │     │  nudge            │     ┌─────────────┐
└─────────────┘     └────────┬─────────┘     │  Service     │
                              │ onWrite      │  Worker      │
                              ▼               │  (push evt)  │
                        Cloud Function        └─────────────┘
                        onNudge ──────────────▶ FCM Push ──▶ Notification
```

**Timer-Alarm** (Pomodoro fertig): SW setTimeout + IDB (wie bisher, sehr zuverlässig)
**Idle/Shame Nags**: Cloud Function prüft alle 2 min RTDB → FCM Push → weckt Android auf
**Wiebke Nudge**: RTDB Write → Cloud Function Trigger → sofortiger FCM Push
**Morning Push**: Cloud Function idleCheck erkennt morningAlert=true → FCM Push

## Kosten (Blaze Plan, Free Tier)

- Cloud Functions: 2M Aufrufe/Monat frei. idleCheck = ~21.600/Monat. ✓
- Cloud Scheduler: 3 Jobs frei. Wir nutzen 1. ✓
- FCM: Komplett kostenlos, kein Limit.
- RTDB: 10GB Transfer/Monat frei. Wir nutzen ~100MB. ✓
