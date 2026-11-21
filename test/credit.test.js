import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidEin, normalizeEin, maskEin, extractIntakeFromText, validateIntake, scoreFoundation, computeCreditProfile, paydexForDaysLate,
  computeBuilderPlan, matchFunding, creditMetrics, classifyDocument, requiredDocuments, documentChecklist, effectiveStatus,
  validateSession, evaluateClient, routeJourneyStage, FUNDING_PRODUCTS, decide,
} from '../src/credit/index.js';
import { createAgentSystem } from '../src/agents/index.js';
import { openDb } from '../src/db/index.js';
import { CreditService } from '../src/credit/service.js';
import { loadPipelines, runPipeline } from '../src/orchestrator/pipelines.js';

process.env.SECRETS_PROVIDERS = 'env';
const AS_OF = '2026-11-20';

const strongProfile = {
  legalName: 'Sunrise Logistics LLC', einLast4: '4567', entityType: 'llc', state: 'FL', formationDate: '2019-03-01',
  annualRevenue: 480_000, businessBankAccount: true, addressType: 'commercial', phone: '+13055550142', phoneListed: true,
  website: 'https://sunriselogistics.com', email: 'ops@sunriselogistics.com', dunsNumber: '123456789', goodStanding: true, licensesNotRequired: true,
};
const line = (i, category, extra = {}) => ({
  vendor: `Vendor ${i}`, category, creditLimit: 2_000, balance: 300, reportsTo: ['dnb', 'experian'], openedAt: '2025-06-01', status: 'open',
  payments: [{ amount: 500, daysLate: -5 }, { amount: 300, daysLate: 0 }], ...extra,
});
const strongLines = [...[0, 1, 2, 3, 4].map((i) => line(i, 'vendor')), line(5, 'store'), line(6, 'store'), line(7, 'store'), line(8, 'fuel')];

test('EIN validation uses IRS prefixes and is masked on output', () => {
  assert.equal(normalizeEin('461234567'), '46-1234567');
  assert.ok(isValidEin('46-1234567'));
  assert.ok(!isValidEin('00-1234567'), '00 is not an IRS prefix');
  assert.ok(!isValidEin('07-1234567'));
  assert.ok(!isValidEin('12-34567'));
  assert.equal(maskEin('46-1234567'), '**-***4567');
});

test('AI-assisted intake extracts structured fields from free text', () => {
  const { values, fields } = extractIntakeFromText(`Company: Sunrise Logistics LLC. EIN 46-1234567, incorporated in Florida, founded in 2019.
    About $480k annual revenue, 12 employees. ops@sunriselogistics.com, (305) 555-0142, www.sunriselogistics.com. NAICS 484110. D-U-N-S 12-345-6789.`);
  assert.equal(values.ein, '46-1234567');
  assert.equal(values.legalName, 'Sunrise Logistics LLC');
  assert.equal(values.entityType, 'llc');
  assert.equal(values.state, 'FL');
  assert.equal(values.annualRevenue, 480_000);
  assert.equal(values.phone, '+13055550142');
  assert.equal(values.website, 'https://sunriselogistics.com');
  assert.equal(values.naics, '484110');
  assert.equal(values.dunsNumber, '123456789');
  assert.equal(values.employees, 12);
  assert.ok(fields.ein.confidence >= 0.9);
});

test('intake validation: errors block, warnings guide', () => {
  const bad = validateIntake({ legalName: '', ein: '00-0000000', entityType: 'spaceship', state: 'ZZ', owners: [{ name: 'A', ssn: '1' }] });
  assert.equal(bad.valid, false);
  assert.equal(bad.errors.length, 5);
  const ok = validateIntake({ legalName: 'Acme LLC', ein: '461234567', entityType: 'L.L.C.', state: 'florida', formationDate: '2026-01-01', email: 'me@gmail.com', address: { line1: 'PO Box 12' } }, { asOf: AS_OF });
  assert.equal(ok.valid, true);
  assert.equal(ok.profile.ein, '46-1234567');
  assert.equal(ok.profile.state, 'FL');
  assert.equal(ok.profile.addressType, 'po-box');
  assert.equal(ok.profile.businessAgeMonths, 10);
  assert.ok(ok.warnings.some((w) => /Free email/.test(w)));
  assert.ok(ok.warnings.some((w) => /P\.O\. box/.test(w)));
});

test('Fundable Foundation Builder scores the credibility checklist', () => {
  const full = scoreFoundation({ ...strongProfile, businessAgeMonths: 80 });
  assert.equal(full.score, 100);
  assert.equal(full.grade, 'fundable');
  assert.equal(full.nextActions.length, 0);
  const thin = scoreFoundation({ entityType: 'sole-proprietorship', email: 'x@gmail.com' });
  assert.ok(thin.score < 40);
  assert.equal(thin.grade, 'foundation-needed');
  assert.equal(thin.nextActions[0].id, 'entity', 'highest-weight gaps first');
});

test('credit tracking: PAYDEX curve, thin file and bureau-style profile', () => {
  assert.equal(paydexForDaysLate(0), 80);
  assert.equal(paydexForDaysLate(-30), 100);
  assert.equal(paydexForDaysLate(30), 50);
  const thin = computeCreditProfile([line(0, 'vendor')], { asOf: AS_OF });
  assert.equal(thin.scores.paydex.value, null);
  assert.match(thin.scores.paydex.reason, /Needs 3/);
  const p = computeCreditProfile(strongLines, { asOf: AS_OF });
  assert.ok(p.scores.paydex.value > 80, 'early payments lift PAYDEX above 80');
  assert.ok(p.scores.intelliscore.value > 50);
  assert.equal(p.tradelines.reporting.dnb, 9);
  assert.equal(p.monthsOfHistory, 17);
  assert.equal(p.utilization, 0.15);
  assert.equal(p.estimated, true);
  const late = computeCreditProfile([0, 1, 2].map((i) => line(i, 'vendor', { payments: [{ amount: 500, daysLate: 60 }] })), { asOf: AS_OF });
  assert.equal(late.scores.paydex.value, 40);
  assert.equal(late.riskTier, 'high');
});

test('credit criteria run through the existing policy engine', () => {
  const d = decide({ paydex: 70, annualRevenue: null }, [
    { id: 'p', metric: 'paydex', op: '>=', value: 80, description: 'PAYDEX' },
    { id: 'r', metric: 'annualRevenue', op: '>=', value: 1, severity: 'warn' },
  ]);
  assert.equal(d.decision, 'not-yet');
  assert.equal(d.policy.counts.block, 1);
  assert.deepEqual(d.gaps.map((g) => [g.id, g.current]), [['p', 70], ['r', null]]);
});

test('Business Credit Builder walks the tiers', () => {
  const foundation = scoreFoundation({ ...strongProfile, businessAgeMonths: 80 });
  const empty = computeBuilderPlan(creditMetrics({ profile: strongProfile, foundation, credit: computeCreditProfile([]) }), []);
  assert.equal(empty.currentTier, 'tier-1-vendor');
  assert.equal(empty.tiers[0].status, 'active');
  assert.equal(empty.tiers[1].status, 'locked');
  const credit = computeCreditProfile(strongLines, { asOf: AS_OF });
  const plan = computeBuilderPlan(creditMetrics({ profile: strongProfile, foundation, credit }), strongLines);
  assert.equal(plan.tiers[0].status, 'completed');
  assert.equal(plan.tiers[1].status, 'completed');
  assert.equal(plan.currentTier, 'tier-3-fleet-fuel');
  assert.equal(plan.tiers[2].reportingTradelines, 1);
  assert.ok(plan.nextSteps[0].includes('1 more'));
  const blocked = computeBuilderPlan(creditMetrics({ profile: {}, foundation: { score: 20 }, credit: computeCreditProfile([]) }), []);
  assert.equal(blocked.tiers[0].status, 'locked');
  assert.equal(blocked.tiers[0].unlockCriteria[0].metric, 'foundationScore');
});

test('Funding Match: eligibility, gaps, no-PG filter and overrides', () => {
  const foundation = scoreFoundation({ ...strongProfile, businessAgeMonths: 92 });
  const credit = computeCreditProfile(strongLines, { asOf: AS_OF });
  const m = creditMetrics({ profile: { ...strongProfile, businessAgeMonths: 92, monthlyRevenue: 40_000 }, foundation, credit });
  const all = matchFunding(m);
  assert.equal(all.matches.length, FUNDING_PRODUCTS.length);
  assert.ok(all.matches.find((x) => x.productId === 'sba-7a').decision === 'eligible');
  assert.ok(all.readinessScore > 80);
  const noPg = matchFunding(m, { requireNoPg: true });
  assert.ok(noPg.matches.every((x) => x.personalGuarantee === false));
  const strict = matchFunding(m, { overrides: { 'sba-7a': [{ id: 'sbss-299', metric: 'sbss', op: '>=', value: 299 }] } });
  const sba = strict.matches.find((x) => x.productId === 'sba-7a');
  assert.equal(sba.decision, 'not-yet');
  assert.equal(sba.estimatedAmount, null);
  const fresh = matchFunding(creditMetrics({ profile: {}, foundation: { score: 30 }, credit: computeCreditProfile([]) }));
  assert.equal(fresh.summary.eligible, 0);
  assert.equal(fresh.matches.at(-1).decision, 'not-yet');
});

test('document classification, checklist and expiry', () => {
  assert.equal(classifyDocument({ filename: 'CP575_EIN_letter.pdf' }).type, 'ein-letter');
  assert.equal(classifyDocument({ filename: 'scan.pdf', text: 'Statement period ... Beginning balance ... Ending balance' }).type, 'bank-statement');
  assert.equal(classifyDocument({ filename: 'Articles of Organization - FL.pdf' }).type, 'articles-of-formation');
  assert.equal(classifyDocument({ filename: 'IMG_0001.jpg' }).type, 'other');
  assert.equal(classifyDocument({ filename: 'x.exe', mimeType: 'application/x-msdownload' }).mimeAllowed, false);
  const req = requiredDocuments({ entityType: 'llc' }, { targetCategories: ['sba'] });
  assert.ok(req.some((r) => r.type === 'tax-return' && r.count === 2));
  assert.ok(req.some((r) => r.type === 'operating-agreement'));
  const asOf = new Date('2026-11-20');
  assert.equal(effectiveStatus({ type: 'bank-statement', status: 'verified', documentDate: '2026-06-01' }, asOf), 'expired');
  const list = documentChecklist(requiredDocuments({ entityType: 'sole-proprietorship' }), [
    { id: 'a', type: 'ein-letter', status: 'verified', uploadedAt: '2026-11-01' },
    { id: 'b', type: 'owner-id', status: 'received', uploadedAt: '2026-11-01' },
  ], { asOf });
  assert.equal(list.items.find((i) => i.type === 'ein-letter').status, 'complete');
  assert.equal(list.items.find((i) => i.type === 'owner-id').status, 'pending-review');
  assert.equal(list.items.find((i) => i.type === 'bank-statement').status, 'missing');
  assert.equal(list.completion, 0.14);
});

test('strategy sessions validate scheduling data', () => {
  const now = new Date('2026-11-20T12:00:00Z');
  assert.deepEqual(validateSession({ scheduledFor: '2026-12-01T15:00:00Z' }, { now }).errors, []);
  const bad = validateSession({ scheduledFor: '2026-01-01T00:00:00Z', durationMinutes: 5, timezone: 'Mars/Base', type: 'negotiation' }, { now });
  assert.equal(bad.errors.length, 4);
});

test('evaluateClient routes the journey stage and builds a phased strategy', () => {
  const ev = evaluateClient({ profile: strongProfile, tradelines: strongLines, asOf: AS_OF });
  assert.equal(ev.stage, 'funding-ready');
  assert.equal(ev.strategy.phases.length, 3);
  assert.ok(ev.strategy.immediateOpportunities.length > 0);
  assert.ok(ev.strategy.immediateOpportunities[0].estimatedAmount.max >= ev.strategy.immediateOpportunities.at(-1).estimatedAmount.max);
  const fresh = evaluateClient({ profile: { legalName: 'New Co LLC', einLast4: '1111', entityType: 'llc', state: 'TX' }, asOf: AS_OF });
  assert.equal(fresh.stage, 'foundation');
  assert.ok(fresh.strategy.blockers.length);
  assert.equal(routeJourneyStage({ intake: { valid: false, errors: ['ein is required'] }, foundation: {}, builder: {}, funding: {} }).stage, 'intake');
});

test('credit agents join the Agentic Mesh and are callable', async () => {
  const { mesh } = createAgentSystem();
  const names = mesh.list().map((a) => a.name);
  for (const n of ['credit-intake', 'credit-analyst', 'funding-matcher']) assert.ok(names.includes(n));
  const ex = await mesh.call('credit-intake', 'extract', { text: 'Acme Widgets LLC, EIN 46-1234567, incorporated in Texas' });
  assert.equal(ex.extracted.ein, '**-***4567', 'agents never echo raw EINs');
  const match = await mesh.call('funding-matcher', 'match', { profile: strongProfile, tradelines: strongLines, requireNoPg: true });
  assert.ok(match.matches.length > 0);
  const strat = await mesh.call('funding-matcher', 'strategy', { profile: strongProfile, tradelines: strongLines });
  assert.equal(strat.stage, 'funding-ready');
});

test('credit-journey pipeline runs on the DAG engine and persists a snapshot', async () => {
  const db = openDb(':memory:');
  const credit = new CreditService(db);
  const c = await credit.createClient('acct', { legalName: 'Pipeline Co LLC', ein: '46-7654321', entityType: 'llc', state: 'NY', formationDate: '2020-01-01', annualRevenue: 200_000, businessBankAccount: true });
  const pipes = loadPipelines();
  assert.ok(pipes['credit-journey'] && pipes['credit-portfolio-review'].schedule);
  const run = await runPipeline(pipes['credit-journey'], { clientId: c.id }, { db, credit });
  assert.equal(run.status, 'succeeded');
  assert.match(run.output.markdown, /Pipeline Co LLC \(EIN \*\*-\*\*\*4321\)/);
  assert.equal(credit.creditHistory('acct', c.id).length, 2, 'intake + pipeline snapshots');
  const review = await runPipeline(pipes['credit-portfolio-review'], {}, { db });
  assert.equal(review.output.evaluated, 1);
});
