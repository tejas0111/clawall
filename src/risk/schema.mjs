import { z } from 'zod';

export const ActionType = z.enum([
  'WALLET_TRANSFER',
]);

export const RiskLevel = z.enum([
  'LOW',
  'MEDIUM',
  'HIGH',
]);

export const SourceType = z.enum([
  'USER_EMAIL',
  'USER_CHAT',
  'AUTOMATION',
  'UNKNOWN',
]);

export const ProposalSchema = z.object({
  id: z.string().uuid(),
  timestamp: z.number().int().positive(),
  action: ActionType,
  params: z.object({
    amount: z.number().int().positive(),
    recipient: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  }),
  metadata: z.object({
    source: SourceType,
    context: z.string().max(500).optional(),
  }),
}).strict();

export const ConstraintSchema = z.object({
  max_amount: z.number().int().positive(),
  allowed_recipient: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  expiry_ms: z.number().int().positive(),
  nonce: z.string().regex(/^[a-f0-9]{32}$/),
}).strict();

export const RiskAssessmentSchema = z.object({
  proposal_id: z.string().uuid(),
  risk_level: RiskLevel,
  requires_approval: z.boolean(),
  reasoning: z.string(),
}).strict();

