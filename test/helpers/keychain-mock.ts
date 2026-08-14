type KeychainModule = typeof import('../../src/lib/keychain.js');

/**
 * Module body for vi.mock('../src/lib/keychain.js'): the real module spread
 * through (so pure helpers like devKeyAccount stay real and new exports flow
 * through automatically), with storage replaced by an in-memory Map so tests
 * never touch the actual OS keychain.
 *
 * resolveDevKey/resolveAgentKey are reimplemented on the same Map rather than
 * inherited from `actual` — the real ones close over the real getSecret, so
 * spreading them through would reach the OS keychain whenever FLOE_API_KEY /
 * FLOE_AGENT_KEY are empty (exactly the signed-out cases tests exercise).
 *
 * Usage in a test file (vi.mock factories run hoisted, so the Map must come
 * from vi.hoisted and this module must be imported lazily):
 *
 *   const h = vi.hoisted(() => ({ secrets: new Map<string, string>() }));
 *   vi.mock('../src/lib/keychain.js', async (importOriginal) => {
 *     const { keychainMock } = await import('./helpers/keychain-mock.js');
 *     return keychainMock(await importOriginal<typeof import('../src/lib/keychain.js')>(), h.secrets);
 *   });
 */
export function keychainMock(actual: KeychainModule, secrets: Map<string, string>): KeychainModule {
  const { devKeyAccount, agentKeyAccount, legacyAgentKeyAccount } = actual;
  return {
    ...actual,
    getSecret: async (account: string) => secrets.get(account),
    setSecret: async (account: string, value: string) => {
      secrets.set(account, value);
    },
    resolveDevKey: async (apiUrl: string) =>
      process.env.FLOE_API_KEY || secrets.get(devKeyAccount(apiUrl)),
    resolveAgentKey: async (
      apiUrl: string,
      agentId: string | number | undefined,
      slot: { legacySlotAgentId?: string } = {},
    ) => {
      if (process.env.FLOE_AGENT_KEY) return process.env.FLOE_AGENT_KEY;
      if (agentId === undefined) return undefined;
      const stored = secrets.get(agentKeyAccount(apiUrl, agentId));
      if (stored) return stored;
      if (slot.legacySlotAgentId !== undefined && String(slot.legacySlotAgentId) === String(agentId)) {
        return secrets.get(legacyAgentKeyAccount(apiUrl));
      }
      return undefined;
    },
  };
}
