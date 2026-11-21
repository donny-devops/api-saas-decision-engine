// Fundable Foundation Builder: the business-credibility checklist lenders and
// bureaus look at before any tradeline matters, scored 0-100.
// Each check returns 1 (met), 0.5 (partially met) or 0 (missing).

const FREE_EMAIL = /@(gmail|yahoo|hotmail|outlook|aol|icloud|proton(mail)?|live|msn|gmx|yandex|mail)\./i;

export const FOUNDATION_CHECKLIST = [
  {
    id: 'entity', weight: 12, title: 'Registered business entity',
    remediation: 'Form an LLC or corporation so business credit is separate from personal credit.',
    check: (p) => (['llc', 's-corp', 'c-corp', 'partnership', 'nonprofit'].includes(p.entityType) ? 1 : 0),
  },
  {
    id: 'good-standing', weight: 8, title: 'Entity in good standing with the Secretary of State',
    remediation: 'File annual reports and confirm active/good-standing status with your state.',
    check: (p) => (p.goodStanding === true ? 1 : p.goodStanding == null ? 0.5 : 0),
  },
  {
    id: 'ein', weight: 12, title: 'Federal EIN on file',
    remediation: 'Obtain an EIN from the IRS and use it (not an SSN) on every credit application.',
    check: (p) => (p.ein || p.einLast4 ? 1 : 0),
  },
  {
    id: 'business-address', weight: 8, title: 'Commercial or virtual-office business address',
    remediation: 'Use a commercial or virtual-office address; P.O. boxes are rejected and home addresses hurt.',
    check: (p) => (p.addressType === 'commercial' || p.addressType === 'virtual-office' ? 1 : p.addressType === 'residential' ? 0.5 : 0),
  },
  {
    id: 'business-phone', weight: 8, title: 'Dedicated business phone listed in directory assistance (411)',
    remediation: 'Get a dedicated business number and list it with directory assistance under the exact legal name.',
    check: (p) => (p.phone && p.phoneListed ? 1 : p.phone ? 0.5 : 0),
  },
  {
    id: 'website', weight: 6, title: 'Professional website on its own domain',
    remediation: 'Publish a website on your own domain showing the same name, address and phone.',
    check: (p) => (p.website ? 1 : 0),
  },
  {
    id: 'business-email', weight: 6, title: 'Email on the business domain',
    remediation: 'Use an address on your website domain instead of a free webmail account.',
    check: (p) => (!p.email ? 0 : FREE_EMAIL.test(p.email) ? 0.5 : 1),
  },
  {
    id: 'business-bank-account', weight: 12, title: 'Business bank account in the legal name',
    remediation: 'Open a business checking account under the legal name and EIN; run all revenue through it.',
    check: (p) => (p.businessBankAccount ? 1 : 0),
  },
  {
    id: 'licenses', weight: 6, title: 'Required licenses and permits',
    remediation: 'Obtain the federal, state and local licenses your industry requires.',
    check: (p) => (p.licensesNotRequired || (Array.isArray(p.licenses) && p.licenses.length) ? 1 : 0),
  },
  {
    id: 'duns-number', weight: 8, title: 'D-U-N-S number / bureau file established',
    remediation: 'Register for a free D-U-N-S number so tradelines have a file to report to.',
    check: (p) => (p.dunsNumber ? 1 : 0),
  },
  {
    id: 'business-age', weight: 8, title: 'Time in business',
    remediation: 'Time in business cannot be rushed; keep the entity active and build history now.',
    check: (p) => (p.businessAgeMonths == null ? 0 : p.businessAgeMonths >= 24 ? 1 : p.businessAgeMonths >= 6 ? 0.5 : 0),
  },
  {
    id: 'revenue-documented', weight: 6, title: 'Documented business revenue',
    remediation: 'Deposit revenue into the business account and keep monthly statements and P&Ls.',
    check: (p) => (p.annualRevenue > 0 && p.businessBankAccount ? 1 : p.annualRevenue > 0 ? 0.5 : 0),
  },
];

export const FOUNDATION_GRADES = [
  { min: 85, grade: 'fundable', label: 'Fundable foundation' },
  { min: 65, grade: 'nearly-fundable', label: 'Nearly fundable' },
  { min: 40, grade: 'building', label: 'Foundation in progress' },
  { min: 0, grade: 'foundation-needed', label: 'Foundation needed' },
];

/** Score a business profile against the foundation checklist. */
export function scoreFoundation(profile = {}) {
  const items = FOUNDATION_CHECKLIST.map((c) => {
    const credit = c.check(profile);
    return {
      id: c.id, title: c.title, weight: c.weight, credit,
      points: Math.round(c.weight * credit * 10) / 10,
      status: credit === 1 ? 'complete' : credit > 0 ? 'partial' : 'missing',
      ...(credit < 1 ? { remediation: c.remediation } : {}),
    };
  });
  const maxScore = FOUNDATION_CHECKLIST.reduce((s, c) => s + c.weight, 0);
  const score = Math.round((items.reduce((s, i) => s + i.points, 0) / maxScore) * 100);
  const { grade, label } = FOUNDATION_GRADES.find((g) => score >= g.min);
  const nextActions = items.filter((i) => i.status !== 'complete')
    .sort((a, b) => (b.weight * (1 - b.credit)) - (a.weight * (1 - a.credit)))
    .map((i) => ({ id: i.id, title: i.title, pointsAvailable: Math.round(i.weight * (1 - i.credit) * 10) / 10, remediation: i.remediation }));
  return {
    score, grade, label,
    completed: items.filter((i) => i.status === 'complete').length,
    total: items.length,
    items, nextActions,
  };
}
