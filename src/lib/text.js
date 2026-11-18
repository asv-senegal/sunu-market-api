export const slugify = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[’']/g, '-').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Numéros mobiles sénégalais : 70, 71, 75, 76, 77, 78 (+221 et 9 chiffres)
export function normalizePhone(input) {
  let d = String(input || '').replace(/[^\d+]/g, '');
  if (d.startsWith('00221')) d = '+' + d.slice(2);
  if (!d.startsWith('+')) d = d.length === 9 ? '+221' + d : '+' + d;
  return /^\+2217[015678]\d{7}$/.test(d) ? d : null;
}
