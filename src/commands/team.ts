import { ApiError } from '../lib/api.js';
import { expectArgs, str, type CommandDef } from '../lib/command.js';
import { DASHBOARD_URL } from '../lib/config.js';
import { confirmAction } from '../lib/confirm.js';
import { devContext } from '../lib/context.js';
import { bold, dim, green, kv, ok, printJson, sanitizeText, UsageError, warn } from '../lib/output.js';
import { table } from '../lib/table.js';

/**
 * Team roster for the shared account. Role gates are server-side:
 * any role can read members; invites need admin+ (admin-role invites need
 * owner); role changes are owner-only; removal is admin+ with owner required
 * to remove an admin/owner. Removal also revokes every API key the member
 * minted — keys are account-scoped, so this is surfaced in the confirm copy.
 *
 * The invite accept token is NEVER returned by the API (only its hash is
 * stored; the plaintext travels solely in the invite email), so the CLI
 * cannot print the accept link — it says so instead of pretending.
 */

type TeamRole = 'owner' | 'admin' | 'member' | 'viewer';

const INVITABLE_ROLES = ['admin', 'member', 'viewer'] as const;
type InvitableRole = (typeof INVITABLE_ROLES)[number];

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

interface TeamMember {
  memberWallet: string;
  role: TeamRole;
  displayName: string | null;
  email: string | null;
  invitedBy: string | null;
  createdAt: string | null;
  isSelf: boolean;
}

interface MembersResponse {
  members: TeamMember[];
  role: TeamRole | null;
}

interface TeamInvite {
  id: number;
  email: string;
  role: InvitableRole;
  expiresAt: string;
  createdAt: string | null;
}

interface RemoveMemberResponse {
  ok: boolean;
  memberWallet: string;
  revokedKeys: number;
}

export interface TeamFlags {
  role?: string;
  apiUrl?: string;
  json?: boolean;
  yes?: boolean;
}

function parseInvitableRole(value: string | undefined, context: string): InvitableRole {
  if (!value || !(INVITABLE_ROLES as readonly string[]).includes(value)) {
    throw new UsageError(
      `${context} requires a role of: ${INVITABLE_ROLES.join(', ')}. ` +
        `(owner is not assignable — accounts always keep their owner.)`,
    );
  }
  return value as InvitableRole;
}

function requireWallet(value: string | undefined, usage: string): string {
  if (!value || !EVM_ADDRESS.test(value)) {
    throw new UsageError(`${usage} — <wallet> must be a 0x… address (see \`floe team members\`).`);
  }
  return value.toLowerCase();
}

export async function teamMembersCommand(flags: TeamFlags): Promise<void> {
  const { api } = await devContext(flags);
  const result = await api.dev<MembersResponse>('GET', '/v1/developer/team/members');

  if (flags.json) return printJson(result);

  process.stdout.write(`${bold(`Team members (${result.members.length})`)}\n`);
  process.stdout.write(
    `${table(
      ['WALLET', 'ROLE', 'NAME', 'JOINED'],
      result.members.map((m) => [
        m.isSelf ? `${green('●')} ${m.memberWallet}` : `  ${m.memberWallet}`,
        m.role,
        m.displayName ? sanitizeText(m.displayName) : dim('—'),
        m.createdAt ? m.createdAt.slice(0, 10) : dim('—'),
      ]),
    )}\n`,
  );
  process.stdout.write(`${dim(`● = you${result.role ? ` (role: ${result.role})` : ''}`)}\n`);
}

export async function teamInviteCommand(email: string, flags: TeamFlags): Promise<void> {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new UsageError(`"${email}" does not look like an email address.`);
  }
  const role = parseInvitableRole(flags.role, 'floe team invite <email> --role <role>');
  const { api } = await devContext(flags);
  const { invite } = await api.dev<{ invite: TeamInvite }>('POST', '/v1/developer/team/invites', {
    email,
    role,
  });

  if (flags.json) return printJson({ invite });

  process.stdout.write(`${ok(`Invited ${bold(sanitizeText(invite.email))} as ${invite.role}`)}\n`);
  const rows: Array<[string, string]> = [
    ['Invite id', String(invite.id)],
    ['Expires', invite.expiresAt.slice(0, 10)],
  ];
  process.stdout.write(`${kv(rows)}\n`);
  process.stdout.write(
    `${dim(
      `The single-use accept link (${DASHBOARD_URL}/invite/accept?token=…) was emailed to them —\n` +
        `the token is never shown here. Revoke with: floe team revoke-invite ${invite.id}`,
    )}\n`,
  );
}

export async function teamRevokeInviteCommand(id: string, flags: TeamFlags): Promise<void> {
  if (!/^\d+$/.test(id) || Number(id) < 1) {
    throw new UsageError(`Invalid invite id "${id}" — use the numeric id from \`floe team invite\`.`);
  }
  await confirmAction(`revoke invite ${id}`, id, { yes: flags.yes });
  const { api } = await devContext(flags);
  await api.dev('DELETE', `/v1/developer/team/invites/${Number(id)}`);

  if (flags.json) return printJson({ revoked: true, id: Number(id) });
  process.stdout.write(`${ok(`Invite ${id} revoked — its emailed accept link no longer works.`)}\n`);
}

export async function teamSetRoleCommand(
  walletArg: string,
  roleArg: string | undefined,
  flags: TeamFlags,
): Promise<void> {
  const wallet = requireWallet(walletArg, 'Usage: floe team set-role <wallet> <role>');
  const role = parseInvitableRole(roleArg, 'floe team set-role <wallet> <role>');
  const { api } = await devContext(flags);
  let result: { ok: boolean; memberWallet: string; role: TeamRole };
  try {
    result = await api.dev('PATCH', `/v1/developer/team/members/${wallet}`, { role });
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      throw new ApiError(
        'Only the account owner can change member roles.',
        403,
        err.code,
        'Ask the account owner, or check your role with `floe team members`.',
      );
    }
    throw err;
  }

  if (flags.json) return printJson(result);
  process.stdout.write(`${ok(`${wallet} is now ${bold(result.role)}`)}\n`);
}

export async function teamRemoveCommand(walletArg: string, flags: TeamFlags): Promise<void> {
  const wallet = requireWallet(walletArg, 'Usage: floe team remove <wallet>');
  // Removal also revokes every API key this member minted (keys are
  // account-scoped) — the confirm copy must say so before anything is sent.
  await confirmAction(
    `remove team member ${wallet} — this also revokes every API key they minted`,
    wallet,
    { yes: flags.yes },
  );
  const { api } = await devContext(flags);
  const result = await api.dev<RemoveMemberResponse>(
    'DELETE',
    `/v1/developer/team/members/${wallet}`,
  );

  if (flags.json) return printJson(result);
  process.stdout.write(`${ok(`Removed ${wallet} from the account.`)}\n`);
  if (result.revokedKeys > 0) {
    process.stdout.write(
      `${warn(`${result.revokedKeys} API key${result.revokedKeys === 1 ? '' : 's'} they minted ${result.revokedKeys === 1 ? 'was' : 'were'} revoked.`)}\n`,
    );
  }
}

export const teamDef: CommandDef = {
  name: 'team',
  summary: 'members | invite | revoke-invite | set-role | remove — team roster',
  usage: `Usage: floe team members
       floe team invite <email> --role admin|member|viewer
       floe team revoke-invite <id>
       floe team set-role <wallet> <role>
       floe team remove <wallet>

Teammates share this account: its agents, keys, and billing.
  members             Roster with wallet, role, and join date (● = you)
  invite <email>      Email a single-use accept link (--role required; inviting
                      an admin requires the owner role)
  revoke-invite <id>  Cancel a pending invite before it is accepted
  set-role <w> <r>    Change a member's role — owner only (roles: admin, member, viewer)
  remove <wallet>     Remove a member. Also revokes every API key they minted.
                      Removing an admin requires the owner role.

Destructive verbs (revoke-invite, remove) prompt for confirmation; pass --yes
in scripts.
`,
  options: {
    role: { type: 'string' },
  },
  run: async (ctx) => {
    const [subcommand, arg1, arg2] = ctx.args;
    const flags: TeamFlags = {
      apiUrl: ctx.apiUrl,
      json: ctx.json,
      yes: ctx.yes,
      role: str(ctx, 'role'),
    };
    if (subcommand === undefined || subcommand === 'members') {
      expectArgs(ctx, 1);
      await teamMembersCommand(flags);
    } else if (subcommand === 'invite') {
      if (!arg1) throw new UsageError('Usage: floe team invite <email> --role admin|member|viewer');
      expectArgs(ctx, 2);
      await teamInviteCommand(arg1, flags);
    } else if (subcommand === 'revoke-invite') {
      if (!arg1) throw new UsageError('Usage: floe team revoke-invite <id>');
      expectArgs(ctx, 2);
      await teamRevokeInviteCommand(arg1, flags);
    } else if (subcommand === 'set-role') {
      if (!arg1) throw new UsageError('Usage: floe team set-role <wallet> <role>');
      expectArgs(ctx, 3);
      await teamSetRoleCommand(arg1, arg2, flags);
    } else if (subcommand === 'remove') {
      if (!arg1) throw new UsageError('Usage: floe team remove <wallet>');
      expectArgs(ctx, 2);
      await teamRemoveCommand(arg1, flags);
    } else {
      throw new UsageError(
        `Unknown team subcommand "${subcommand}". Use: members, invite, revoke-invite, set-role, remove.`,
      );
    }
  },
};
