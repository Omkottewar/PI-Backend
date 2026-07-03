import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { pool } from '../db/pool.js';
import { maskFullName, maskMobile } from '../utils/mask.js';
import {
  getFamilyByQrId,
  getFamilyMember,
  getQrByUniqueId,
  createQrRecord,
} from '../services/qr.service.js';
import { v4 as uuidv4 } from 'uuid';

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const router = Router();

function loadAlertPageHtml() {
  try {
    return readFileSync(path.join(__dirname, '../public/alert-page.html'), 'utf8');
  } catch {
    return '<!DOCTYPE html><html><body><p>Alert page missing</p></body></html>';
  }
}

router.post(
  '/create-call',
  body('uniqueId').notEmpty(),
  body('target').isIn(['owner', 'family']),
  body('family_detail_id').optional().isInt(),
  body('caller').optional().trim(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { uniqueId, target, family_detail_id } = req.body;
    const caller = req.body.caller || '0000000000';
    const qr = await getQrByUniqueId(uniqueId);
    if (!qr) return res.status(404).json({ error: 'QR not found' });

    let receiverNumber;
    if (target === 'owner') {
      receiverNumber = qr.mobile;
    } else {
      if (!family_detail_id) return res.status(400).json({ error: 'family_detail_id required' });
      const member = await getFamilyMember(qr.id, family_detail_id);
      if (!member) return res.status(404).json({ error: 'Contact not found' });
      receiverNumber = member.phone;
    }

    try {
      // Record the scan/call attempt. The actual dialing happens on the
      // scanner's device via the tel: protocol — this endpoint only logs
      // that someone tapped Call so we have a scan trail.
      await pool.query(
        'INSERT INTO call_logs (caller_number, receiver_number, status, start_time) VALUES ($1, $2, $3, NOW())',
        [caller, receiverNumber, 'initiated']
      );
      return res.json({ ok: true });
    } catch (e) {
      console.error('Call log insert failed:', e);
      // Logging failure shouldn't block the user from being able to call.
      // Return ok so the client opens the dialer regardless.
      return res.json({ ok: true });
    }
  }
);

router.post(
  '/:uniqueId/verify',
  body('vehicle_number').trim().notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    const { uniqueId } = req.params;
    const vehicleNorm = String(req.body.vehicle_number).trim().toUpperCase();
    const qr = await getQrByUniqueId(uniqueId);
    if (!qr) {
      return res.status(404).json({ error: 'Not found' });
    }
    if (qr.vehicle_number !== vehicleNorm) {
      return res.status(400).json({ error: 'Vehicle number does not match our records' });
    }

    const family = await getFamilyByQrId(qr.id);
    return res.json({
      verified: true,
      owner: {
        nameMasked: maskFullName(qr.name),
        mobileMasked: maskMobile(qr.mobile),
      },
      family: family.map((f) => ({
        id: f.id,
        relation: f.relation,
        name: f.name,
        phoneMasked: maskMobile(f.phone),
      })),
    });
  }
);

// The bystander taps a contact card on the alert page. This pins that
// contact as the "selected" one for the QR (Story A / global pointer).
// The IVR looks this up when the scanner enters the QR's 5-digit code.
// Selection is required — the alert page will not open the dialer unless
// this endpoint returns ok.
router.post(
  '/:uniqueId/select',
  body('kind').isIn(['owner', 'family']),
  body('family_id').optional().isInt(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { uniqueId } = req.params;
    const { kind, family_id } = req.body;

    const qr = await getQrByUniqueId(uniqueId);
    if (!qr) return res.status(404).json({ error: 'QR not found' });
    if (qr.is_active === false) {
      return res.status(400).json({ error: 'This QR is no longer active' });
    }

    let familyIdToStore = null;
    if (kind === 'family') {
      if (!family_id) {
        return res.status(400).json({ error: 'family_id is required when kind = family' });
      }
      const famRes = await pool.query(
        `SELECT id FROM family_details WHERE id = $1 AND qr_id = $2`,
        [family_id, qr.id]
      );
      if (!famRes.rows.length) {
        return res.status(400).json({ error: 'Contact does not belong to this QR' });
      }
      familyIdToStore = family_id;
    }

    await pool.query(
      `UPDATE qrdata
          SET selected_contact_kind = $1,
              selected_family_id = $2,
              selected_at = NOW()
        WHERE id = $3`,
      [kind, familyIdToStore, qr.id]
    );

    return res.json({
      ok: true,
      digits: qr.digits,
      bridge_number: '02048563508',
      ttl_minutes: 30,
    });
  }
);

// The bystander's browser calls this after tapping a contact. Location is
// optional — a null lat/lng means the browser denied the Geolocation prompt
// or the bystander is on a device without GPS. Never blocks the emergency
// call; the alert page fires this in the background.
router.post(
  '/:uniqueId/event',
  body('contact_kind').isIn(['owner', 'family']),
  body('contact_family_id').optional({ nullable: true }).isInt(),
  body('latitude').optional({ nullable: true }).isFloat({ min: -90, max: 90 }),
  body('longitude').optional({ nullable: true }).isFloat({ min: -180, max: 180 }),
  body('accuracy_meters').optional({ nullable: true }).isFloat({ min: 0 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { uniqueId } = req.params;
    const {
      contact_kind,
      contact_family_id,
      latitude,
      longitude,
      accuracy_meters,
    } = req.body;

    try {
      const qr = await getQrByUniqueId(uniqueId);
      if (!qr) return res.status(404).json({ error: 'QR not found' });

      let familyIdToStore = null;
      if (contact_kind === 'family' && contact_family_id != null) {
        const famRes = await pool.query(
          `SELECT id FROM family_details WHERE id = $1 AND qr_id = $2`,
          [contact_family_id, qr.id]
        );
        if (famRes.rows.length) {
          familyIdToStore = contact_family_id;
        }
        // If family_id doesn't match this QR, we silently drop it — event is
        // still recorded for the audit trail with contact_family_id = null.
      }

      const userAgent = String(req.headers['user-agent'] || '').slice(0, 500);

      await pool.query(
        `INSERT INTO alert_events
           (qr_id, contact_kind, contact_family_id, latitude, longitude,
            accuracy_meters, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          qr.id,
          contact_kind,
          familyIdToStore,
          latitude == null ? null : Number(latitude),
          longitude == null ? null : Number(longitude),
          accuracy_meters == null ? null : Number(accuracy_meters),
          userAgent,
        ]
      );

      return res.json({ ok: true });
    } catch (err) {
      console.error('[alert/:uniqueId/event] error:', err);
      return res.status(500).json({ error: err.message });
    }
  }
);

router.get('/:uniqueId/status', async (req, res) => {
  const { uniqueId } = req.params;
  const qr = await getQrByUniqueId(uniqueId);
  if (qr) {
    const actDate = new Date(qr.date_of_activation || qr.created_at);
    const diffDays = (new Date() - actDate) / (1000 * 60 * 60 * 24);
    if (diffDays > 365) return res.json({ exists: true, expired: true });
    return res.json({ exists: true, expired: false });
  }
  return res.json({ exists: false, expired: false });
});

router.post('/:uniqueId/manual_activate',
  body('mobile').trim().notEmpty(),
  body('name').trim().notEmpty(),
  body('vehicle_number').trim().matches(/^([A-Z]{2}[0-9]{2}[A-Z]{1,2}[0-9]{4}|[0-9]{2}BH[0-9]{4}[A-Z]{1,2})$/),
  body('referralCode').trim().notEmpty(),
  body('family').isArray({ min: 1, max: 5 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { uniqueId } = req.params;
    const { mobile, name, vehicle_number, referralCode, family, email } = req.body;

    const manualRes = await pool.query(
      `SELECT * FROM manual_qr WHERE qr_unique_id = $1 AND is_active = true`,
      [uniqueId]
    );
    const manualQr = manualRes.rows[0];

    if (!manualQr || manualQr.referral_code !== referralCode) {
      return res.status(400).json({ error: 'Invalid QR or Referral Code' });
    }

    // Check if user exists
    const existingRes = await pool.query(`SELECT id FROM users WHERE mobile = $1`, [mobile]);
    if (existingRes.rows.length > 0) {
      return res.status(400).json({ error: 'User already exists with this number' });
    }

    let userId;
    try {
      // Create manualUser
      const userRes = await pool.query(
        `INSERT INTO users (name, mobile, email, manual_user) VALUES ($1, $2, $3, true) RETURNING id`,
        [name, mobile, email || null]
      );
      userId = userRes.rows[0].id;
    } catch (err) {
      if (err.code === '23505') { // postgres unique constraint
        console.error('manual_activate duplicate user:', err);
        return res.status(400).json({ error: 'User already exists with this number' });
      }
      return res.status(500).json({ error: err.message });
    }

    // Use internal QR service
    try {
      await createQrRecord({
        userId,
        uniqueId,
        razorpay_order_id: 'manual',
        razorpay_payment_id: 'manual',
        razorpay_signature: 'manual',
        name,
        mobile,
        email: email || '',
        vehicle_number,
        blood_group: null,
        family,
        isManual: true,
      });
      // Deactivate manual QR
      await pool.query(`UPDATE manual_qr SET is_active = false WHERE id = $1`, [manualQr.id]);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }
);

router.get('/:uniqueId', (req, res) => {
  const html = loadAlertPageHtml().replaceAll('__UNIQUE_ID__', req.params.uniqueId);
  res.type('html').send(html);
});

export default router;
