// Specialist agents. Each wraps a slice of the decision engine behind named
// skills; they are deterministic (no LLM needed) so their answers are auditable.
import {
  runModel, resolveAssumptions, compareScenarios, sensitivity, monteCarlo, goalSeek, evaluatePolicies, DEFAULT_POLICIES,
  evaluateEquitySignals, analyzeCryptoTrends, runHybridQuantEngine, runDigitalForensics,
} from '../engine/index.js';
import { round, sum } from '../engine/util.js';
import { PqcAlgorithmicChain, PQC_ALGORITHMS, EMBEDDED_PQC_VECTORS } from '../secrets/pqc.js';

export function createSpecialists({ lookup, rulesFor = () => DEFAULT_POLICIES } = {}) {
  const run = (scenario) => runModel(scenario ?? {}, { lookup });

  const forecaster = {
    name: 'forecaster',
    description: 'Projects revenue, customers and P&L for a scenario; compares scenarios.',
    skills: {
      forecast: { description: 'Summary + annual P&L for one scenario', credits: 1, handler: async ({ scenario }) => run(scenario).summary },
      compare: { description: 'Side-by-side scenario summaries', credits: 2, handler: async ({ names = ['base', 'bull', 'bear'] }) => compareScenarios(names, { lookup }) },
      drivers: {
        description: 'Tornado ranking of which drivers matter most',
        credits: 3,
        handler: async ({ scenario, target = 'endingArr' }) => {
          const s = sensitivity(scenario, { target, lookup });
          return { target, baseValue: s.baseValue, top: s.drivers.slice(0, 5) };
        },
      },
    },
  };

  const risk = {
    name: 'risk-analyst',
    description: 'Evaluates policy rulesets and downside risk.',
    skills: {
      policies: { description: 'Evaluate a ruleset against a scenario', credits: 1, handler: async ({ scenario, ruleset }) => evaluatePolicies(run(scenario), rulesFor(ruleset)) },
      stress: {
        description: 'Monte Carlo distribution of outcomes and cash-out probability',
        credits: 5,
        handler: async ({ scenario, iterations = 300, seed = 42 }) => {
          const mc = monteCarlo(scenario, { iterations, seed, lookup });
          return { probabilityOfCashOut: mc.probabilityOfCashOut, endingArr: mc.metrics.endingArr, minCash: mc.metrics.minCash };
        },
      },
    },
  };

  const pricing = {
    name: 'pricing-strategist',
    description: 'Tests price elasticity and solves for required prices.',
    skills: {
      priceImpact: {
        description: 'ARR and margin at −10% / list / +10% price',
        credits: 2,
        handler: async ({ scenario }) => [0.9, 1, 1.1].map((f) => {
          const a = resolveAssumptions(scenario ?? {}, lookup);
          a.tiers = a.tiers.map((t) => ({ ...t, price: t.price * f }));
          const s = runModel(a).summary;
          return { priceFactor: f, endingArr: s.endingArr, endingEbitdaMargin: s.endingEbitdaMargin, endingLtvToCac: s.endingLtvToCac };
        }),
      },
      requiredPrice: {
        description: 'Price multiplier needed to reach a target ending ARR',
        credits: 3,
        handler: async ({ scenario, goal }) => goalSeek(scenario, { path: 'tiers.*.price', target: 'endingArr', goal, min: 0.2, max: 5, lookup }),
      },
    },
  };

  const capacity = {
    name: 'capacity-planner',
    description: 'Infrastructure scaling: RPS, node count, unit cost per 1k calls.',
    skills: {
      scaling: {
        description: 'Capacity and unit-cost trajectory',
        credits: 1,
        handler: async ({ scenario }) => {
          const r = run(scenario);
          const pick = r.months.filter((m) => m.month % 6 === 0 || m.month === 1);
          return {
            points: pick.map((m) => ({ period: m.period, apiCallsBn: round(m.apiCalls / 1e9, 2), peakRps: Math.round(m.peakRps), nodes: m.nodes, utilization: round(m.utilization, 2), costPer1k: round(m.costPer1kCalls, 4), revenuePer1k: round(m.revenuePer1kCalls, 4) })),
            peakNodes: r.summary.peakNodes,
            infraShareOfCogs: round(sum(r.months.map((m) => m.cogs.compute + m.cogs.variableInfra)) / sum(r.months.map((m) => m.cogsTotal)), 3),
          };
        },
      },
    },
  };

  const treasurer = {
    name: 'treasurer',
    description: 'Cash, runway and funding requirements.',
    skills: {
      runway: {
        description: 'Cash trough, runway and funding gap vs. a 6-month buffer',
        credits: 1,
        handler: async ({ scenario, bufferMonths = 6 }) => {
          const r = run(scenario);
          const peakBurn = Math.max(0, ...r.months.map((m) => -m.operatingCashFlow));
          const buffer = peakBurn * bufferMonths;
          return {
            minCash: r.summary.minCash, minCashMonth: r.summary.minCashMonth, cashOutMonth: r.summary.cashOutMonth,
            breakevenMonth: r.summary.breakevenMonth, endingRunwayMonths: r.summary.endingRunwayMonths,
            peakMonthlyBurn: Math.round(peakBurn), fundingGap: Math.max(0, Math.round(buffer - r.summary.minCash)),
          };
        },
      },
    },
  };

  const quantStrategist = {
    name: 'quant-strategist',
    description: 'Algorithmic trading & equity factor signals, Sharpe/Sortino/VaR/Kelly sizing, and hybrid SaaS valuation.',
    skills: {
      equitySignal: {
        description: 'Regime-adaptive algorithmic trading signal (Hurst, RSI, MACD, Bollinger, Kelly) for a stock ticker',
        credits: 2,
        handler: async ({ symbol = 'CLWD', seed = 1337 }) => evaluateEquitySignals({ symbol, seed }),
      },
      hybridValuation: {
        description: 'Hybrid SaaS fundamental + public-market multiples & treasury yield optimization',
        credits: 3,
        handler: async ({ scenario, seed = 1337 }) => runHybridQuantEngine(run(scenario), { seed }),
      },
    },
  };

  const cryptoWatcher = {
    name: 'crypto-watcher',
    description: 'Cryptocurrency trend spotting, on-chain MVRV/NVT valuation, perp funding basis carry, and market watch.',
    skills: {
      cryptoTrend: {
        description: 'Analyze crypto trend, cycle phase, MVRV Z-score, NVT ratio, and perpetual basis carry',
        credits: 2,
        handler: async ({ symbol = 'BTC-USD', seed = 2026 }) => analyzeCryptoTrends({ symbol, seed }),
      },
    },
  };

  const forensicsAuditor = {
    name: 'forensics-auditor',
    description: 'Digital forensics (Benford chi-square, Z-score anomaly detection), PQC algorithmic chain attestation, and digital transformation readiness.',
    skills: {
      audit: {
        description: 'Run Benford first-digit forensics, anomaly detection, PQC chain attestation, and digital transformation scorecard',
        credits: 3,
        handler: async ({ scenario }) => {
          const modelResult = run(scenario);
          const forensics = runDigitalForensics(modelResult);
          const chain = new PqcAlgorithmicChain();
          const block = chain.append('forensics.audit.completed', {
            scenario: modelResult.summary.scenario,
            conformityStatus: forensics.benfordAnalysis.conformityStatus,
            maturityIndex: forensics.digitalTransformation.maturityIndex,
          });
          return {
            ...forensics,
            pqcAttestation: {
              algorithms: PQC_ALGORITHMS,
              vectorVersion: EMBEDDED_PQC_VECTORS.version,
              headBlockHash: block.blockHash,
              chainVerification: chain.verifyChain(),
            },
          };
        },
      },
    },
  };

  return [forecaster, risk, pricing, capacity, treasurer, quantStrategist, cryptoWatcher, forensicsAuditor];
}
