# Quantitative Trading, Crypto Trend Spotting, PQC & Digital Forensics

This guide documents the quantitative, cryptocurrency, post-quantum cryptographic (PQC), and digital forensics subsystems integrated into the API SaaS Decision Engine.

---

## 1. Post-Quantum Cryptography (PQC) & Hybrid Algorithmic Chains (`src/secrets/pqc.js`)

To protect financial forecasts, webhook signing secrets, and audit logs against both classical and quantum ("harvest now, decrypt later") adversaries, the engine implements a crypto-agile hybrid stack aligned with NIST Post-Quantum Cryptography standards:

| Primitive | Suite ID | Classical Leg | Post-Quantum Leg | Combiner / Anchor |
|---|---|---|---|---|
| **Key Encapsulation (KEM)** | `HYBRID-X25519-ML-KEM-768` | RFC 7748 (`X25519`) | NIST FIPS 203 (`ML-KEM-768`, $q=3329, k=3, n=256$) | `HKDF-SHA384(ss_classical \|\| ss_pqc, salt, info)` |
| **Digital Signature** | `HYBRID-ED25519-ML-DSA-65` | RFC 8032 (`Ed25519`) | NIST FIPS 204 (`ML-DSA-65` lattice transcript) | Dual-verification required |
| **Audit Hash Chain** | `SLH-DSA-SHA3-256` | `SHA-384` | NIST FIPS 205 (`SLH-DSA` / `SHA3-256` Merkle chain) | Append-only `PqcAlgorithmicChain` |
| **Authenticated Cipher** | `AES-256-GCM-SHA384` | `AES-256-GCM` (96-bit IV, 128-bit tag) | 256-bit key (Grover-resistant $\ge 128$-bit quantum security) | Bound to AAD & domain separator |

### Endpoints & CLI
- `GET /v1/security/pqc` — Inspect active PQC suites, embedded NIST test vectors (`EMBEDDED_PQC_VECTORS`), and live chain status.
- `POST /v1/security/pqc/attest` — Sign and append an attested event block to the tamper-evident PQC chain.

---

## 2. Algorithmic Trading, Stocks & Market Watch (`src/engine/quant.js`)

The quantitative engine (`evaluateEquitySignals`) evaluates public SaaS & AI infrastructure equities (`CLWD`, `DDOG`, `SNOW`, `MDB`, `NVDA`) and custom price series using:

- **Rescaled Range ($R/S$) Hurst Exponent ($H$)**:
  - $H > 0.55$: Persistent momentum regime (weights trend-following indicators higher).
  - $H < 0.45$: Mean-reverting regime (weights Bollinger Z-score mean-reversion higher).
  - $0.45 \le H \le 0.55$: Diffusive random walk.
- **Technical & Factor Signals**: 14-period RSI, MACD $(12, 26, 9)$ histogram, and Bollinger Bands $(20, 2\sigma)$ bandwidth & Z-score.
- **Tail-Risk & Position Sizing**: Annualized Sharpe ratio, Sortino ratio (downside deviation), Maximum Drawdown, 95% Historical Value-at-Risk ($\text{VaR}_{95}$), 95% Conditional Value-at-Risk / Expected Shortfall ($\text{CVaR}_{95}$), and **Half-Kelly** optimal capital allocation fraction.

---

## 3. Cryptocurrency Analysis & Trend Spotting (`analyzeCryptoTrends`)

Covers major digital assets (`BTC-USD`, `ETH-USD`, `SOL-USD`, `RENDER-USD`) by combining technical momentum with on-chain and perpetual-futures microstructure indicators:

- **MVRV Z-Score**: Identifies cycle extremes (`> 3.2` distribution/overheated vs. `< 0.8` deep accumulation value).
- **NVT Signal**: Network Value-to-Transactions ratio measuring organic settlement utility vs. speculative premium.
- **Perpetual Funding Rate & Basis Carry**: Annualizes 8-hour perpetual swap funding rates to evaluate delta-neutral cash-and-carry treasury yield (`MARKET_NEUTRAL_BASIS` vs. `ACCUMULATE_LONG` vs. `HEDGE_REDUCE`).

---

## 4. Hybrid Algorithmic Valuation Bridge (`runHybridQuantEngine`)

Bridges bottom-up SaaS operational drivers with public-market quantitative multiples:
- Computes implied **Enterprise Value / NTM ARR** multiple from the scenario's **Rule of 40**, **Net Revenue Retention (NRR)**, and **Gross Margin** relative to the BVP Nasdaq Emerging Cloud index median (`9.8x`) and top quartile (`15.4x`).
- Optimizes surplus cash reserves across 3M US Treasury Bills, Short-Duration Investment Grade Credit, and Delta-Neutral Crypto Basis Carry.

---

## 5. Digital Forensics & Transformation Readiness (`runDigitalForensics`)

1. **Benford's Law First-Digit Forensics**:
   - Tests monthly ARR, COGS, OpEx, and commerce ledger flows against the theoretical Benford distribution $P(d) = \log_{10}(1 + 1/d)$ for $d \in \{1..9\}$ using Pearson's $\chi^2$ goodness-of-fit test ($\text{df}=8, \chi^2_{0.95} = 15.507$).
2. **Z-Score Anomaly Scanner**:
   - Flags any monthly trajectory jump exceeding $|Z| > 2.8\sigma$.
3. **Digital Transformation Maturity Index (`0..100`)**:
   - Aggregates infrastructure unit-cost efficiency, gross margin structure, Rule of 40 capital efficiency, and PQC cryptographic readiness into an enterprise readiness tier (`AUTONOMOUS_QUANT_NATIVE`, `SCALED_CLOUD_NATIVE`, or `TRANSITIONAL`).
