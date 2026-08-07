import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './config.js';

/**
 * Secret storage: OS keychain via @napi-rs/keyring when the native binding
 * loads, otherwise a 0600 credentials file (the gh-CLI model). Env vars
 * FLOE_API_KEY / FLOE_AGENT_KEY always win — that's the CI / coding-agent path.
 *
 * Accounts are scoped by API host so a staging login can't shadow production.
 */

const SERVICE = 'floe-cli';

type KeyringEntry = { getPassword(): string; setPassword(password: string): void; deletePassword(): boolean };
type KeyringModule = { Entry: new (service: string, account: string) => KeyringEntry };

let keyringModule: KeyringModule | null | undefined;
let warnedFallback = false;

async function loadKeyring(): Promise<KeyringModule | null> {
  if (keyringModule !== undefined) return keyringModule;
  try {
    keyringModule = (await import('@napi-rs/keyring')) as unknown as KeyringModule;
  } catch {
    keyringModule = null;
  }
  return keyringModule;
}

function warnFallbackOnce(): void {
  if (warnedFallback) return;
  warnedFallback = true;
  process.stderr.write(
    'note: OS keychain unavailable — storing keys in ~/.config/floe/credentials.json (0600)\n',
  );
}

const credentialsPath = () => join(configDir(), 'credentials.json');

function readCredentialsFile(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(credentialsPath(), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeCredentialsFile(creds: Record<string, string>): void {
  mkdirSync(configDir(), { recursive: true });
  const path = credentialsPath();
  writeFileSync(path, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  // The mode option only applies at creation — re-tighten pre-existing files.
  if (process.platform !== 'win32') {
    try {
      chmodSync(path, 0o600);
    } catch {
      // best effort
    }
  }
}

export async function getSecret(account: string): Promise<string | undefined> {
  const keyring = await loadKeyring();
  if (keyring) {
    try {
      return new keyring.Entry(SERVICE, account).getPassword();
    } catch {
      // No entry in the keychain — fall through to the file in case a
      // previous run stored it there.
    }
  }
  return readCredentialsFile()[account];
}

export async function setSecret(account: string, value: string): Promise<void> {
  const keyring = await loadKeyring();
  if (keyring) {
    try {
      new keyring.Entry(SERVICE, account).setPassword(value);
      return;
    } catch {
      // Native binding present but the backend refused (headless Linux, locked
      // keychain) — degrade to the credentials file.
    }
  }
  warnFallbackOnce();
  const creds = readCredentialsFile();
  creds[account] = value;
  writeCredentialsFile(creds);
}

export const devKeyAccount = (apiUrl: string) => `dev-key:${new URL(apiUrl).host}`;

/**
 * Agent keys are stored per agent (`agent-key:<host>:<agentId>`) so `floe use`
 * can switch agents without re-minting — each agent caps at 5 keys, so the
 * 0.1 one-slot-per-host model burned a slot on every switch. The 0.1 slot
 * (`agent-key:<host>`) is still readable, but only for the agent that config
 * migration recorded as its owner — never for any other agent.
 */
export const agentKeyAccount = (apiUrl: string, agentId: string | number) =>
  `agent-key:${new URL(apiUrl).host}:${agentId}`;

export const legacyAgentKeyAccount = (apiUrl: string) => `agent-key:${new URL(apiUrl).host}`;

/** Developer key (floe_live_…) — management plane. */
export async function resolveDevKey(apiUrl: string): Promise<string | undefined> {
  return process.env.FLOE_API_KEY || (await getSecret(devKeyAccount(apiUrl)));
}

export interface AgentKeySlot {
  legacySlotAgentId?: string;
}

/** Agent key (floe_…) — gateway / payment plane. Env var wins for every agent. */
export async function resolveAgentKey(
  apiUrl: string,
  agentId: string | number | undefined,
  slot: AgentKeySlot = {},
): Promise<string | undefined> {
  if (process.env.FLOE_AGENT_KEY) return process.env.FLOE_AGENT_KEY;
  if (agentId === undefined) return undefined;
  const stored = await getSecret(agentKeyAccount(apiUrl, agentId));
  if (stored) return stored;
  if (slot.legacySlotAgentId !== undefined && String(slot.legacySlotAgentId) === String(agentId)) {
    return getSecret(legacyAgentKeyAccount(apiUrl));
  }
  return undefined;
}
