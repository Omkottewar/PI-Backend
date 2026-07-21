// Print-ready sticker renderer — matches the target design 1:1
// (red header, black corner brackets around the QR, symmetric BE NAYAK +
// medical cross + extension pill + medical cross + BE NAYAK row, red
// footer with two icon rows). Rendered by generating an SVG and
// rasterising with sharp — no Material icon font on the server, so all
// icons are drawn as inline SVG paths / primitives.

import QRCode from 'qrcode';
import sharp from 'sharp';

const RED = '#E51E25';
const INK = '#0F1115';
const WHITE = '#FFFFFF';

// Base coordinate space. sharp rasterises this at 3× for print-crisp
// PNGs (~1200×1580 output).
const W = 400;

/**
 * Build the SVG for one sticker.
 *
 * @param {object} opts
 * @param {string} opts.qrPngB64 — base64 of the QR PNG (no data: prefix)
 * @param {string} opts.digits — extension number shown in the pill
 * @param {boolean} [opts.showVehicle] — auto-QR case, prints vehicle number
 * @param {string} [opts.vehicleNumber] — used only when showVehicle
 * @returns {string} SVG document
 */
function buildStickerSvg({ qrPngB64, digits, showVehicle, vehicleNumber }) {
  // Vertical layout — anchors declared top-down so the file reads in
  // the same order as the sticker.
  const HEADER_H = 100;
  const VEHICLE_ROW_H = showVehicle ? 40 : 8; // small gap even when hidden
  const QR_FRAME_TOP = HEADER_H + VEHICLE_ROW_H;
  const QR_FRAME_W = 320;
  const QR_FRAME_H = 320;
  const QR_FRAME_X = (W - QR_FRAME_W) / 2;
  const QR_SIZE = 280;
  const QR_X = (W - QR_SIZE) / 2;
  const QR_Y = QR_FRAME_TOP + (QR_FRAME_H - QR_SIZE) / 2;

  const AFTER_QR_Y = QR_FRAME_TOP + QR_FRAME_H;
  const EXT_LABEL_Y = AFTER_QR_Y + 32;
  const ROW_Y = EXT_LABEL_Y + 18; // top of the extension-row band
  const ROW_H = 44;

  const FOOTER_TOP = ROW_Y + ROW_H + 22;
  const FOOTER_H = 88;
  const H = FOOTER_TOP + FOOTER_H;

  // Bracket arm length — bold Ls at every corner of the QR frame.
  const ARM = 40;
  const BRACKET_W = 6;

  // Medical cross drawn as two overlapping rectangles centred on (cx, cy).
  const cross = (cx, cy, size) => {
    const bar = size * 0.32;
    return `
      <rect x="${cx - bar / 2}" y="${cy - size / 2}" width="${bar}" height="${size}" fill="${RED}"/>
      <rect x="${cx - size / 2}" y="${cy - bar / 2}" width="${size}" height="${bar}" fill="${RED}"/>
    `;
  };

  // Extension pill — white box with red text and thin red border.
  const PILL_W = 130;
  const PILL_H = 42;
  const PILL_X = (W - PILL_W) / 2;
  const PILL_Y = ROW_Y + (ROW_H - PILL_H) / 2;

  // Bottom row horizontal layout: BE NAYAK ... cross ... pill ... cross ... BE NAYAK
  const CROSS_SIZE = 30;
  const leftCrossCx = PILL_X - 22;
  const rightCrossCx = PILL_X + PILL_W + 22;
  const leftLabelX = 14;
  const rightLabelX = W - 14;
  const rowCy = ROW_Y + ROW_H / 2;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W * 3}" height="${H * 3}">
  <defs>
    <clipPath id="card">
      <rect x="0" y="0" width="${W}" height="${H}" rx="22" ry="22"/>
    </clipPath>
  </defs>

  <g clip-path="url(#card)">
    <!-- White base -->
    <rect x="0" y="0" width="${W}" height="${H}" fill="${WHITE}"/>

    <!-- ── Red header band ─────────────────────────────────── -->
    <rect x="0" y="0" width="${W}" height="${HEADER_H}" fill="${RED}"/>
    <text x="${W / 2}" y="58" text-anchor="middle"
          font-family="Arial Black, Arial, Helvetica, sans-serif"
          font-weight="900" font-size="46" fill="${WHITE}"
          letter-spacing="-0.5">
      QR 4 EMERGENCY
    </text>
    <text x="${W / 2}" y="88" text-anchor="middle"
          font-family="Arial, Helvetica, sans-serif" font-weight="800"
          font-size="18" fill="${WHITE}" letter-spacing="2.4">
      SCAN TO CALL OWNER
    </text>

    <!-- ── Vehicle number (auto-QR only) ──────────────────── -->
    ${
      showVehicle
        ? `<text x="${W / 2}" y="${HEADER_H + 30}" text-anchor="middle"
              font-family="Arial Black, Arial, sans-serif" font-weight="900"
              font-size="26" fill="${RED}" letter-spacing="1">
              ${escapeXml((vehicleNumber || '').toUpperCase())}
            </text>`
        : ''
    }

    <!-- ── QR image ─────────────────────────────────────────── -->
    <image href="data:image/png;base64,${qrPngB64}"
           x="${QR_X}" y="${QR_Y}"
           width="${QR_SIZE}" height="${QR_SIZE}"
           preserveAspectRatio="none"/>

    <!-- ── Bold black corner brackets around the QR ─────────── -->
    <g fill="${INK}">
      <!-- top-left: horizontal + vertical arm -->
      <rect x="${QR_FRAME_X}" y="${QR_FRAME_TOP}" width="${ARM}" height="${BRACKET_W}"/>
      <rect x="${QR_FRAME_X}" y="${QR_FRAME_TOP}" width="${BRACKET_W}" height="${ARM}"/>
      <!-- top-right -->
      <rect x="${QR_FRAME_X + QR_FRAME_W - ARM}" y="${QR_FRAME_TOP}" width="${ARM}" height="${BRACKET_W}"/>
      <rect x="${QR_FRAME_X + QR_FRAME_W - BRACKET_W}" y="${QR_FRAME_TOP}" width="${BRACKET_W}" height="${ARM}"/>
      <!-- bottom-left -->
      <rect x="${QR_FRAME_X}" y="${QR_FRAME_TOP + QR_FRAME_H - BRACKET_W}" width="${ARM}" height="${BRACKET_W}"/>
      <rect x="${QR_FRAME_X}" y="${QR_FRAME_TOP + QR_FRAME_H - ARM}" width="${BRACKET_W}" height="${ARM}"/>
      <!-- bottom-right -->
      <rect x="${QR_FRAME_X + QR_FRAME_W - ARM}" y="${QR_FRAME_TOP + QR_FRAME_H - BRACKET_W}" width="${ARM}" height="${BRACKET_W}"/>
      <rect x="${QR_FRAME_X + QR_FRAME_W - BRACKET_W}" y="${QR_FRAME_TOP + QR_FRAME_H - ARM}" width="${BRACKET_W}" height="${ARM}"/>
    </g>

    <!-- ── "Extension Number" label ────────────────────────── -->
    <text x="${W / 2}" y="${EXT_LABEL_Y}" text-anchor="middle"
          font-family="Arial, Helvetica, sans-serif" font-weight="700"
          font-size="18" fill="${INK}">
      Extension Number
    </text>

    <!-- ── Bottom row: BE NAYAK · cross · pill · cross · BE NAYAK ── -->
    <text x="${leftLabelX}" y="${rowCy + 5}" text-anchor="start"
          font-family="Arial Black, Arial, sans-serif" font-weight="900"
          font-size="18" fill="${INK}" letter-spacing="0.5">BE NAYAK</text>
    ${cross(leftCrossCx, rowCy, CROSS_SIZE)}

    <!-- White pill with red text + red border -->
    <rect x="${PILL_X}" y="${PILL_Y}" width="${PILL_W}" height="${PILL_H}"
          rx="6" ry="6" fill="${WHITE}" stroke="${RED}" stroke-width="1.5"/>
    <text x="${W / 2}" y="${PILL_Y + 30}" text-anchor="middle"
          font-family="Arial Black, Arial, sans-serif" font-weight="900"
          font-size="26" fill="${RED}" letter-spacing="1.5">
      ${escapeXml(digits || '—')}
    </text>

    ${cross(rightCrossCx, rowCy, CROSS_SIZE)}
    <text x="${rightLabelX}" y="${rowCy + 5}" text-anchor="end"
          font-family="Arial Black, Arial, sans-serif" font-weight="900"
          font-size="18" fill="${INK}" letter-spacing="0.5">BE NAYAK</text>

    <!-- ── Red footer with two icon rows ───────────────────── -->
    <rect x="0" y="${FOOTER_TOP}" width="${W}" height="${FOOTER_H}" fill="${RED}"/>

    <!-- Row 1: globe + website | mail + email -->
    ${footerRow1(FOOTER_TOP + 20)}

    <!-- Row 2: warning + ACCIDENT | pin + TRACKING | P + NO PARKING,
         separated by thin white vertical dividers -->
    ${footerRow2(FOOTER_TOP + 60)}
  </g>
</svg>`;
}

// ── Footer helpers ────────────────────────────────────────────────

// Row 1 groups: globe icon + website on the left half, mail icon +
// email on the right half. All white on the red footer.
function footerRow1(y) {
  const leftIconX = 22;
  const leftTextX = leftIconX + 22;
  const rightHalfStart = W * 0.52;
  const rightIconX = rightHalfStart;
  const rightTextX = rightIconX + 22;
  return `
    ${iconGlobe(leftIconX, y - 10, 14, WHITE)}
    <text x="${leftTextX}" y="${y + 2}" text-anchor="start"
          font-family="Arial, Helvetica, sans-serif" font-weight="700"
          font-size="13" fill="${WHITE}">www.qr4emergency.com</text>

    ${iconMail(rightIconX, y - 10, 14, WHITE)}
    <text x="${rightTextX}" y="${y + 2}" text-anchor="start"
          font-family="Arial, Helvetica, sans-serif" font-weight="700"
          font-size="13" fill="${WHITE}">support@qr4emergency.com</text>
  `;
}

// Row 2: three feature badges with thin white dividers between them.
function footerRow2(y) {
  const cols = [
    { cx: W * 0.18, icon: iconWarning, label: 'ACCIDENT' },
    { cx: W * 0.50, icon: iconPin, label: 'TRACKING' },
    { cx: W * 0.82, icon: iconParking, label: 'NO PARKING' },
  ];
  const dividers = [W * 0.34, W * 0.66];

  let out = '';
  for (const c of cols) {
    // Icon on the left, label on the right, both centred on cx.
    const iconSize = 16;
    // Approximate label width to place icon + label symmetrically:
    // just offset by fixed amounts, tuned against the reference image.
    const iconX = c.cx - 46;
    const textX = c.cx - 26;
    out += `
      ${c.icon(iconX, y - 12, iconSize, WHITE)}
      <text x="${textX}" y="${y + 2}" text-anchor="start"
            font-family="Arial, Helvetica, sans-serif" font-weight="800"
            font-size="14" fill="${WHITE}" letter-spacing="0.4">${c.label}</text>
    `;
  }
  for (const dx of dividers) {
    out += `<line x1="${dx}" y1="${y - 14}" x2="${dx}" y2="${y + 8}"
                   stroke="${WHITE}" stroke-opacity="0.55" stroke-width="1"/>`;
  }
  return out;
}

// ── Inline icons (Material-style, drawn as SVG primitives) ────────
// All take (x, y, size, color) and render inside a size×size box.

function iconGlobe(x, y, s, c) {
  const r = s / 2;
  const cx = x + r;
  const cy = y + r;
  return `
    <g stroke="${c}" stroke-width="1.2" fill="none">
      <circle cx="${cx}" cy="${cy}" r="${r - 0.6}"/>
      <ellipse cx="${cx}" cy="${cy}" rx="${(r - 0.6) * 0.5}" ry="${r - 0.6}"/>
      <line x1="${x + 0.6}" y1="${cy}" x2="${x + s - 0.6}" y2="${cy}"/>
    </g>
  `;
}

function iconMail(x, y, s, c) {
  return `
    <g stroke="${c}" stroke-width="1.2" fill="none" stroke-linejoin="round">
      <rect x="${x + 0.6}" y="${y + s * 0.2}" width="${s - 1.2}" height="${s * 0.6}" rx="1"/>
      <path d="M${x + 0.6} ${y + s * 0.22} L${x + s / 2} ${y + s * 0.55} L${x + s - 0.6} ${y + s * 0.22}"/>
    </g>
  `;
}

function iconWarning(x, y, s, c) {
  // Filled red-orange triangle with a yellow interior "!".
  const midX = x + s / 2;
  const top = y + 1;
  const bot = y + s - 1;
  const left = x + 1;
  const right = x + s - 1;
  return `
    <g>
      <path d="M${midX} ${top} L${right} ${bot} L${left} ${bot} Z"
            fill="#F4B400" stroke="${c}" stroke-width="1"/>
      <rect x="${midX - 0.7}" y="${top + s * 0.28}" width="1.4" height="${s * 0.32}" fill="${c}"/>
      <rect x="${midX - 0.7}" y="${top + s * 0.68}" width="1.4" height="1.4" fill="${c}"/>
    </g>
  `;
}

function iconPin(x, y, s, c) {
  // Location pin: teardrop-ish shape.
  const cx = x + s / 2;
  const top = y + 1;
  const bot = y + s - 0.5;
  const r = s * 0.32;
  return `
    <g fill="${c}" stroke="${c}" stroke-width="0.8" stroke-linejoin="round">
      <path d="M${cx} ${top}
               C ${cx + r * 1.6} ${top} ${cx + r * 1.6} ${top + r * 2.1} ${cx} ${bot}
               C ${cx - r * 1.6} ${top + r * 2.1} ${cx - r * 1.6} ${top} ${cx} ${top} Z"/>
      <circle cx="${cx}" cy="${top + r * 0.9}" r="${r * 0.4}" fill="${RED}"/>
    </g>
  `;
}

function iconParking(x, y, s, c) {
  // Circle with the letter "P" inside — matches the "no parking" hint
  // in the reference without the diagonal slash (which would clash with
  // the actual value of the badge).
  const r = s / 2 - 0.6;
  const cx = x + s / 2;
  const cy = y + s / 2;
  return `
    <g>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${c}" stroke-width="1.4"/>
      <text x="${cx}" y="${cy + r * 0.7}" text-anchor="middle"
            font-family="Arial Black, Arial, sans-serif" font-weight="900"
            font-size="${s * 0.75}" fill="${c}">P</text>
    </g>
  `;
}

// XML escape for text nodes.
function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Rasterise one printable sticker to a PNG buffer.
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
  // Error correction Q → ~25% redundancy, so a scratched sticker still
  // scans. QR has no logo overlay here, so we could get away with M,
  // but the sticker gets stuck on windshields — dust and abrasion
  // justify the extra safety.
  const qrBuffer = await QRCode.toBuffer(alertUrl, {
    type: 'png',
    width: 560,
    margin: 0,
    errorCorrectionLevel: 'Q',
    color: { dark: INK, light: WHITE },
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
