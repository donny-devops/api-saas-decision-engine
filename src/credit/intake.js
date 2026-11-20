// AI-assisted client intake: structured business/EIN profile, free-text
// extraction and validation. Pure (no Node/DOM APIs) so it runs anywhere the
// engine runs. The optional LLM extractor lives in service.js and is merged
// over these deterministic results.

export const ENTITY_TYPES = ['llc', 's-corp', 'c-corp', 'partnership', 'nonprofit', 'sole-proprietorship'];

export const US_STATES = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut',
  DE: 'delaware', DC: 'district of columbia', FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois',
  IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland',
  MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi', MO: 'missouri', MT: 'montana',
  NE: 'nebraska', NV: 'nevada', NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico', NY: 'new york',
  NC: 'north carolina', ND: 'north dakota', OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania',
  RI: 'rhode island', SC: 'south carolina', SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah',
  VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming', PR: 'puerto rico',
};

// IRS-assigned EIN prefixes ("campus codes"). Anything else cannot be a real EIN.
const EIN_PREFIXES = new Set([
  ...range(1, 6), ...range(10, 16), ...range(20, 27), ...range(30, 48), ...range(50, 68),
  ...range(71, 77), ...range(80, 88), ...range(90, 95), 98, 99,
].map((n) => String(n).padStart(2, '0')));

const FREE_EMAIL = /@(gmail|yahoo|hotmail|outlook|aol|icloud|proton(mail)?|live|msn|gmx|yandex|mail)\.[a-z.]+$/i;
const PO_BOX = /\b(p\.?\s*o\.?\s*box|post\s+office\s+box)\b/i;
const ADDRESS_TYPES = ['commercial', 'virtual-office', 'residential', 'po-box'];

function range(a, b) { return Array.from({ length: b - a + 1 }, (_, i) => a + i); }

export function normalizeEin(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  return digits.length === 9 ? `${digits.slice(0, 2)}-${digits.slice(2)}` : null;
}

export function isValidEin(raw) {
  const ein = normalizeEin(raw);
  return !!ein && EIN_PREFIXES.has(ein.slice(0, 2)) && !/^(\d)\1-\1{7}$/.test(ein);
}

export const maskEin = (ein) => (ein ? `**-***${String(ein).slice(-4)}` : null);

export function normalizePhone(raw) {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null;
}

export function normalizeState(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (US_STATES[s.toUpperCase()]) return s.toUpperCase();
  const hit = Object.entries(US_STATES).find(([, name]) => name === s.toLowerCase());
  return hit ? hit[0] : null;
}

export function normalizeEntityType(raw) {
  const s = String(raw ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return null;
  if (/^(llc|limitedliabilitycompany)$/.test(s)) return 'llc';
  if (/^(scorp|scorporation)$/.test(s)) return 's-corp';
  if (/^(ccorp|ccorporation|corporation|corp|inc|incorporated)$/.test(s)) return 'c-corp';
  if (/partnership|^lp$|^llp$/.test(s)) return 'partnership';
  if (/nonprofit|501c3/.test(s)) return 'nonprofit';
  if (/soleprop|soleproprietor|soleproprietorship|dba/.test(s)) return 'sole-proprietorship';
  return null;
}

const money = (s) => {
  const m = String(s).replace(/[$,\s]/g, '').match(/^(\d+(?:\.\d+)?)([kmb])?$/i);
  if (!m) return null;
  return Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]?.toLowerCase()] ?? 1);
};

/**
 * Deterministic "AI-assisted" extraction from free text (emails, intake call
 * notes, form dumps). Each field carries a confidence so a reviewer or an LLM
 * pass can override low-confidence values.
 */
export function extractIntakeFromText(text = '') {
  const t = String(text).slice(0, 20_000);
  const fields = {};
  const set = (k, value, confidence) => { if (value != null && value !== '' && !(k in fields)) fields[k] = { value, confidence }; };

  const ein = t.match(/\b(?:EIN|FEIN|TIN|tax\s*id)[^\d]{0,15}(\d{2}-?\d{7})\b/i) ?? t.match(/\b(\d{2}-\d{7})\b/);
  if (ein) set('ein', normalizeEin(ein[1]), /EIN|FEIN|TIN|tax/i.test(ein[0]) ? 0.95 : 0.7);

  const name = t.match(/\b(?:legal\s+name|business\s+name|company(?:\s+name)?)\s*[:\-]\s*([^\n,;]{2,120}?)(?=\.\s|\.$|[\n,;]|$)/i)
    ?? t.match(/\b([A-Z][\w&'. -]{1,80}?\s(?:LLC|L\.L\.C\.|Inc\.?|Corp\.?|Corporation|LLP|LP|Co\.))(?=[\s,.;]|$)/);
  if (name) set('legalName', name[1].trim().replace(/[\s,;]+$/, ''), 0.8);

  const entity = t.match(/\b(LLC|L\.L\.C\.|S[- ]?Corp(?:oration)?|C[- ]?Corp(?:oration)?|Inc(?:orporated)?|Corporation|Partnership|LLP|Sole\s+Proprietor(?:ship)?|Non-?profit|501\(c\)\(3\))\b/i);
  if (entity) set('entityType', normalizeEntityType(entity[1].replace(/\(|\)/g, '')), 0.85);

  const email = t.match(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/);
  if (email) set('email', email[0].toLowerCase(), 0.95);
  const phone = t.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/);
  if (phone) set('phone', normalizePhone(phone[0]), 0.85);
  const site = t.match(/(?:https?:\/\/(?:www\.)?|\bwww\.)([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})/i)
    ?? t.match(/(?<![@\w.-])([a-z0-9-]+\.(?:com|net|org|io|co|biz|us|ai|app|dev))\b/i);
  if (site) set('website', `https://${site[1].toLowerCase()}`, /www\.|https?:/i.test(site[0]) ? 0.9 : 0.7);

  const stateName = t.match(/\b(?:state\s+of\s+(?:formation|incorporation)|incorporated\s+in|formed\s+in|registered\s+in|organized\s+in)\s*[:\-]?\s*([A-Za-z ]{2,20})/i);
  if (stateName) set('state', normalizeState(stateName[1].trim().split(/\s+(?:on|in|with)\b/)[0]) ?? normalizeState(stateName[1].trim().split(' ')[0]), 0.85);

  const founded = t.match(/\b(?:founded|formed|incorporated|established|started|opened)\b[^\d]{0,25}((?:19|20)\d{2})(?:-(\d{2}))?/i);
  if (founded) set('formationDate', `${founded[1]}-${founded[2] ?? '01'}-01`, founded[2] ? 0.85 : 0.6);

  const revenue = t.match(/\$\s?([\d,.]+\s?[kmb]?)\s*(?:in\s+)?(?:annual|yearly|per\s+year|a\s+year|\/yr|revenue|in\s+sales)/i)
    ?? t.match(/\b(?:annual\s+)?revenue[^$\d]{0,20}\$?\s?([\d,.]+\s?[kmb]?)/i);
  if (revenue) set('annualRevenue', money(revenue[1]), 0.75);

  const naics = t.match(/\bNAICS[^\d]{0,10}(\d{6})\b/i);
  if (naics) set('naics', naics[1], 0.95);
  const duns = t.match(/\b(?:DUNS|D-U-N-S)[^\d]{0,10}(\d{2}-?\d{3}-?\d{4})\b/i);
  if (duns) set('dunsNumber', duns[1].replace(/\D/g, ''), 0.95);
  const employees = t.match(/\b(\d{1,5})\s+(?:employees|staff|team\s+members|FTEs?)\b/i);
  if (employees) set('employees', Number(employees[1]), 0.8);

  if (/\bbusiness\s+(?:bank\s+)?(?:checking|bank\s+account)\b/i.test(t) && !/\bno\s+business\s+(?:bank|checking)/i.test(t)) set('businessBankAccount', true, 0.6);
  if (PO_BOX.test(t)) set('addressType', 'po-box', 0.9);

  return { fields, values: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.value])), source: 'rules' };
}

/** Months between an ISO date and `asOf` (ISO yyyy-mm-dd), floored, never negative. */
export function monthsSince(iso, asOf) {
  if (!iso) return null;
  const a = new Date(iso);
  const b = asOf ? new Date(asOf) : new Date();
  if (Number.isNaN(a.getTime())) return null;
  return Math.max(0, (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()));
}

/**
 * Validate and normalise an intake payload into a business profile.
 * Errors block client creation; warnings feed the foundation builder.
 */
export function validateIntake(input = {}, { asOf, einOnFile = false } = {}) {
  const errors = [];
  const warnings = [];
  const p = { ...input };

  p.legalName = typeof p.legalName === 'string' ? p.legalName.trim().slice(0, 200) : '';
  if (!p.legalName) errors.push('legalName is required');

  if (p.ein == null || p.ein === '') { if (!einOnFile) errors.push('ein is required'); }
  else if (!isValidEin(p.ein)) errors.push('ein is not a valid IRS EIN (expected XX-XXXXXXX with an IRS-assigned prefix)');
  else p.ein = normalizeEin(p.ein);

  const entity = normalizeEntityType(p.entityType);
  if (!entity) errors.push(`entityType must be one of ${ENTITY_TYPES.join(', ')}`);
  else p.entityType = entity;

  const state = normalizeState(p.state);
  if (!state) errors.push('state must be a US state code or name');
  else p.state = state;

  if (p.formationDate != null) {
    if (Number.isNaN(new Date(p.formationDate).getTime())) errors.push('formationDate must be an ISO date');
    else {
      p.businessAgeMonths = monthsSince(p.formationDate, asOf);
      if (p.businessAgeMonths < 24) warnings.push('Business is under 24 months old; many lenders require 2+ years');
    }
  } else warnings.push('formationDate missing: business age cannot be scored');

  if (p.phone != null) {
    const ph = normalizePhone(p.phone);
    if (!ph) errors.push('phone must be a 10-digit US number');
    else p.phone = ph;
  } else warnings.push('No business phone number');

  if (p.email != null) {
    if (!/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(String(p.email))) errors.push('email is invalid');
    else if (FREE_EMAIL.test(p.email)) warnings.push('Free email domain: use an address on your own business domain');
  }
  if (p.website != null && !/^https?:\/\/[\w.-]+\.[a-z]{2,}/i.test(String(p.website))) errors.push('website must be an http(s) URL');
  if (p.naics != null && !/^\d{6}$/.test(String(p.naics))) errors.push('naics must be a 6-digit code');
  if (p.dunsNumber != null && !/^\d{9}$/.test(String(p.dunsNumber).replace(/\D/g, ''))) errors.push('dunsNumber must be 9 digits');
  else if (p.dunsNumber != null) p.dunsNumber = String(p.dunsNumber).replace(/\D/g, '');

  for (const k of ['annualRevenue', 'monthlyRevenue', 'employees']) {
    if (p[k] != null && !(typeof p[k] === 'number' && p[k] >= 0)) errors.push(`${k} must be a non-negative number`);
  }
  if (p.annualRevenue != null && p.monthlyRevenue == null) p.monthlyRevenue = Math.round(p.annualRevenue / 12);

  if (p.address) {
    const line = [p.address.line1, p.address.line2].filter(Boolean).join(' ');
    if (PO_BOX.test(line)) p.addressType = 'po-box';
    if (p.address.state) p.address.state = normalizeState(p.address.state) ?? p.address.state;
  }
  if (p.addressType != null && !ADDRESS_TYPES.includes(p.addressType)) errors.push(`addressType must be one of ${ADDRESS_TYPES.join(', ')}`);
  if (p.addressType === 'po-box') warnings.push('P.O. box addresses are not accepted by most lenders and bureaus');
  if (p.addressType === 'residential') warnings.push('Residential address: consider a commercial or virtual-office address');

  if (p.owners != null) {
    if (!Array.isArray(p.owners)) errors.push('owners must be an array');
    else {
      if (p.owners.some((o) => 'ssn' in o)) errors.push('Do not send owner SSNs to this API');
      const total = p.owners.reduce((s, o) => s + (Number(o.ownershipPct) || 0), 0);
      if (total > 100.0001) errors.push('owners ownershipPct sums to more than 100');
    }
  }
  if (p.entityType === 'sole-proprietorship') warnings.push('Sole proprietorships cannot separate business and personal credit; form an LLC or corporation');

  return { valid: errors.length === 0, errors, warnings, profile: p };
}
