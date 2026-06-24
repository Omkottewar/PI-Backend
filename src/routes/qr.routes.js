import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { requireAuth } from '../middleware/auth.js';
import {
  createQrRecord,
  listHistoryForUser,
  validateFamilyRelation,
  getQrByVehicleNumber,
  getFamilyForUserQr,
  replaceFamilyForUserQr,
} from '../services/qr.service.js';

const router = Router();

router.get('/check-vehicle/:vehicleNumber', requireAuth, async (req, res) => {
  const { vehicleNumber } = req.params;
  try {
    const row = await getQrByVehicleNumber(vehicleNumber);
    return res.json({ exists: !!row });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post(
  '/create',
  requireAuth,
  body('razorpay_order_id').notEmpty(),
  body('razorpay_payment_id').notEmpty(),
  body('razorpay_signature').notEmpty(),
  body('name').trim().notEmpty(),
  body('mobile').trim().isLength({ min: 10, max: 15 }),
  body('email').isEmail().normalizeEmail(),
  body('vehicle_number').trim().notEmpty().matches(/^([A-Z]{2}[0-9]{2}[A-Z]{1,2}[0-9]{4}|[0-9]{2}BH[0-9]{4}[A-Z]{1,2})$/).withMessage('Invalid Vehicle Number'),
  body('blood_group').optional().isString().trim(),
  body('family').isArray({ min: 1, max: 5 }),
  body('family.*.name').trim().notEmpty(),
  body('family.*.phone').trim().notEmpty(),
  body('family.*.relation').custom((v) => validateFamilyRelation(v)),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    try {
      const row = await createQrRecord({
        userId: req.userId,
        ...req.body,
        isManual: false,
      });
      return res.status(201).json({
        id: row.id,
        unique_id: row.unique_id,
        digits: row.digits,
        alert_url: row.alertUrl,
        vehicle_number: row.vehicle_number,
        created_at: row.created_at,
      });
    } catch (e) {
      const code = e.statusCode || 500;
      return res.status(code).json({ error: e.message });
    }
  }
);

router.get('/history', requireAuth, async (req, res) => {
  const rows = await listHistoryForUser(req.userId);
  return res.json({ items: rows });
});

router.get('/:id/family', requireAuth, async (req, res) => {
  const qrId = parseInt(req.params.id, 10);
  if (!Number.isFinite(qrId)) {
    return res.status(400).json({ error: 'Invalid QR id' });
  }
  try {
    const items = await getFamilyForUserQr(req.userId, qrId);
    return res.json({ items });
  } catch (e) {
    const code = e.statusCode || 500;
    return res.status(code).json({ error: e.message });
  }
});

router.put(
  '/:id/family',
  requireAuth,
  body('family').isArray({ min: 1, max: 5 }),
  body('family.*.name').trim().notEmpty(),
  body('family.*.phone').trim().notEmpty(),
  body('family.*.relation').custom((v) => validateFamilyRelation(v)),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    const qrId = parseInt(req.params.id, 10);
    if (!Number.isFinite(qrId)) {
      return res.status(400).json({ error: 'Invalid QR id' });
    }
    try {
      const items = await replaceFamilyForUserQr(req.userId, qrId, req.body.family);
      return res.json({ items });
    } catch (e) {
      const code = e.statusCode || 500;
      return res.status(code).json({ error: e.message });
    }
  }
);

export default router;
