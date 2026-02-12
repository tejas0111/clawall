export const RISK_POLICY = {
  LIMITS: {
    SAFE_AMOUNT: 100_000_000,   // 0.1 SUI
    HIGH_AMOUNT: 250_000_000,   // 0.25 SUI → guaranteed HIGH

    CUMULATIVE_SAFE: 200_000_000,
    MAX_TX_COUNT: 3,

    SMALL_TX_MAX: 50_000_000,
    SMALL_TX_BURST: 5,

    FAST_WINDOW_SEC: 60,
    DRAIN_TIME_MIN: 10,
  },

  WEIGHTS: {
    AMOUNT_RELATIVE: 40,
    AMOUNT_ABSOLUTE: 40,   // Increased for deterministic HIGH
    RECIPIENT_NOVELTY: 15,
    TIME_PRESSURE: 10,

    CUMULATIVE_SPEND: 30,
    RAPID_FIRE: 20,

    SMALL_CHUNK_DRAIN: 35,
    TX_VELOCITY: 20,
    REPEAT_PATTERN: 15,

    BEHAVIOR_ANOMALY: 20,
    RISK_COMPOUNDING: 15,
  },

  THRESHOLDS: {
    LOW: 0,
    MEDIUM: 40,
    HIGH: 70,
  },
};

function clamp(val, min = 0, max = 100) {
  return Math.max(min, Math.min(max, val));
}

function scoreRatio(ratio, weight, scale = 20) {
  if (!Number.isFinite(ratio)) return 0;
  return clamp(Math.floor(ratio * scale), 0, weight);
}

export function rankRisk(proposal, context = {}) {
  const factors = [];
  let score = 0;

  const amount = proposal?.params?.amount ?? 0;

  /* ======================================================
     🚨 HARD ESCALATION RULES for Demo
  ====================================================== */

  if (amount >= RISK_POLICY.LIMITS.HIGH_AMOUNT) {
    score = 90;  // Force HIGH
    factors.push({
      factor: 'HARD_HIGH_AMOUNT',
      points: 90,
      detail: 'Amount exceeds HIGH_AMOUNT threshold',
    });

    return finalize(score, factors);
  }

  if (amount >= RISK_POLICY.LIMITS.SAFE_AMOUNT) {
    score = 50;  // Force MEDIUM
    factors.push({
      factor: 'HARD_MEDIUM_AMOUNT',
      points: 50,
      detail: 'Amount exceeds SAFE_AMOUNT threshold',
    });
  }

  if (context.recipientKnown === false) {
    score += RISK_POLICY.WEIGHTS.RECIPIENT_NOVELTY;
    factors.push({
      factor: 'RECIPIENT_NOVELTY',
      points: RISK_POLICY.WEIGHTS.RECIPIENT_NOVELTY,
      detail: 'Recipient not in trusted set',
    });
  }

  if (context.shortExpiry === true) {
    score += RISK_POLICY.WEIGHTS.TIME_PRESSURE;
    factors.push({
      factor: 'TIME_PRESSURE',
      points: RISK_POLICY.WEIGHTS.TIME_PRESSURE,
      detail: 'Unusually short approval window',
    });
  }

  if (Number.isFinite(context.recentSpend)) {
    const ratio =
      context.recentSpend / RISK_POLICY.LIMITS.CUMULATIVE_SAFE;

    if (ratio >= 1) {
      const points = scoreRatio(
        ratio,
        RISK_POLICY.WEIGHTS.CUMULATIVE_SPEND
      );

      score += points;
      factors.push({
        factor: 'CUMULATIVE_SPEND',
        points,
        detail: `Cumulative spend ${ratio.toFixed(2)}× window limit`,
      });
    }
  }

  if (context.repeatedRecipient === true) {
    score += RISK_POLICY.WEIGHTS.REPEAT_PATTERN;
    factors.push({
      factor: 'REPEAT_PATTERN',
      points: RISK_POLICY.WEIGHTS.REPEAT_PATTERN,
      detail: 'Repeated transfers to same recipient',
    });
  }

  if (Number.isFinite(context.behaviorAnomalyScore)) {
    const points = clamp(
      Math.floor(context.behaviorAnomalyScore),
      0,
      RISK_POLICY.WEIGHTS.BEHAVIOR_ANOMALY
    );

    if (points > 0) {
      score += points;
      factors.push({
        factor: 'BEHAVIOR_ANOMALY',
        points,
        detail: 'Deviation from historical behavior baseline',
      });
    }
  }

  const mediumFactors = factors.filter(f => f.points >= 15).length;

  if (mediumFactors >= 3) {
    score += RISK_POLICY.WEIGHTS.RISK_COMPOUNDING;
    factors.push({
      factor: 'RISK_COMPOUNDING',
      points: RISK_POLICY.WEIGHTS.RISK_COMPOUNDING,
      detail: 'Multiple independent risk signals compounding',
    });
  }

  return finalize(score, factors);
}

function finalize(score, factors) {
  score = clamp(score, 0, 100);

  let level = 'LOW';
  if (score >= RISK_POLICY.THRESHOLDS.HIGH) level = 'HIGH';
  else if (score >= RISK_POLICY.THRESHOLDS.MEDIUM) level = 'MEDIUM';

  const reasoning =
    factors.length > 0
      ? factors.map(f => `${f.detail} (${f.points} pts)`).join('; ')
      : 'No significant risk factors detected';

  return {
    risk_score: score,
    risk_level: level,
    reasoning,
    factors,
    evaluated_at: new Date().toISOString(),
    engine_version: '2.0.0-hackathon-stable',
  };
}

