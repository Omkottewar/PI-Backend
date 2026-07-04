/**
 * Normalise any Indian mobile number to E.164 (+91XXXXXXXXXX).
 * Used both to store CallFrom in caller_activity (so the same phone
 * always upserts to the same row) and to hand numbers to Exotel's
 * Fetch-destination applet, which requires E.164.
 *
 * Accepts:
 *   "9156250188"        -> "+919156250188"   (10-digit, no CC)
 *   "919156250188"      -> "+919156250188"   (12-digit, 91 prefix)
 *   "09156250188"       -> "+919156250188"   (STD 0 prefix)
 *   "+919156250188"     -> "+919156250188"   (already E.164)
 *   "+91 91562 50188"   -> "+919156250188"   (spaces/hyphens tolerated)
 *   ""  | null | undef  -> ""
 *
 * Non-Indian or malformed strings are returned as best-effort E.164 if
 * they're at least 10 digits, otherwise returned verbatim so we never
 * silently drop a value we don't understand.
 */
export function normalizeIndianMobile(input) {
  if (input == null) return '';
  const raw = String(input).trim();
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `+91${digits.slice(1)}`;
  if (digits.length >= 10) return `+${digits}`; // international, best-effort
  return raw; // give up — don't corrupt the value
}
