import { Router } from 'express';

const router = Router();

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
