export const RISK_POLICY = {
  LIMITS: {
    SAFE_AMOUNT: 100_000_000,   // 0.1 SUI
    HIGH_AMOUNT: 250_000_000,   // 0.25 SUI -> guaranteed HIGH
    SAFE_VALUE_USD: Number.isFinite(Number(process.env.SAFE_VALUE_USD))
      ? Number(process.env.SAFE_VALUE_USD)
      : 50,
    HIGH_VALUE_USD: Number.isFinite(Number(process.env.HIGH_VALUE_USD))
      ? Number(process.env.HIGH_VALUE_USD)
      : 150,

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
  const transferUsd = Number(context.transferUsd);
  const projectedVelocity = Number.isFinite(context.txVelocity) ? context.txVelocity : 0;
  const projectedSmallBurst = Number.isFinite(context.smallTxBurstCount) ? context.smallTxBurstCount : 0;

  if (Number.isFinite(transferUsd) && transferUsd > 0) {
    if (transferUsd >= RISK_POLICY.LIMITS.HIGH_VALUE_USD) {
      score = 90;
      factors.push({
        factor: 'HARD_HIGH_VALUE',
        points: 90,
        detail: `Transfer value exceeds HIGH_VALUE_USD threshold ($${RISK_POLICY.LIMITS.HIGH_VALUE_USD})`,
      });
      return finalize(score, factors);
    }

    if (transferUsd >= RISK_POLICY.LIMITS.SAFE_VALUE_USD) {
      score = 50;
      factors.push({
        factor: 'HARD_MEDIUM_VALUE',
        points: 50,
        detail: `Transfer value exceeds SAFE_VALUE_USD threshold ($${RISK_POLICY.LIMITS.SAFE_VALUE_USD})`,
      });
    }
  } else {
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
  }

  if (
    projectedSmallBurst >= RISK_POLICY.LIMITS.SMALL_TX_BURST &&
    projectedVelocity >= RISK_POLICY.LIMITS.MAX_TX_COUNT
  ) {
    score = Math.max(score, 80);
    factors.push({
      factor: 'DRAIN_PATTERN',
      points: 80,
      detail: 'Rapid burst of small transfers detected',
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

  if (Number.isFinite(context.recentSpendUsd) && context.recentSpendUsd > 0) {
    const cumulativeSafeUsd =
      Number.isFinite(RISK_POLICY.LIMITS.SAFE_VALUE_USD)
        ? RISK_POLICY.LIMITS.SAFE_VALUE_USD * 4
        : 200;
    const ratio = context.recentSpendUsd / cumulativeSafeUsd;

    if (ratio >= 1) {
      const points = scoreRatio(
        ratio,
        RISK_POLICY.WEIGHTS.CUMULATIVE_SPEND
      );

      score += points;
      factors.push({
        factor: 'CUMULATIVE_SPEND',
        points,
        detail: `Cumulative spend value ${ratio.toFixed(2)}× window limit`,
      });
    }
  } else if (Number.isFinite(context.recentSpend)) {
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

  if (Number.isFinite(context.recentTxCount)) {
    const ratio = context.recentTxCount / RISK_POLICY.LIMITS.MAX_TX_COUNT;
    if (ratio >= 1) {
      const points = scoreRatio(
        ratio,
        RISK_POLICY.WEIGHTS.RAPID_FIRE
      );
      score += points;
      factors.push({
        factor: 'RAPID_FIRE',
        points,
        detail: `Recent transaction volume ${context.recentTxCount} in active window`,
      });
    }
  }

  if (Number.isFinite(context.txVelocity)) {
    const ratio = context.txVelocity / RISK_POLICY.LIMITS.MAX_TX_COUNT;
    if (ratio >= 1) {
      const points = scoreRatio(
        ratio,
        RISK_POLICY.WEIGHTS.TX_VELOCITY
      );
      score += points;
      factors.push({
        factor: 'TX_VELOCITY',
        points,
        detail: `High transfer velocity in ${RISK_POLICY.LIMITS.FAST_WINDOW_SEC}s window`,
      });
    }
  }

  if (context.smallChunkBurst === true || projectedSmallBurst >= RISK_POLICY.LIMITS.SMALL_TX_BURST) {
    score += RISK_POLICY.WEIGHTS.SMALL_CHUNK_DRAIN;
    factors.push({
      factor: 'SMALL_CHUNK_DRAIN',
      points: RISK_POLICY.WEIGHTS.SMALL_CHUNK_DRAIN,
      detail: 'Burst small-transfer draining pattern',
    });
  }

  if (context.repeatedRecipient === true) {
    score += RISK_POLICY.WEIGHTS.REPEAT_PATTERN;
    factors.push({
      factor: 'REPEAT_PATTERN',
      points: RISK_POLICY.WEIGHTS.REPEAT_PATTERN,
      detail: 'Repeated transfers to same recipient',
    });
  }

  if (Number.isFinite(context.recentHighRiskTx) && context.recentHighRiskTx > 0) {
    const points = clamp(context.recentHighRiskTx * 5, 0, 15);
    score += points;
    factors.push({
      factor: 'PRIOR_HIGH_RISK',
      points,
      detail: 'Recent high-risk transfer attempts observed',
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

  // Escalate compounding behavioral risk to HIGH when repeated-recipient and
  // prior high-risk attempts coexist with high transaction activity.
  if (
    factors.some((f) => f.factor === 'REPEAT_PATTERN') &&
    factors.some((f) => f.factor === 'PRIOR_HIGH_RISK') &&
    (
      factors.some((f) => f.factor === 'RAPID_FIRE') ||
      factors.some((f) => f.factor === 'TX_VELOCITY')
    )
  ) {
    score = Math.max(score, RISK_POLICY.THRESHOLDS.HIGH + 5);
    factors.push({
      factor: 'BEHAVIOR_ESCALATION',
      points: 5,
      detail: 'Repeat recipient + prior high-risk history + high activity escalated to HIGH',
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
