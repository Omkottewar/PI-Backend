// Print-ready sticker renderer — mirrors the Flutter widget at
// mobile/lib/presentation/qr/widgets/qr_detail_card.dart 1:1 so the PNGs
// bundled by the admin panel look identical to what the customer sees
// in-app after activation. For manual QRs (pre-print, before the
// vehicle number is known) we skip the vehicle line, matching the
// `isManual = true` branch of the mobile widget.
//
// Pipeline: QR bytes → base64 → embedded as <image> in a hand-written
// SVG template → sharp rasterizes to PNG.

import QRCode from 'qrcode';
import sharp from 'sharp';

const RED = '#DC2626';
const INK = '#111827';
const GREEN = '#22C55E';

// Coordinate space matches the Flutter widget's 360-wide layout so text
// sizes / spacing carry over. sharp scales this by `density` at raster
// time — we output at ~2x for print-crisp PNGs.
const W = 360;
const H_MANUAL = 552; // header 90 + body ~ 400 + footer ~62

/**
 * Build the SVG for one sticker.
 * @param {object} opts
 * @param {string} opts.qrPngB64 — base64 of the QR PNG (no data: prefix)
 * @param {string} opts.digits — extension number (e.g. "70048")
 * @param {boolean} [opts.showVehicle] — auto-QR case, prints vehicle number
 * @param {string} [opts.vehicleNumber]
 * @returns {string} SVG document
 */
function buildStickerSvg({ qrPngB64, digits, showVehicle, vehicleNumber }) {
  const H = showVehicle ? H_MANUAL + 32 : H_MANUAL;

  // Layout anchors — kept as constants so the whole file reads as
  // "here's what's at y=X". Y increments top-down.
  const HEADER_H = 90;
  const BODY_TOP = HEADER_H + 12;
  const QR_SIZE = 220;
  const CROSS_SIZE = 44;
  const FRAME_INNER_PAD = 10;
  const FRAME_W = QR_SIZE + FRAME_INNER_PAD * 2 + (showVehicle ? 0 : 0);
  const FRAME_X = (W - FRAME_W) / 2;
  const FRAME_Y = BODY_TOP + (showVehicle ? 32 : 0);
  const FRAME_H = QR_SIZE + FRAME_INNER_PAD * 2 + (showVehicle ? 30 : 0);
  const QR_X = FRAME_X + FRAME_INNER_PAD;
  const QR_Y = FRAME_Y + FRAME_INNER_PAD + (showVehicle ? 30 : 0);

  const AFTER_QR_Y = FRAME_Y + FRAME_H + 12;
  const EXT_LABEL_Y = AFTER_QR_Y + 12;
  const EXT_PILL_Y = EXT_LABEL_Y + 14;
  const EXT_PILL_H = 36;
  const BRAND_Y = EXT_PILL_Y + EXT_PILL_H + 32;

  const FOOTER_Y = H - 62;

  // Bracket arm length — matches _BracketPainter (14% of frame width).
  const ARM = Math.round(FRAME_W * 0.14);

  // Red medical cross: two overlapping rectangles centered on (cx, cy).
  const cross = (cx, cy) => {
    const s = CROSS_SIZE;
    const bar = s * 0.35;
    return `
      <rect x="${cx - bar / 2}" y="${cy - s / 2}" width="${bar}" height="${s}" fill="${RED}"/>
      <rect x="${cx - s / 2}" y="${cy - bar / 2}" width="${s}" height="${bar}" fill="${RED}"/>
    `;
  };

  const crossCy = FRAME_Y + FRAME_H / 2;
  const leftCrossCx = FRAME_X - 4 - CROSS_SIZE / 2;
  const rightCrossCx = FRAME_X + FRAME_W + 4 + CROSS_SIZE / 2;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W * 2}" height="${H * 2}">
  <!-- Clip everything to a rounded rectangle so header/footer edges
       curve with the sticker instead of poking out at the corners. -->
  <defs>
    <clipPath id="card">
      <rect x="0" y="0" width="${W}" height="${H}" rx="18" ry="18"/>
    </clipPath>
  </defs>

  <g clip-path="url(#card)">
    <!-- White card background -->
    <rect x="0" y="0" width="${W}" height="${H}" fill="#FFFFFF"/>

    <!-- ── Red header band ─────────────────────────────────── -->
    <rect x="0" y="0" width="${W}" height="${HEADER_H}" fill="${RED}"/>
    <text x="${W / 2}" y="52" text-anchor="middle"
          font-family="Arial, Helvetica, sans-serif" font-weight="900"
          font-size="34" fill="#FFFFFF" letter-spacing="0.2">
      QR 4 EMERGENCY
    </text>
    <text x="${W / 2}" y="78" text-anchor="middle"
          font-family="Arial, Helvetica, sans-serif" font-weight="800"
          font-size="15" fill="#FFFFFF" letter-spacing="2">
      SCAN TO CALL OWNER
    </text>

    <!-- ── Medical crosses flanking the QR frame ───────────── -->
    ${cross(leftCrossCx, crossCy)}
    ${cross(rightCrossCx, crossCy)}

    <!-- ── Vehicle number (auto-QR only) ───────────────────── -->
    ${
      showVehicle
        ? `<text x="${W / 2}" y="${BODY_TOP + 22}" text-anchor="middle"
              font-family="Arial, Helvetica, sans-serif" font-weight="900"
              font-size="22" fill="${RED}" letter-spacing="1.4">
              ${escapeXml((vehicleNumber || '').toUpperCase())}
            </text>`
        : ''
    }

    <!-- ── QR image ────────────────────────────────────────── -->
    <image href="data:image/png;base64,${qrPngB64}"
           x="${QR_X}" y="${QR_Y}"
           width="${QR_SIZE}" height="${QR_SIZE}"
           preserveAspectRatio="none"/>

    <!-- ── Corner brackets around the QR frame ─────────────── -->
    <g stroke="${INK}" stroke-width="3" fill="none" stroke-linecap="square">
      <!-- top-left -->
      <path d="M${FRAME_X} ${FRAME_Y} L${FRAME_X + ARM} ${FRAME_Y}"/>
      <path d="M${FRAME_X} ${FRAME_Y} L${FRAME_X} ${FRAME_Y + ARM}"/>
      <!-- top-right -->
      <path d="M${FRAME_X + FRAME_W - ARM} ${FRAME_Y} L${FRAME_X + FRAME_W} ${FRAME_Y}"/>
      <path d="M${FRAME_X + FRAME_W} ${FRAME_Y} L${FRAME_X + FRAME_W} ${FRAME_Y + ARM}"/>
      <!-- bottom-left -->
      <path d="M${FRAME_X} ${FRAME_Y + FRAME_H - ARM} L${FRAME_X} ${FRAME_Y + FRAME_H}"/>
      <path d="M${FRAME_X} ${FRAME_Y + FRAME_H} L${FRAME_X + ARM} ${FRAME_Y + FRAME_H}"/>
      <!-- bottom-right -->
      <path d="M${FRAME_X + FRAME_W - ARM} ${FRAME_Y + FRAME_H} L${FRAME_X + FRAME_W} ${FRAME_Y + FRAME_H}"/>
      <path d="M${FRAME_X + FRAME_W} ${FRAME_Y + FRAME_H - ARM} L${FRAME_X + FRAME_W} ${FRAME_Y + FRAME_H}"/>
    </g>

    <!-- ── "Extension Number" label ─────────────────────────── -->
    <text x="${W / 2}" y="${EXT_LABEL_Y}" text-anchor="middle"
          font-family="Arial, Helvetica, sans-serif" font-weight="700"
          font-size="14" fill="${INK}">
      Extension Number
    </text>

    <!-- ── Red pill with digits ─────────────────────────────── -->
    <rect x="${W / 2 - 60}" y="${EXT_PILL_Y}" width="120" height="${EXT_PILL_H}"
          rx="8" ry="8" fill="${RED}"/>
    <text x="${W / 2}" y="${EXT_PILL_Y + 26}" text-anchor="middle"
          font-family="Arial, Helvetica, sans-serif" font-weight="900"
          font-size="22" fill="${INK}" letter-spacing="2.5">
      ${escapeXml(digits || '—')}
    </text>

    <!-- ── Brand tagline ────────────────────────────────────── -->
    <text x="${W / 2}" y="${BRAND_Y}" text-anchor="middle"
          font-family="Arial, Helvetica, sans-serif" font-weight="900"
          font-size="34" fill="${INK}" letter-spacing="1.6">
      BE NAYAK
    </text>

    <!-- ── Black footer ─────────────────────────────────────── -->
    <rect x="0" y="${FOOTER_Y}" width="${W}" height="${H - FOOTER_Y}" fill="#000000"/>

    <!-- Website + email row -->
    <text x="${W / 2}" y="${FOOTER_Y + 18}" text-anchor="middle"
          font-family="Arial, Helvetica, sans-serif" font-weight="700"
          font-size="9" fill="#FFFFFF">
      <tspan>&#127760;</tspan>
      <tspan dx="3">www.qr4emergency.com</tspan>
      <tspan dx="6" fill="${GREEN}">&#8226;</tspan>
      <tspan dx="4" fill="#FFFFFF99">|</tspan>
      <tspan dx="4" fill="${GREEN}">&#8226;</tspan>
      <tspan dx="6">&#9993;</tspan>
      <tspan dx="3">support@qr4emergency.com</tspan>
    </text>

    <!-- Feature badges -->
    <g font-family="Arial, Helvetica, sans-serif" font-weight="800"
       font-size="9" fill="#FFFFFF" letter-spacing="0.6">
      <text x="${W * 0.20}" y="${FOOTER_Y + 44}" text-anchor="middle">
        <tspan fill="${RED}">&#9888;</tspan>
        <tspan dx="3">ACCIDENT</tspan>
      </text>
      <text x="${W * 0.50}" y="${FOOTER_Y + 44}" text-anchor="middle">
        <tspan fill="${GREEN}">&#9679;</tspan>
        <tspan dx="3">TRACKING</tspan>
      </text>
      <text x="${W * 0.80}" y="${FOOTER_Y + 44}" text-anchor="middle">
        <tspan fill="${RED}">&#8416;</tspan>
        <tspan dx="3">NO PARKING</tspan>
      </text>
      <!-- Thin dividers between badges -->
      <line x1="${W * 0.34}" y1="${FOOTER_Y + 34}" x2="${W * 0.34}" y2="${FOOTER_Y + 50}"
            stroke="#FFFFFF" stroke-opacity="0.25" stroke-width="1"/>
      <line x1="${W * 0.66}" y1="${FOOTER_Y + 34}" x2="${W * 0.66}" y2="${FOOTER_Y + 50}"
            stroke="#FFFFFF" stroke-opacity="0.25" stroke-width="1"/>
    </g>
  </g>
</svg>`;
}

// Bare minimum XML escape for text nodes — we only ever pass user data
// through here for the vehicle number and digits, both of which are
// heavily constrained upstream, but treating them as untrusted keeps
// the door closed anyway.
function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Rasterize one printable sticker to a PNG buffer.
 *
 * @param {object} opts
 * @param {string} opts.alertUrl — URL encoded into the QR
 * @param {string|number} opts.digits — extension number shown in the pill
 * @param {boolean} [opts.isManual=true] — hides vehicle number when true
 * @param {string} [opts.vehicleNumber] — auto-QR case only
 * @returns {Promise<Buffer>} PNG bytes
 */
export async function renderStickerPng({
  alertUrl,
  digits,
  isManual = true,
  vehicleNumber = '',
}) {
  // Slightly higher error correction than raw ZIP path because the
  // sticker overlays no logo but does get printed onto vinyl that can
  // scratch — Q gives ~25% redundancy vs M's ~15%.
  const qrBuffer = await QRCode.toBuffer(alertUrl, {
    type: 'png',
    width: 440,
    margin: 0,
    errorCorrectionLevel: 'Q',
  });

  const showVehicle =
    !isManual && vehicleNumber && vehicleNumber.trim().length > 0;

  const svg = buildStickerSvg({
    qrPngB64: qrBuffer.toString('base64'),
    digits: String(digits ?? ''),
    showVehicle,
    vehicleNumber,
  });

  return sharp(Buffer.from(svg)).png().toBuffer();
}
