// Business-credit specialist agents for the Agentic Mesh. Skills take inline
// data (profile, tradelines, ...) so they are callable over A2A and billable
// through Agentic Commerce without any access to the client database.
import {
  extractIntakeFromText, validateIntake, maskEin, scoreFoundation, computeCreditProfile, computeBuilderPlan, matchFunding,
  classifyDocument, requiredDocuments, evaluateClient, creditMetrics,
} from '../credit/index.js';

const metricsFor = ({ profile = {}, tradelines = [] }) => {
  const v = validateIntake(profile, { einOnFile: true });
  const p = { ...profile, businessAgeMonths: v.profile.businessAgeMonths, monthlyRevenue: v.profile.monthlyRevenue };
  const foundation = scoreFoundation(p);
  const credit = computeCreditProfile(tradelines);
  return { p, foundation, credit, metrics: creditMetrics({ profile: p, foundation, credit }) };
};

export function createCreditAgents() {
  return [
    {
      name: 'credit-intake',
      description: 'AI-assisted business intake: extracts and validates business/EIN details; classifies documents.',
      skills: {
        extract: {
          description: 'Extract a structured business profile from free text and validate it',
          credits: 2,
          handler: async ({ text = '' }) => {
            const ex = extractIntakeFromText(text);
            const v = validateIntake(ex.values);
            return { extracted: { ...ex.values, ...(ex.values.ein ? { ein: maskEin(ex.values.ein) } : {}) }, validation: { valid: v.valid, errors: v.errors, warnings: v.warnings } };
          },
        },
        classifyDocument: { description: 'Classify a document from filename/text', credits: 1, handler: async (input) => classifyDocument(input) },
        requiredDocuments: { description: 'Required-document checklist for a profile', credits: 1, handler: async ({ profile, targetCategories }) => requiredDocuments(profile, { targetCategories }) },
      },
    },
    {
      name: 'credit-analyst',
      description: 'Scores the fundable foundation, estimates bureau-style business credit and plans credit-builder tiers.',
      skills: {
        foundation: { description: 'Fundable Foundation readiness score and checklist', credits: 1, handler: async ({ profile = {} }) => metricsFor({ profile }).foundation },
        creditProfile: { description: 'Bureau-style business credit profile from tradelines', credits: 2, handler: async ({ tradelines = [] }) => computeCreditProfile(tradelines) },
        builderPlan: {
          description: 'Tiered business credit builder progress and next steps',
          credits: 2,
          handler: async (input) => computeBuilderPlan(metricsFor(input).metrics, input.tradelines ?? []),
        },
      },
    },
    {
      name: 'funding-matcher',
      description: 'Real-time funding eligibility across credit lines, no-PG cards, auto, fleet/fuel, cash, SBA and bank financing.',
      skills: {
        match: {
          description: 'Match a client profile + tradelines to funding products',
          credits: 3,
          handler: async ({ profile, tradelines, categories, requireNoPg }) => matchFunding(metricsFor({ profile, tradelines }).metrics, { categories, requireNoPg }),
        },
        strategy: {
          description: 'Full evaluation with stage routing and a phased funding strategy',
          credits: 5,
          handler: async ({ profile, tradelines, documents }) => {
            const ev = evaluateClient({ profile: { einLast4: '0000', ...profile }, tradelines, documents });
            return { stage: ev.stage, stageReason: ev.stageReason, readinessScore: ev.funding.readinessScore, strategy: ev.strategy };
          },
        },
      },
    },
  ];
}
