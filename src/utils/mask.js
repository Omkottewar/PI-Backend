/**
 * Mask full name: "Rajesh Kumar" -> "R** K****"
 */
export function maskFullName(fullName) {
  if (!fullName || typeof fullName !== 'string') return '***';
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '***';
  return parts
    .map((part) => {
      if (part.length <= 1) return `${part}*`;
      const first = part[0];
      return `${first}${'*'.repeat(Math.min(part.length - 1, 4))}`;
    })
    .join(' ');
}

/**
 * Mask mobile: show last 4 digits
 */
export function maskMobile(mobile) {
  if (!mobile) return '**********';
  const digits = String(mobile).replace(/\D/g, '');
  if (digits.length < 4) return '*'.repeat(digits.length || 8);
  const last4 = digits.slice(-4);
  return `${'*'.repeat(Math.max(6, digits.length - 4))}${last4}`;
}
