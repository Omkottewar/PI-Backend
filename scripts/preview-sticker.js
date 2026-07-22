// Renders one sticker with test data so we can eyeball what the
// admin panel is actually generating right now. Writes to
// backend/scripts/preview.png — open it and compare against the
// mobile app screenshot.
import { renderStickerPng } from '../src/utils/sticker.js';
import fs from 'fs';

const png = await renderStickerPng({
  alertUrl: 'https://pi-backend-qkjh.onrender.com/alert/preview',
  digits: '10065',
  isManual: false, // false so the vehicle number renders too
  vehicleNumber: 'MH40KR3448',
});
fs.writeFileSync('scripts/preview.png', png);
console.log('Wrote', png.length, 'bytes to scripts/preview.png');
