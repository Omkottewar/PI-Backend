import admin from 'firebase-admin';
import { pool } from '../db/pool.js';
import { config } from '../config/index.js';

// Firebase Admin SDK lifecycle:
//   - Initialize once, lazily, on first send. If FIREBASE_SERVICE_ACCOUNT_JSON
//     is unset we skip init and every send silently no-ops. This lets the
//     backend boot on machines without push credentials (local dev, CI).
//   - The service-account JSON is a single-line env var. Multiline PEM keys
//     inside it use escaped \n which Firebase's parser handles when the JSON
//     is passed through JSON.parse.
let _firebaseApp = null;
let _initTried = false;
function getFirebaseApp() {
  if (_firebaseApp) return _firebaseApp;
  if (_initTried) return null;
  _initTried = true;

  const raw = String(config.firebaseServiceAccount || '').trim();
  if (!raw) {
    console.log('[push] FIREBASE_SERVICE_ACCOUNT_JSON not set — push is disabled');
    return null;
  }
  try {
    const serviceAccount = JSON.parse(raw);
    _firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('[push] Firebase Admin initialized for project', serviceAccount.project_id);
    return _firebaseApp;
  } catch (err) {
    console.error('[push] failed to init Firebase Admin:', err.message);
    return null;
  }
}

// Fire-and-forget FCM send. Returns { ok, skipped, reason, messageId, error }.
// Never throws — a broken push must never break the primary flow (a QR scan,
// a call routing decision, a call completion webhook).
async function sendFcm(deviceToken, { title, body, data = {} }) {
  try {
    if (!deviceToken) return { skipped: true, reason: 'no_token' };
    const app = getFirebaseApp();
    if (!app) return { skipped: true, reason: 'not_configured' };

    // FCM data payload values MUST be strings. Coerce here so callers can
    // pass numbers/booleans without every hook doing its own String() dance.
    const stringData = {};
    for (const [k, v] of Object.entries(data || {})) {
      if (v == null) continue;
      stringData[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }

    const messageId = await admin.messaging().send({
      token: deviceToken,
      notification: { title, body },
      data: stringData,
      android: {
        priority: 'high',
        notification: {
          channelId: 'qr_events',
          sound: 'default',
        },
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            'content-available': 1,
          },
        },
      },
    });
    return { ok: true, messageId };
  } catch (err) {
    // FCM's "registration-token-not-registered" fires when the app was
    // uninstalled or the token expired. Null it in the DB so we stop
    // trying to hit it on every subsequent event.
    if (err.code === 'messaging/registration-token-not-registered') {
      try {
        await pool.query(
          `UPDATE users SET "deviceToken" = NULL WHERE "deviceToken" = $1`,
          [deviceToken]
        );
      } catch (dbErr) {
        console.error('[push] failed to clear stale token:', dbErr.message);
      }
      return { ok: false, error: 'stale_token' };
    }
    console.error('[push] send failed:', err.code || '', err.message);
    return { ok: false, error: err.message };
  }
}

// Combined "notify user" primitive. Every notification event should call
// this — it (1) persists an in-app row so the bell icon updates, and (2)
// fires an FCM push so the OS shows a banner even when the app is closed.
// Both steps are best-effort: DB failure OR push failure never bubbles.
export async function notifyUser(userId, {
  title,
  message,
  type = 'general',
  sentBy = 'system',
  data = {},
}) {
  const result = { dbId: null, push: null };

  // Step 1 — persistent row for the in-app bell/inbox.
  try {
    const r = await pool.query(
      `INSERT INTO notifications
         ("userId", title, message, "isRead", "sentBy", "notificationType",
          "createdAt", "updatedAt")
       VALUES ($1, $2, $3, false, $4, $5, NOW(), NOW())
       RETURNING id`,
      [userId, title, message, sentBy, type]
    );
    result.dbId = r.rows[0]?.id ?? null;
  } catch (err) {
    console.error('[notify] DB insert failed:', err.message);
  }

  // Step 2 — FCM push.
  try {
    const t = await pool.query(
      `SELECT "deviceToken" FROM users WHERE id = $1`,
      [userId]
    );
    const deviceToken = t.rows[0]?.deviceToken || null;
    result.push = await sendFcm(deviceToken, {
      title,
      body: message,
      data: {
        type,
        notification_id: result.dbId,
        ...data,
      },
    });
  } catch (err) {
    console.error('[notify] push step failed:', err.message);
    result.push = { ok: false, error: err.message };
  }

  return result;
}

// Direct FCM send without a DB row — for one-off broadcasts or debug pings.
export async function sendPushRaw(deviceToken, payload) {
  return sendFcm(deviceToken, payload);
}
