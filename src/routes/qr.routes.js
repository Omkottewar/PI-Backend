import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { requireAuth } from '../middleware/auth.js';
import { createQrRecord, listHistoryForUser, validateFamilyRelation } from '../services/qr.service.js';

const router = Router();

router.post(
  '/create',
  requireAuth,
  body('razorpay_order_id').notEmpty(),
  body('razorpay_payment_id').notEmpty(),
  body('razorpay_signature').notEmpty(),
  body('name').trim().notEmpty(),
  body('mobile').trim().isLength({ min: 10, max: 15 }),
  body('email').isEmail().normalizeEmail(),
  body('vehicle_number').trim().notEmpty().matches(/^[A-Z]{2}[0-9]{2}[A-Z]{2}[0-9]{4}$/).withMessage('Invalid Vehicle Number'),
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
      });
      return res.status(201).json({
        id: row.id,
        unique_id: row.unique_id,
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

export default router;
