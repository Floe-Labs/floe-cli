import type { CommandDef } from '../lib/command.js';
import { accountDef } from './account.js';
import { actionsDef } from './actions.js';
import { activityDef } from './activity.js';
import { agentsDef } from './agents.js';
import { allowlistDef } from './allowlist.js';
import { billingDef } from './billing.js';
import { budgetDef } from './budget.js';
import { cashoutDef } from './cashout.js';
import { chatDef } from './chat.js';
import { creditDef } from './credit.js';
import { devkeysDef } from './devkeys.js';
import { embedDef } from './embed.js';
import { estimateDef } from './estimate.js';
import { fundsDef } from './funds.js';
import { initDef } from './init.js';
import { keysDef } from './keys.js';
import { ledgerDef } from './ledger.js';
import { modelsDef } from './models.js';
import { orchestratorsDef } from './orchestrators.js';
import { payDef } from './pay.js';
import { phoneDef } from './phone.js';
import { policyDef } from './policy.js';
import { providersDef } from './providers.js';
import { speakDef } from './speak.js';
import { statusDef } from './status.js';
import { teamDef } from './team.js';
import { testDef } from './test.js';
import { transcribeDef } from './transcribe.js';
import { usageDef } from './usage.js';
import { useDef } from './use.js';
import { vendorsDef } from './vendors.js';
import { webhooksDef } from './webhooks.js';

export interface Section {
  title: string;
  commands: CommandDef[];
}

/** Ordered for the top-level HELP: onboarding first, plumbing last. */
export const SECTIONS: Section[] = [
  { title: 'GET STARTED', commands: [initDef, statusDef, useDef, testDef] },
  { title: 'METERED CALLS', commands: [chatDef, embedDef, speakDef, transcribeDef, payDef] },
  {
    title: 'AGENTS & LIMITS',
    commands: [agentsDef, keysDef, devkeysDef, budgetDef, policyDef, allowlistDef, creditDef],
  },
  {
    title: 'OBSERVABILITY & BILLING',
    commands: [activityDef, usageDef, ledgerDef, billingDef, accountDef, teamDef],
  },
  { title: 'MONEY', commands: [fundsDef, cashoutDef] },
  {
    title: 'PLATFORM',
    commands: [
      webhooksDef,
      modelsDef,
      estimateDef,
      providersDef,
      phoneDef,
      actionsDef,
      orchestratorsDef,
      vendorsDef,
    ],
  },
];

export const registry = new Map<string, CommandDef>(
  SECTIONS.flatMap((s) => s.commands).map((def) => [def.name, def]),
);
