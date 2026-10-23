// Quantitative Algorithmic Capabilities, Hybrid Algorithmic Capabilities,
// Algorithmic Trading & Stocks, Cryptocurrency Analysis / Trend Spotting,
// Market Watch, and Digital Forensics / Transformation Engine.
//
// Zero external dependencies (pure JS, portable across Node.js, Workers, and Browser).
import { clamp, mean, percentile, mulberry32 as prng, normal, round, sum } from './util.js';

// ── Embedded Canonical Market & Crypto Reference Vectors ─────────────
export const MARKET_WATCH_UNIVERSE = Object.freeze({
  equities: [
    { symbol: 'CLWD', name: 'Cloudflare Inc.', sector: 'Edge & Security SaaS', basePrice: 112.4, arrMultiple: 16.2, beta: 1.32, volAnnual: 0.42 },
    { symbol: 'DDOG', name: 'Datadog Inc.', sector: 'Observability SaaS', basePrice: 128.9, arrMultiple: 15.8, beta: 1.25, volAnnual: 0.39 },
    { symbol: 'SNOW', name: 'Snowflake Inc.', sector: 'Data Cloud SaaS', basePrice: 164.5, arrMultiple: 13.4, beta: 1.38, volAnnual: 0.45 },
    { symbol: 'MDB', name: 'MongoDB Inc.', sector: 'Database SaaS', basePrice: 295.0, arrMultiple: 11.9, beta: 1.29, volAnnual: 0.44 },
    { symbol: 'NVDA', name: 'NVIDIA Corp.', sector: 'AI Compute Infrastructure', basePrice: 138.2, arrMultiple: 24.5, beta: 1.65, volAnnual: 0.52 },
  ],
  crypto: [
    { symbol: 'BTC-USD', name: 'Bitcoin', layer: 'L1 Store of Value', basePrice: 92400, mvrvZScore: 2.15, fundingRate8h: 0.00012, nvtsRatio: 48.2, volAnnual: 0.58 },
    { symbol: 'ETH-USD', name: 'Ethereum', layer: 'L1 Smart Contracts', basePrice: 3180, mvrvZScore: 1.64, fundingRate8h: 0.00009, nvtsRatio: 39.5, volAnnual: 0.66 },
    { symbol: 'SOL-USD', name: 'Solana', layer: 'High-Throughput L1', basePrice: 194.5, mvrvZScore: 2.45, fundingRate8h: 0.00018, nvtsRatio: 54.1, volAnnual: 0.78 },
    { symbol: 'RENDER-USD', name: 'Render Network', layer: 'DePIN GPU Compute', basePrice: 8.65, mvrvZScore: 1.92, fundingRate8h: 0.00015, nvtsRatio: 42.0, volAnnual: 0.85 },
  ],
  macroBenchmarks: {
    riskFreeRateAnnual: 0.0425,
    saasMedianEvToNtmArr: 9.8,
    topQuartileEvToNtmArr: 15.4,
    bvpNasdaqEmergingCloudIndex: 1142.8,
  },
});

// ── Synthetic Deterministic Series Generator ─────────────────────────
export function generatePriceSeries({ basePrice = 100, days = 120, driftAnnual = 0.18, volAnnual = 0.45, meanReversionKappa = 0.08, seed = 1337 } = {}) {
  const rand = prng(seed);
  const dt = 1 / 252;
  const prices = [ basePrice ];
  const volumes = [ 1_000_000 ];
  let logP = Math.log(basePrice);
  const eqLogP = Math.log(basePrice * (1 + driftAnnual * (days / 252)));

  for (let i = 1; i < days; i++) {
    const z = normal(rand);
    const ouPull = meanReversionKappa * (eqLogP * (i / days) + Math.log(basePrice) * (1 - i / days) - logP);
    const dLogP = (driftAnnual - 0.5 * volAnnual * volAnnual) * dt + ouPull * dt + volAnnual * Math.sqrt(dt) * z;
    logP += dLogP;
    prices.push(round(Math.exp(logP), 4));
    volumes.push(Math.round(1_000_000 * (1 + 0.35 * Math.abs(z))));
  }
  return { prices, volumes };
}

// ── Technical & Quantitative Indicators ──────────────────────────────
export function ema(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const out = [ values[0] ];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

export function rsi(prices, period = 14) {
  if (prices.length <= period) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return round(100 - 100 / (1 + rs), 2);
}

export function macd(prices, fast = 12, slow = 26, signalPeriod = 9) {
  const fastEma = ema(prices, fast);
  const slowEma = ema(prices, slow);
  const macdLine = prices.map((_, i) => fastEma[i] - slowEma[i]);
  const signalLine = ema(macdLine, signalPeriod);
  const hist = macdLine.map((m, i) => m - signalLine[i]);
  return {
    macd: round(macdLine.at(-1) ?? 0, 4),
    signal: round(signalLine.at(-1) ?? 0, 4),
    histogram: round(hist.at(-1) ?? 0, 4),
  };
}

export function bollingerBands(prices, period = 20, stdDevMult = 2) {
  const slice = prices.slice(-period);
  const mid = mean(slice);
  const variance = mean(slice.map((p) => (p - mid) ** 2));
  const sd = Math.sqrt(variance);
  const last = prices.at(-1) ?? mid;
  const upper = mid + stdDevMult * sd;
  const lower = mid - stdDevMult * sd;
  const zScore = sd > 0 ? (last - mid) / sd : 0;
  return {
    middle: round(mid, 4),
    upper: round(upper, 4),
    lower: round(lower, 4),
    bandwidthPct: round(((upper - lower) / mid) * 100, 2),
    zScore: round(zScore, 3),
  };
}

/**
 * Rescaled Range (R/S) Hurst Exponent estimator:
 * - H > 0.55 => persistent trending regime (momentum)
 * - H < 0.45 => anti-persistent / mean-reverting regime (stat-arb)
 * - 0.45 <= H <= 0.55 => geometric Brownian random walk
 */
export function hurstExponent(prices) {
  if (prices.length < 24) return 0.5;
  const returns = [];
  for (let i = 1; i < prices.length; i++) returns.push(Math.log(prices[i] / prices[i - 1]));
  const m = mean(returns);
  let cum = 0;
  let maxDev = -Infinity;
  let minDev = Infinity;
  for (const r of returns) {
    cum += r - m;
    if (cum > maxDev) maxDev = cum;
    if (cum < minDev) minDev = cum;
  }
  const range = maxDev - minDev;
  const sd = Math.sqrt(mean(returns.map((r) => (r - m) ** 2)));
  if (sd === 0 || range === 0) return 0.5;
  const rs = range / sd;
  return round(clamp(Math.log(rs) / Math.log(returns.length), 0.1, 0.95), 3);
}

// ── Portfolio & Tail-Risk Metrics (Sharpe, Sortino, VaR, CVaR) ───────
export function computeQuantRiskMetrics(prices, riskFreeAnnual = 0.0425) {
  const returns = [];
  for (let i = 1; i < prices.length; i++) returns.push(prices[i] / prices[i - 1] - 1);
  if (!returns.length) return {};

  const rfDaily = riskFreeAnnual / 252;
  const avgDaily = mean(returns);
  const excess = returns.map((r) => r - rfDaily);
  const sdDaily = Math.sqrt(mean(excess.map((x) => x * x)));
  const downside = excess.filter((x) => x < 0);
  const downsideSd = downside.length ? Math.sqrt(mean(downside.map((x) => x * x))) : sdDaily;

  const sharpe = sdDaily > 0 ? (mean(excess) / sdDaily) * Math.sqrt(252) : 0;
  const sortino = downsideSd > 0 ? (mean(excess) / downsideSd) * Math.sqrt(252) : 0;

  let peak = prices[0];
  let maxDd = 0;
  for (const p of prices) {
    if (p > peak) peak = p;
    const dd = (peak - p) / peak;
    if (dd > maxDd) maxDd = dd;
  }

  const sorted = [ ...returns ].sort((a, b) => a - b);
  const var95 = -percentile(sorted, 0.05);
  const tailCutoffIdx = Math.max(1, Math.floor(sorted.length * 0.05));
  const cvar95 = -mean(sorted.slice(0, tailCutoffIdx));

  // Half-Kelly optimal allocation fraction
  const winReturns = returns.filter((r) => r > 0);
  const lossReturns = returns.filter((r) => r < 0);
  const winProb = winReturns.length / returns.length;
  const winLossRatio = lossReturns.length ? mean(winReturns) / Math.abs(mean(lossReturns)) : 1.5;
  const kellyFull = winLossRatio > 0 ? winProb - (1 - winProb) / winLossRatio : 0;

  return {
    annualizedReturn: round(avgDaily * 252, 4),
    annualizedVolatility: round(sdDaily * Math.sqrt(252), 4),
    sharpeRatio: round(sharpe, 3),
    sortinoRatio: round(sortino, 3),
    maxDrawdownPct: round(maxDd * 100, 2),
    historicalVaR95Pct: round(var95 * 100, 2),
    conditionalVaR95Pct: round(cvar95 * 100, 2),
    halfKellyFraction: round(clamp(kellyFull * 0.5, 0, 0.5), 3),
  };
}

// ── Algorithmic Trading & Stock Signal Backtester ────────────────────
export function evaluateEquitySignals({ symbol = 'CLWD', prices, seed = 1337 } = {}) {
  const ref = MARKET_WATCH_UNIVERSE.equities.find((e) => e.symbol === symbol) ?? MARKET_WATCH_UNIVERSE.equities[0];
  const series = prices ?? generatePriceSeries({ basePrice: ref.basePrice, volAnnual: ref.volAnnual, seed: seed + symbol.charCodeAt(0) }).prices;

  const rsi14 = rsi(series, 14);
  const macdState = macd(series);
  const bb = bollingerBands(series, 20, 2);
  const hurst = hurstExponent(series);
  const risk = computeQuantRiskMetrics(series, MARKET_WATCH_UNIVERSE.macroBenchmarks.riskFreeRateAnnual);

  // Hybrid regime-adaptive signal (combines trend-following MACD + mean-reversion Bollinger Z + Hurst regime filter)
  const momentumScore = clamp((macdState.histogram / (series.at(-1) * 0.01)) * 0.5 + (rsi14 - 50) / 50, -1, 1);
  const meanRevScore = clamp(-bb.zScore / 2.5, -1, 1);
  const regimeWeightMomentum = clamp((hurst - 0.35) / 0.3, 0.2, 0.85);
  const compositeAlpha = round(regimeWeightMomentum * momentumScore + (1 - regimeWeightMomentum) * meanRevScore, 3);

  const action = compositeAlpha > 0.22 ? 'BUY' : compositeAlpha < -0.22 ? 'SELL' : 'HOLD';
  const regime = hurst > 0.55 ? 'TRENDING_MOMENTUM' : hurst < 0.45 ? 'MEAN_REVERTING' : 'DIFFUSIVE_NEUTRAL';

  return {
    symbol: ref.symbol,
    name: ref.name,
    sector: ref.sector,
    spotPrice: series.at(-1),
    regime,
    hurstExponent: hurst,
    indicators: { rsi14, macd: macdState, bollinger: bb },
    compositeAlpha,
    signal: action,
    positionSizingPct: action === 'HOLD' ? 0 : round(risk.halfKellyFraction * 100, 1),
    risk,
  };
}

// ── Cryptocurrency Analysis & On-Chain / Derivatives Trend Spotting ──
export function analyzeCryptoTrends({ symbol = 'BTC-USD', prices, seed = 2026 } = {}) {
  const asset = MARKET_WATCH_UNIVERSE.crypto.find((c) => c.symbol === symbol) ?? MARKET_WATCH_UNIVERSE.crypto[0];
  const series = prices ?? generatePriceSeries({ basePrice: asset.basePrice, volAnnual: asset.volAnnual, driftAnnual: 0.28, seed: seed + asset.symbol.charCodeAt(0) }).prices;

  const rsi14 = rsi(series, 14);
  const macdState = macd(series);
  const hurst = hurstExponent(series);
  const risk = computeQuantRiskMetrics(series, MARKET_WATCH_UNIVERSE.macroBenchmarks.riskFreeRateAnnual);

  // On-chain & perp-futures composite trend spotting:
  // - MVRV Z-Score (>3.5 overheated, <0.5 deep value)
  // - NVT Signal (<45 organic network utility, >75 speculative premium)
  // - Perp funding rate annualized carry
  const annualizedFundingPct = round(asset.fundingRate8h * 3 * 365 * 100, 2);
  const onChainScore = clamp((2.5 - asset.mvrvZScore) * 0.35 + (60 - asset.nvtsRatio) / 60 * 0.35, -1, 1);
  const technicalScore = clamp((rsi14 - 50) / 45 * 0.5 + (macdState.histogram > 0 ? 0.25 : -0.25), -1, 1);
  const trendScore = round(0.55 * technicalScore + 0.45 * onChainScore, 3);

  const cyclePhase =
    asset.mvrvZScore > 3.2 ? 'DISTRIBUTION_OVERHEATED'
    : asset.mvrvZScore < 0.8 ? 'ACCUMULATION_VALUE'
    : trendScore > 0.15 ? 'MARKUP_EXPANSION'
    : 'CONSOLIDATION_RANGE';

  return {
    symbol: asset.symbol,
    name: asset.name,
    layer: asset.layer,
    spotPrice: series.at(-1),
    cyclePhase,
    trendScore,
    signal: trendScore > 0.2 ? 'ACCUMULATE_LONG' : trendScore < -0.2 ? 'HEDGE_REDUCE' : 'MARKET_NEUTRAL_BASIS',
    onChainMetrics: {
      mvrvZScore: asset.mvrvZScore,
      nvtSignal: asset.nvtsRatio,
      perpFundingRate8h: asset.fundingRate8h,
      annualizedBasisCarryPct: annualizedFundingPct,
    },
    technicalIndicators: { rsi14, macd: macdState, hurstExponent: hurst },
    risk,
  };
}

// ── Market Watch & Hybrid Algorithmic Valuation Bridge ───────────────
/**
 * Hybrid Algorithmic Capability: fuses fundamental SaaS model outputs
 * (ARR, NRR, Rule of 40, Gross Margin, Burn Multiple) with live/simulated
 * public market multiples, equity factor signals, and treasury crypto/yield allocation.
 */
export function runHybridQuantEngine(modelResult, { seed = 1337 } = {}) {
  const s = modelResult.summary;
  const equities = MARKET_WATCH_UNIVERSE.equities.map((e) => evaluateEquitySignals({ symbol: e.symbol, seed }));
  const cryptoTrends = MARKET_WATCH_UNIVERSE.crypto.map((c) => analyzeCryptoTrends({ symbol: c.symbol, seed }));

  // Implied public-market EV/NTM ARR multiple adjusted by Rule of 40, NRR, and Gross Margin premium
  const ruleOf40Bonus = ((s.endingRuleOf40 ?? 0.3) - 0.4) * 14;
  const nrrBonus = ((s.endingNrr ?? 1.05) - 1.1) * 18;
  const gmBonus = ((s.endingGrossMargin ?? 0.75) - 0.75) * 10;
  const impliedArrMultiple = round(clamp(MARKET_WATCH_UNIVERSE.macroBenchmarks.saasMedianEvToNtmArr + ruleOf40Bonus + nrrBonus + gmBonus, 3.5, 28.0), 2);
  const impliedEnterpriseValue = Math.round(s.endingArr * impliedArrMultiple);

  // Treasury reserve allocation optimizer (T-Bills vs IG Credit vs BTC/ETH Basis Carry)
  const surplusCash = Math.max(0, s.minCash);
  const treasuryAllocation = {
    surplusReserveUsd: Math.round(surplusCash),
    buckets: [
      { instrument: 'US Treasury Bills (3M)', weight: 0.75, expectedYieldAnnual: 0.0425 },
      { instrument: 'Investment-Grade Short Duration', weight: 0.15, expectedYieldAnnual: 0.051 },
      { instrument: 'Delta-Neutral Crypto Basis Carry (BTC/ETH)', weight: 0.10, expectedYieldAnnual: 0.098 },
    ],
  };
  treasuryAllocation.blendedYieldAnnual = round(sum(treasuryAllocation.buckets.map((b) => b.weight * b.expectedYieldAnnual)), 4);
  treasuryAllocation.annualizedYieldUsd = Math.round(surplusCash * treasuryAllocation.blendedYieldAnnual);

  return {
    asOf: new Date().toISOString(),
    saasValuationBridge: {
      scenario: s.scenario,
      endingArr: s.endingArr,
      endingRuleOf40: s.endingRuleOf40,
      endingNrr: s.endingNrr,
      endingGrossMargin: s.endingGrossMargin,
      impliedArrMultiple,
      impliedEnterpriseValue,
      peerMedianMultiple: MARKET_WATCH_UNIVERSE.macroBenchmarks.saasMedianEvToNtmArr,
      topQuartileMultiple: MARKET_WATCH_UNIVERSE.macroBenchmarks.topQuartileEvToNtmArr,
    },
    marketWatch: {
      indices: {
        bvpNasdaqEmergingCloud: MARKET_WATCH_UNIVERSE.macroBenchmarks.bvpNasdaqEmergingCloudIndex,
        riskFreeRateAnnual: MARKET_WATCH_UNIVERSE.macroBenchmarks.riskFreeRateAnnual,
      },
      equities,
      crypto: cryptoTrends,
    },
    treasuryOptimization: treasuryAllocation,
  };
}

// ── Digital Forensics & Transformation Readiness Analysis ────────────
/**
 * Digital Forensics:
 * 1. Benford's Law first-digit chi-square test on revenue/cost ledger flows to detect synthetic tampering or fraud.
 * 2. Z-score anomaly detection on monthly operational & API traffic trajectories.
 * 3. Digital transformation maturity index (automation, PQC readiness, unit-cost elasticity, AI/agentic coverage).
 */
export function runDigitalForensics(modelResult, ledgerEntries = []) {
  const months = modelResult.months ?? [];
  const seriesValues = [
    ...months.map((m) => m.arr),
    ...months.map((m) => m.cogsTotal),
    ...months.map((m) => m.opexTotal),
    ...ledgerEntries.map((l) => Math.abs(Number(l.delta ?? l.amount ?? 0))),
  ].filter((v) => Number.isFinite(v) && v >= 10);

  // Benford's Law First-Digit Distribution: P(d) = log10(1 + 1/d) for d in 1..9
  const counts = Array(10).fill(0);
  for (const val of seriesValues) {
    const firstDigit = Number(String(Math.abs(val)).replace(/^0+\.?0*/, '')[0]);
    if (firstDigit >= 1 && firstDigit <= 9) counts[firstDigit]++;
  }
  const n = Math.max(1, sum(counts.slice(1)));
  let chiSquare = 0;
  const digitProfile = [];
  for (let d = 1; d <= 9; d++) {
    const expectedProb = Math.log10(1 + 1 / d);
    const observedProb = counts[d] / n;
    const expectedCount = expectedProb * n;
    chiSquare += ((counts[d] - expectedCount) ** 2) / expectedCount;
    digitProfile.push({
      digit: d,
      expectedPct: round(expectedProb * 100, 2),
      observedPct: round(observedProb * 100, 2),
    });
  }

  // Monthly ARR growth & COGS jump anomaly scan
  const growthRates = [];
  for (let i = 1; i < months.length; i++) {
    if (months[i - 1].mrr > 0) growthRates.push(months[i].mrr / months[i - 1].mrr - 1);
  }
  const gMean = mean(growthRates);
  const gSd = Math.sqrt(mean(growthRates.map((g) => (g - gMean) ** 2))) || 0.0001;
  const anomalies = [];
  for (let i = 1; i < months.length; i++) {
    const g = months[i - 1].mrr > 0 ? months[i].mrr / months[i - 1].mrr - 1 : 0;
    const z = (g - gMean) / gSd;
    if (Math.abs(z) > 2.8) {
      anomalies.push({ period: months[i].period, metric: 'mrrGrowth', value: round(g, 4), zScore: round(z, 2) });
    }
  }

  // Digital Transformation Maturity Scorecard (0..100)
  const s = modelResult.summary;
  const infraEfficiencyScore = clamp((1 - (s.endingCostPer1kCalls ?? 0.25) / 0.5) * 100, 20, 100);
  const marginMaturityScore = clamp((s.endingGrossMargin ?? 0.7) * 115, 20, 100);
  const capitalEfficiencyScore = clamp((s.endingRuleOf40 ?? 0.35) * 140, 20, 100);
  const pqcCryptoScore = 96; // Hybrid X25519+ML-KEM-768 & Ed25519+ML-DSA-65 active
  const transformationIndex = round(mean([ infraEfficiencyScore, marginMaturityScore, capitalEfficiencyScore, pqcCryptoScore ]), 1);

  return {
    benfordAnalysis: {
      sampleSize: n,
      chiSquareStatistic: round(chiSquare, 3),
      criticalValue95: 15.507, // df = 8 at alpha = 0.05
      conformityStatus: chiSquare <= 15.507 ? 'CONFORMANT_ORGANIC' : 'ELEVATED_DEVIATION_REVIEW',
      digitProfile,
    },
    anomalyScan: {
      inspectedMonths: months.length,
      anomaliesDetected: anomalies.length,
      anomalies,
    },
    digitalTransformation: {
      maturityIndex: transformationIndex,
      tier: transformationIndex >= 80 ? 'AUTONOMOUS_QUANT_NATIVE' : transformationIndex >= 65 ? 'SCALED_CLOUD_NATIVE' : 'TRANSITIONAL',
      pillars: {
        infraEfficiencyScore: round(infraEfficiencyScore, 1),
        marginMaturityScore: round(marginMaturityScore, 1),
        capitalEfficiencyScore: round(capitalEfficiencyScore, 1),
        pqcCryptoReadinessScore: pqcCryptoScore,
      },
    },
  };
}
