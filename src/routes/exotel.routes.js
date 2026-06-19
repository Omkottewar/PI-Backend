import { Router } from 'express';

const router = Router();

const HARDCODED_NUMBER = '9156250188';
const TRIGGER_DIGITS = '1234';

router.get('/lookup', (req, res) => {
  const { CallSid, CallFrom, digits } = req.query;

  console.log('[exotel/lookup]', { CallSid, CallFrom, digits });

  if (String(digits || '').trim() === TRIGGER_DIGITS) {
    return res.json({ number: HARDCODED_NUMBER });
  }

  return res.status(404).json({ number: null });
});

export default router;
