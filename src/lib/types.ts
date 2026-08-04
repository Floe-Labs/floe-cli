/** Response shapes for the Floe Credit API routes the CLI touches. */

export interface SerializedAgent {
  id: string;
  mode: 'legacy' | 'managed';
  fundingMode: 'wallet' | 'credit_line';
  name: string;
  status: string;
  suspendedReason: string | null;
  agentWalletAddress: string;
  privyWalletAddress: string | null;
  creditLimit: string | null;
  sessionSpendLimitRaw: string | null;
  selfServiceLocked: boolean;
  createdAt: string;
  closedAt: string | null;
}

export interface ProfileResponse {
  developer: {
    walletAddress: string;
    displayName: string | null;
    email: string | null;
    accountId: string | null;
    role: string | null;
    createdAt: string;
  };
  agents: Array<SerializedAgent & { creditUsed?: string }>;
}

export interface CreateAgentResponse {
  agentId: string;
  status: string;
  privyWalletAddress: string | null;
  delegationTxHash: string | null;
  welcomeCreditTxHash?: string;
}

export interface KeyBudgetView {
  policyId: string;
  limitRaw: string;
  spentRaw: string;
  remainingRaw: string;
  windowKind: string;
  windowResetsAt: string | null;
}

export interface AgentKeySummary {
  id: string;
  keyPrefix: string;
  label: string | null;
  permissions: 'read' | 'read_write';
  lastUsedAt: string | null;
  createdAt: string;
  budget: KeyBudgetView | null;
}

export interface MintKeyResponse extends AgentKeySummary {
  /** The raw floe_… key — returned exactly once, at mint/rotate time. */
  key: string;
}

export interface BalancesResponse {
  developerWalletBalanceRaw: string;
  agentWalletsBalanceRaw: string;
  apiCreditsAvailableRaw: string;
  currency: string;
  decimals: number;
}

export interface SpendLimitResponse {
  active: boolean;
  limitRaw: string | null;
  sessionSpentRaw?: string;
  sessionRemainingRaw?: string;
  sessionStartedAt?: string | null;
}

export interface GatewayModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  modality: 'text' | 'embedding' | 'tts' | 'stt' | 'realtime';
  context_window: number | null;
}

export interface ModelsResponse {
  object: 'list';
  data: GatewayModel[];
}
