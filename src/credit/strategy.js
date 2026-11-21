// Funding strategy output and the strategy-session data model. A session is a
// scheduled review whose deliverable is a written strategy summary; this
// module only produces and validates that data (no live/realtime component).

export const SESSION_STATUSES = ['scheduled', 'completed', 'cancelled', 'no-show'];
export const SESSION_TYPES = ['funding-strategy', 'credit-review', 'document-review'];

/** Validate a strategy-session payload. Returns { errors, session }. */
export function validateSession(input = {}, { now = new Date() } = {}) {
  const errors = [];
  const s = {
    type: input.type ?? 'funding-strategy',
    scheduledFor: input.scheduledFor,
    durationMinutes: input.durationMinutes ?? 45,
    timezone: input.timezone ?? 'America/New_York',
    agenda: Array.isArray(input.agenda) ? input.agenda.map(String).slice(0, 20) : [],
    attendees: Array.isArray(input.attendees) ? input.attendees.map(String).slice(0, 10) : [],
  };
  if (!SESSION_TYPES.includes(s.type)) errors.push(`type must be one of ${SESSION_TYPES.join(', ')}`);
  const at = new Date(s.scheduledFor);
  if (!s.scheduledFor || Number.isNaN(at.getTime())) errors.push('scheduledFor must be an ISO date-time');
  else if (at < now) errors.push('scheduledFor must be in the future');
  else s.scheduledFor = at.toISOString();
  if (!Number.isInteger(s.durationMinutes) || s.durationMinutes < 15 || s.durationMinutes > 180) errors.push('durationMinutes must be an integer between 15 and 180');
  try { new Intl.DateTimeFormat('en-US', { timeZone: s.timezone }); } catch { errors.push('timezone must be an IANA zone'); }
  return { errors, session: s };
}

/**
 * Turn a full client evaluation into a phased funding strategy.
 * @param {{profile, foundation, credit, builder, funding, documents, stage}} ev
 */
export function buildFundingStrategy(ev) {
  const { foundation, builder, funding, documents, credit, stage } = ev;
  const eligible = funding.matches.filter((m) => m.decision === 'eligible')
    .sort((a, b) => (b.estimatedAmount?.max ?? 0) - (a.estimatedAmount?.max ?? 0));
  const conditional = funding.matches.filter((m) => m.decision === 'conditional');
  const nextUnlocks = funding.matches.filter((m) => m.decision === 'not-yet' && m.gaps.filter((g) => g.severity === 'block').length <= 2).slice(0, 3);

  const now = [
    ...foundation.nextActions.slice(0, 3).map((a) => `Foundation: ${a.remediation}`),
    ...(documents?.items ?? []).filter((i) => i.status === 'missing' || i.status === 'expired').slice(0, 3).map((i) => `Documents: upload ${i.title} (${i.required - i.verified} needed).`),
  ];
  const next = [
    ...builder.nextSteps.slice(0, 3).map((s) => `Credit builder: ${s}`),
    ...eligible.slice(0, 3).map((m) => `Apply: ${m.title} (est. $${m.estimatedAmount.min.toLocaleString('en-US')}–$${m.estimatedAmount.max.toLocaleString('en-US')}).`),
  ];
  const later = nextUnlocks.map((m) => `Target ${m.title}: ${m.gaps.filter((g) => g.severity === 'block').map((g) => g.description).join('; ')}.`);

  const blockers = [];
  if (foundation.score < 50) blockers.push('Foundation score below 50: most bureaus and vendors will decline until the basics are fixed.');
  if ((credit?.derogatoryCount ?? 0) > 0) blockers.push(`${credit.derogatoryCount} derogatory item(s) on file: resolve before applying for bank or SBA financing.`);
  if ((credit?.utilization ?? 0) > 0.5) blockers.push('Utilization above 50%: pay balances down before new applications.');

  return {
    stage,
    readinessScore: funding.readinessScore,
    headline: eligible.length
      ? `Eligible now for ${eligible.length} product(s) with est. capacity up to $${funding.summary.estimatedCapacity.toLocaleString('en-US')}.`
      : `Not yet fundable: focus on ${stage.replace(/-/g, ' ')}.`,
    phases: [
      { window: '0-30 days', focus: 'Foundation & documents', actions: now },
      { window: '31-90 days', focus: 'Build reporting tradelines & apply where eligible', actions: next },
      { window: '91-180 days', focus: 'Unlock larger funding', actions: later },
    ],
    immediateOpportunities: eligible.map((m) => ({ productId: m.productId, title: m.title, estimatedAmount: m.estimatedAmount })),
    conditionalOpportunities: conditional.map((m) => ({ productId: m.productId, title: m.title, gaps: m.gaps.map((g) => g.description) })),
    targetProducts: nextUnlocks.map((m) => ({ productId: m.productId, title: m.title, gaps: m.gaps.map((g) => g.description) })),
    blockers,
  };
}
