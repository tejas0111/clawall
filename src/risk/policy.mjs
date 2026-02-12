export function evaluatePolicy(risk) {
  const level = risk?.risk_level;

  if (!level) {
    return {
      action: 'BLOCK',
      alert: true,
      reason: 'Missing or invalid risk level',
    };
  }

  switch (level) {
    case 'HIGH':
      return {
        action: 'REQUIRE_APPROVAL',
        alert: true,
        reason: 'High risk transaction requires human approval',
      };

    case 'MEDIUM':
      return {
        action: 'ALLOW',
        alert: true,
        reason: 'Medium risk allowed with alert',
      };

    case 'LOW':
      return {
        action: 'ALLOW',
        alert: false,
        reason: 'Low risk auto-approved',
      };

    default:
      return {
        action: 'BLOCK',
        alert: true,
        reason: `Unhandled risk level: ${level}`,
      };
  }
}

