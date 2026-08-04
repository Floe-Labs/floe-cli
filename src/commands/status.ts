import { FloeApi } from '../lib/api.js';
import { readConfig, resolveApiUrl } from '../lib/config.js';
import { resolveAgentKey, resolveDevKey } from '../lib/keychain.js';
import { bold, dim, green, kv, printJson, red, yellow } from '../lib/output.js';
import type {
  AgentKeySummary,
  BalancesResponse,
  ProfileResponse,
  SpendLimitResponse,
} from '../lib/types.js';
import { rawToUsd } from '../lib/usdc.js';

export interface StatusFlags {
  apiUrl?: string;
  json?: boolean;
}

export async function statusCommand(flags: StatusFlags): Promise<void> {
  const config = readConfig();
  const apiUrl = resolveApiUrl(flags.apiUrl, config);
  const devKey = await resolveDevKey(apiUrl);
  const agentKey = await resolveAgentKey(apiUrl);

  if (!devKey) {
    if (flags.json) {
      printJson({ authenticated: false, apiUrl });
      process.exitCode = 4;
      return;
    }
    process.stdout.write(`${red('✗')} Not signed in. Run ${bold('floe init')} to get set up.\n`);
    process.exitCode = 4;
    return;
  }

  const api = new FloeApi(apiUrl, devKey);
  const [profile, balances] = await Promise.all([
    api.dev<ProfileResponse>('GET', '/v1/developer/profile'),
    api.dev<BalancesResponse>('GET', '/v1/developer/balances'),
  ]);

  const agent =
    profile.agents.find((a) => a.id === config.agentId) ??
    profile.agents.find((a) => a.status === 'active');
  const configStale = Boolean(config.agentId && agent && agent.id !== config.agentId);

  let keys: AgentKeySummary[] = [];
  let spendLimit: SpendLimitResponse | undefined;
  if (agent) {
    [{ keys }, spendLimit] = await Promise.all([
      api.dev<{ keys: AgentKeySummary[] }>('GET', `/v1/developer/agents/${agent.id}/keys`),
      api.dev<SpendLimitResponse>('GET', `/v1/developer/agents/${agent.id}/spend-limit`),
    ]);
  }
  const activeKey = config.keyId
    ? keys.find((k) => k.id === config.keyId)
    : keys[0];

  if (flags.json) {
    printJson({
      authenticated: true,
      apiUrl,
      developer: profile.developer,
      agent: agent ?? null,
      configStale,
      agentKeyConfigured: Boolean(agentKey),
      activeKey: activeKey ?? null,
      spendLimit: spendLimit ?? null,
      balances,
    });
    return;
  }

  const who = profile.developer.displayName || profile.developer.email || profile.developer.walletAddress;
  const rows: Array<[string, string]> = [
    ['Account', `${who} ${dim(apiUrl)}`],
  ];
  if (agent) {
    const statusText =
      agent.status === 'active' ? green(agent.status) : yellow(`${agent.status}${agent.suspendedReason ? ` (${agent.suspendedReason})` : ''}`);
    rows.push(['Agent', `${agent.name} ${dim(agent.id)} — ${statusText}`]);
  } else {
    rows.push(['Agent', yellow('none — run floe init')]);
  }
  rows.push([
    'Agent key',
    agentKey
      ? `${activeKey?.keyPrefix ?? 'configured'} ${dim('(in keychain)')}`
      : yellow('missing locally — run floe init'),
  ]);
  rows.push(['Balance', `${rawToUsd(balances.apiCreditsAvailableRaw)} credits · ${rawToUsd(balances.agentWalletsBalanceRaw)} in agent wallets`]);
  if (activeKey?.budget) {
    rows.push([
      'Key budget',
      `${rawToUsd(activeKey.budget.remainingRaw)} of ${rawToUsd(activeKey.budget.limitRaw)} remaining ${dim(`(${activeKey.budget.windowKind})`)}`,
    ]);
  }
  if (spendLimit?.active) {
    rows.push([
      'Spend limit',
      `${rawToUsd(spendLimit.sessionRemainingRaw)} of ${rawToUsd(spendLimit.limitRaw)} remaining`,
    ]);
  } else if (agent) {
    rows.push(['Spend limit', dim('none — set one with floe budget set <usd>')]);
  }

  process.stdout.write(`${bold('Floe')} ${green('●')} signed in\n${kv(rows)}\n`);
  if (configStale) {
    process.stdout.write(
      `${yellow('!')} This machine was set up for a different agent that is no longer available — run ${bold('floe init')} to reconfigure.\n`,
    );
  }
}
