function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function evaluateDecision(input = {}) {
  const customerTier = String(input.customerTier || "starter").toLowerCase();
  const monthlyRevenue = Number(input.monthlyRevenue || 0);
  const contractLength = Number(input.contractLength || 0);
  const region = String(input.region || "global").toLowerCase();
  const teamSize = Number(input.teamSize || 0);
  const riskScore = Number(input.riskScore || 0);

  let score = 52;

  if (customerTier === "enterprise") {
    score += 20;
  } else if (customerTier === "growth") {
    score += 12;
  } else if (customerTier === "starter") {
    score += 4;
  }

  score += Math.min(monthlyRevenue / 2500, 18);
  score += Math.min(contractLength * 2, 10);
  score += teamSize > 0 ? Math.min(teamSize / 60, 10) : 0;

  if (region === "us" || region === "eu" || region === "na") {
    score += 5;
  } else if (region === "apac") {
    score += 3;
  }

  score -= Math.min(riskScore / 2, 25);
  score = clamp(score, 0, 100);

  let recommendation = "Focus on onboarding";
  let summary = "The account is a promising but resource-sensitive fit.";

  if (score >= 80) {
    recommendation = "Accelerate expansion";
    summary = "This customer profile is highly likely to scale with premium packaging and strategic support.";
  } else if (score >= 65) {
    recommendation = "North-star growth path";
    summary = "The account is a good fit with a focused plan to reduce risk and increase adoption.";
  } else if (score >= 45) {
    recommendation = "Standard SaaS conversion";
    summary = "This segment has a viable path to adoption with moderate operational support.";
  }

  const reasons = [];

  if (customerTier === "enterprise") {
    reasons.push("Enterprise fit with a larger strategic footprint.");
  }
  if (monthlyRevenue >= 40000) {
    reasons.push("Revenue trend supports a premium commercial motion.");
  }
  if (contractLength >= 12) {
    reasons.push("Longer contract horizon indicates durable product value.");
  }
  if (riskScore > 60) {
    reasons.push("Risk profile indicates a need for stronger controls and enablement.");
  }
  if (teamSize >= 50) {
    reasons.push("Larger team size suggests strong platform adoption potential.");
  }
  if (reasons.length === 0) {
    reasons.push("Baseline fit is acceptable; more operating context would improve confidence.");
  }

  return {
    status: "ok",
    product: "api-saas-decision-engine",
    score: Math.round(score),
    recommendation,
    summary,
    fit: score >= 65 ? "strong" : score >= 45 ? "moderate" : "low",
    reasons,
    input: {
      customerTier,
      monthlyRevenue,
      contractLength,
      region,
      teamSize,
      riskScore,
    },
  };
}

module.exports = {
  evaluateDecision,
};
