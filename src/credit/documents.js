// Intelligent document management: type catalog, keyword classifier,
// per-client required-document checklists and status/expiry tracking.

export const DOCUMENT_STATUSES = ['received', 'in-review', 'verified', 'rejected', 'expired'];
export const ALLOWED_MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/tiff', 'text/plain', 'text/csv', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];

export const DOCUMENT_TYPES = {
  'articles-of-formation': { title: 'Articles of organization / incorporation', keywords: ['articles of organization', 'articles of incorporation', 'certificate of formation', 'certificate of incorporation', 'articles'] },
  'ein-letter': { title: 'IRS EIN confirmation (CP 575 / 147C)', keywords: ['cp 575', 'cp575', '147c', 'employer identification number', 'ein letter', 'ein confirmation', 'ein'] },
  'operating-agreement': { title: 'Operating agreement / bylaws', keywords: ['operating agreement', 'bylaws'] },
  'good-standing': { title: 'Certificate of good standing', keywords: ['good standing', 'certificate of status', 'certificate of existence'] },
  'business-license': { title: 'Business license / permit', keywords: ['business license', 'license', 'permit'] },
  'bank-statement': { title: 'Business bank statement', keywords: ['bank statement', 'statement period', 'beginning balance', 'ending balance', 'statement'], maxAgeDays: 90 },
  'tax-return': { title: 'Business tax return', keywords: ['form 1120', '1120s', '1120-s', 'form 1065', 'schedule c', 'tax return'] },
  'profit-loss': { title: 'Profit & loss statement', keywords: ['profit and loss', 'profit & loss', 'p&l', 'pnl', 'income statement'], maxAgeDays: 120 },
  'balance-sheet': { title: 'Balance sheet', keywords: ['balance sheet', 'total liabilities', "owner's equity"], maxAgeDays: 120 },
  'address-proof': { title: 'Proof of business address (lease or utility bill)', keywords: ['lease agreement', 'commercial lease', 'utility bill', 'electric bill', 'lease', 'utility'] },
  'owner-id': { title: 'Owner government-issued ID', keywords: ["driver's license", 'drivers license', 'driver license', 'passport', 'state id'] },
  'voided-check': { title: 'Voided business check', keywords: ['voided check', 'void check', 'voided'] },
  other: { title: 'Other', keywords: [] },
};

const norm = (s) => String(s ?? '').toLowerCase().replace(/[_\-.]+/g, ' ');

/**
 * Classify a document from its filename and an optional text sample (OCR or
 * extracted text). Longer keyword hits and text-body hits weigh more.
 */
export function classifyDocument({ filename = '', text = '', mimeType } = {}) {
  const name = norm(filename);
  const body = norm(text).slice(0, 20_000);
  const scores = Object.entries(DOCUMENT_TYPES).filter(([id]) => id !== 'other').map(([id, def]) => {
    let score = 0;
    for (const k of def.keywords) {
      const w = k.split(' ').length;
      if (name.includes(k)) score += 2 * w;
      if (body && body.includes(k)) score += 3 * w;
    }
    return { type: id, score };
  }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  const top = scores[0];
  const second = scores[1]?.score ?? 0;
  const confidence = top ? Math.min(0.99, Math.round((0.5 + (top.score - second) / (top.score + 4)) * 100) / 100) : 0;
  return {
    type: top?.type ?? 'other',
    confidence,
    candidates: scores.slice(0, 3).map((s) => ({ type: s.type, score: s.score })),
    mimeAllowed: mimeType == null || ALLOWED_MIME_TYPES.includes(mimeType),
  };
}

/** Required-document checklist for a client, driven by profile and target funding categories. */
export function requiredDocuments(profile = {}, { targetCategories = [] } = {}) {
  const req = [
    { type: 'articles-of-formation', count: 1, reason: 'Proves the entity exists' },
    { type: 'ein-letter', count: 1, reason: 'Proves the EIN belongs to the entity' },
    { type: 'owner-id', count: 1, reason: 'Identity verification (KYC)' },
    { type: 'address-proof', count: 1, reason: 'Verifies the business address' },
    { type: 'bank-statement', count: 3, reason: 'Last 3 months of business bank statements' },
  ];
  if (['llc', 's-corp', 'c-corp', 'partnership'].includes(profile.entityType)) req.push({ type: 'operating-agreement', count: 1, reason: 'Shows ownership and signing authority' });
  if (Array.isArray(profile.licenses) && profile.licenses.length) req.push({ type: 'business-license', count: profile.licenses.length, reason: 'Industry licensing' });
  const lending = targetCategories.some((c) => ['sba', 'traditional', 'line-of-credit', 'equipment-financing'].includes(c));
  if (lending) {
    req.push({ type: 'tax-return', count: 2, reason: 'Two years of business tax returns for underwriting' });
    req.push({ type: 'profit-loss', count: 1, reason: 'Year-to-date P&L' });
    req.push({ type: 'balance-sheet', count: 1, reason: 'Current balance sheet' });
    req.push({ type: 'good-standing', count: 1, reason: 'Lenders require proof of good standing' });
  }
  if (targetCategories.includes('cash-financing')) req.push({ type: 'voided-check', count: 1, reason: 'ACH setup for repayments' });
  return req.map((r) => ({ ...r, title: DOCUMENT_TYPES[r.type].title }));
}

/** Apply expiry rules (e.g. bank statements older than 90 days) as of a date. */
export function effectiveStatus(doc, asOf = new Date()) {
  const def = DOCUMENT_TYPES[doc.type];
  if (doc.status === 'rejected') return 'rejected';
  if (doc.expiresAt && new Date(doc.expiresAt) < asOf) return 'expired';
  const dated = doc.documentDate ?? doc.uploadedAt;
  if (def?.maxAgeDays && dated && (asOf - new Date(dated)) / 86_400_000 > def.maxAgeDays) return 'expired';
  return doc.status;
}

/** Merge requirements with uploaded documents into a checklist with completion. */
export function documentChecklist(required, documents = [], { asOf = new Date() } = {}) {
  const items = required.map((r) => {
    const docs = documents.filter((d) => d.type === r.type).map((d) => ({ ...d, effectiveStatus: effectiveStatus(d, asOf) }));
    const verified = docs.filter((d) => d.effectiveStatus === 'verified').length;
    const pending = docs.filter((d) => ['received', 'in-review'].includes(d.effectiveStatus)).length;
    const status = verified >= r.count ? 'complete' : verified + pending >= r.count ? 'pending-review' : docs.some((d) => d.effectiveStatus === 'expired') ? 'expired' : docs.some((d) => d.effectiveStatus === 'rejected') ? 'rejected' : 'missing';
    return { type: r.type, title: r.title, reason: r.reason, required: r.count, verified, pending, status, documentIds: docs.map((d) => d.id) };
  });
  const done = items.reduce((s, i) => s + Math.min(i.verified, i.required), 0);
  const total = items.reduce((s, i) => s + i.required, 0);
  return { completion: total ? Math.round((done / total) * 100) / 100 : 1, complete: items.every((i) => i.status === 'complete'), items };
}
