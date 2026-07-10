import { Router } from 'express';
import { config } from '../config/index.js';

const router = Router();

// Home-page promo video metadata. Returns `{ url: null }` when unset so
// the mobile client can hide the section without a special error path.
router.get('/promo-video', (req, res) => {
  const v = config.promoVideo || {};
  const url = String(v.url || '').trim();
  if (!url) {
    return res.json({ url: null });
  }
  return res.json({
    url,
    title: v.title || 'See how it works',
    subtitle: v.subtitle || '',
    poster: v.poster || null,
  });
});

router.get('/version-check', (req, res) => {
  const currentVersion = req.query.version;
  const latestVersion = '1.0.5';
  
  // Mismatch check (if version query parameter is empty, we default forceUpdate to false)
  const forceUpdate = currentVersion ? (currentVersion !== latestVersion) : false;

  return res.json({
    latestVersion,
    forceUpdate,
    updateMessage: forceUpdate ? "Please update app to continue" : "App is up to date",
    playStoreUrl: "https://play.google.com/store/apps/details?id=com.emergency.alert"
  });
});

export default router;
