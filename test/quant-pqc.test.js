import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runModel,
  MARKET_WATCH_UNIVERSE,
  generatePriceSeries,
  rsi,
  macd,
  bollingerBands,
  hurstExponent,
  computeQuantRiskMetrics,
  evaluateEquitySignals,
  analyzeCryptoTrends,
  runHybridQuantEngine,
  runDigitalForensics,
} from '../src/engine/index.js';
import {
  PQC_ALGORITHMS,
  EMBEDDED_PQC_VECTORS,
  generateHybridKeyring,
  hybridEncrypt,
  hybridDecrypt,
  hybridSign,
  hybridVerify,
  PqcAlgorithmicChain,
} from '../src/secrets/pqc.js';
import { openDb } from '../src/db/index.js';
import { createApp } from '../src/api/app.js';
import { createApiKey } from '../src/api/auth.js';

test('PQC hybrid KEM encrypt/decrypt round-trips and detects tampering', () => {
  const keyring = generateHybridKeyring(EMBEDDED_PQC_VECTORS.knownAnswerVector.seedHex);
  assert.ok(keyring.id.startsWith('pqc_'));
  assert.equal(keyring.algorithms.kem.id, PQC_ALGORITHMS.kem.id);

  const secretPayload = 'top-secret-quant-alpha-vector:2026';
  const envelope = hybridEncrypt(secretPayload, keyring, 'context:unit-test');
  assert.equal(envelope.version, 'pqc.v1');
  assert.equal(hybridDecrypt(envelope, keyring), secretPayload);

  // Tamper with AAD or ciphertext must throw
  assert.throws(() => hybridDecrypt({ ...envelope, aad: 'wrong-aad' }, keyring));
});

test('PQC hybrid dual-signature (Ed25519 + ML-DSA-65) signs, verifies, and rejects forgery', () => {
  const keyring = generateHybridKeyring();
  const payload = { action: 'rebalance', asset: 'BTC-USD', notional: 250000 };
  const sig = hybridSign(payload, keyring);
  assert.equal(sig.suite, PQC_ALGORITHMS.sig.id);
  assert.equal(hybridVerify(payload, sig, keyring), true);
  assert.equal(hybridVerify({ ...payload, notional: 999999 }, sig, keyring), false);
});

test('PqcAlgorithmicChain appends blocks and detects tamper in chain history', () => {
  const chain = new PqcAlgorithmicChain();
  const b0 = chain.append('genesis.test', { ok: true });
  const b1 = chain.append('trade.executed', { symbol: 'CLWD', signal: 'BUY' });
  assert.equal(b0.index, 0);
  assert.equal(b1.prevHash, b0.blockHash);

  const check = chain.verifyChain();
  assert.equal(check.valid, true);
  assert.equal(check.length, 2);

  // Tamper with block 0 payload
  chain.blocks[0].payload.ok = false;
  const broken = chain.verifyChain();
  assert.equal(broken.valid, false);
  assert.equal(broken.brokenAt, 0);
});

test('quant indicators, equity signals, and crypto trend spotting produce deterministic finite metrics', () => {
  const { prices } = generatePriceSeries({ basePrice: 100, days: 90, seed: 42 });
  assert.equal(prices.length, 90);
  assert.ok(rsi(prices) >= 0 && rsi(prices) <= 100);
  assert.ok(Number.isFinite(macd(prices).histogram));
  assert.ok(Number.isFinite(bollingerBands(prices).zScore));
  assert.ok(hurstExponent(prices) >= 0.1 && hurstExponent(prices) <= 0.95);

  const risk = computeQuantRiskMetrics(prices);
  assert.ok(Number.isFinite(risk.sharpeRatio));
  assert.ok(risk.maxDrawdownPct >= 0);

  const eq = evaluateEquitySignals({ symbol: 'CLWD', seed: 1337 });
  assert.equal(eq.symbol, 'CLWD');
  assert.ok(['BUY', 'SELL', 'HOLD'].includes(eq.signal));

  const cr = analyzeCryptoTrends({ symbol: 'BTC-USD', seed: 2026 });
  assert.equal(cr.symbol, 'BTC-USD');
  assert.ok(['ACCUMULATE_LONG', 'HEDGE_REDUCE', 'MARKET_NEUTRAL_BASIS'].includes(cr.signal));
  assert.ok(MARKET_WATCH_UNIVERSE.equities.length >= 5);
});

test('hybrid quant valuation bridge and Benford digital forensics run end-to-end and via HTTP API', async () => {
  const modelResult = runModel({ extends: 'base' });
  const hybrid = runHybridQuantEngine(modelResult, { seed: 1337 });
  assert.ok(hybrid.saasValuationBridge.impliedEnterpriseValue > 0);
  assert.equal(hybrid.marketWatch.equities.length, MARKET_WATCH_UNIVERSE.equities.length);

  const forensics = runDigitalForensics(modelResult);
  assert.equal(forensics.benfordAnalysis.digitProfile.length, 9);
  assert.ok(forensics.digitalTransformation.maturityIndex > 0);

  // Verify HTTP API endpoints for PQC, Quant, and Forensics
  process.env.LOG_REQUESTS = 'false';
  const db = openDb(':memory:');
  const { key } = createApiKey(db, { name: 'quant-tester', scope: 'write' });
  const app = createApp({ db });

  const call = async (method, path, body) => {
    let statusCode = 200;
    let payload = '';
    const req = {
      method,
      url: path,
      headers: { host: 'localhost', authorization: `Bearer ${key}` },
      socket: { remoteAddress: '127.0.0.1' },
      on(ev, cb) {
        if (ev === 'data' && body) cb(Buffer.from(JSON.stringify(body)));
        if (ev === 'end') cb();
      },
    };
    const res = {
      headersSent: false,
      setHeader() {},
      writeHead(s) { statusCode = s; this.headersSent = true; },
      end(d) { payload = d ? String(d) : ''; },
    };
    await app.handle(req, res);
    return { status: statusCode, body: payload ? JSON.parse(payload) : null };
  };

  const pqcInfo = await call('GET', '/v1/security/pqc');
  assert.equal(pqcInfo.status, 200);
  assert.equal(pqcInfo.body.algorithms.kem.id, 'HYBRID-X25519-ML-KEM-768');

  const mw = await call('GET', '/v1/quant/market-watch');
  assert.equal(mw.status, 200);
  assert.ok(mw.body.equities.length >= 5);

  const fa = await call('POST', '/v1/forensics/audit', { scenario: 'base' });
  assert.equal(fa.status, 200);
  assert.equal(fa.body.chainVerification.valid, true);

  const att = await call('POST', '/v1/security/pqc/attest', { eventType: 'quant.rebalance', payload: { symbol: 'NVDA' } });
  assert.equal(att.status, 201);
  assert.equal(att.body.verified, true);
});
