import { parseArgs } from 'node:util';
import { budgetClearCommand, budgetSetCommand, budgetShowCommand } from './commands/budget.js';
import { initCommand } from './commands/init.js';
import { keysListCommand, keysRotateCommand } from './commands/keys.js';
import { statusCommand } from './commands/status.js';
import { testCommand } from './commands/test.js';
import { ApiError } from './lib/api.js';
import { bold, cyan, dim, errDim, errRed, UsageError } from './lib/output.js';
import { cliVersion } from './lib/version.js';

const HELP = `${bold('floe')} — wire a metered Floe gateway key into your agent

${bold('USAGE')}
  floe <command> [flags]

${bold('COMMANDS')}
  ${cyan('init')}      Authenticate, set up an agent + key, print the base-URL swap
              ${dim('flags: --key <floe_live_…> --agent <name> --name <name> --new-key --open')}
  ${cyan('status')}    Am I set up? Balance, budgets, active agent and key
  ${cyan('test')}      Make one real metered call and print its cost
              ${dim('flags: --voice (STT → LLM → TTS), --model <id>,')}
              ${dim('       --stt-model <id> --tts-model <id> --tts-voice <name>')}
  ${cyan('budget')}    show | set <usd> [--per day|task [--task <id>]] | clear [--per day]
  ${cyan('keys')}      list | rotate [keyId]

${bold('GLOBAL FLAGS')}
  --json           Machine-readable output
  --api-url <url>  Override the API base (default: https://credit-api.floelabs.xyz)
  --version        Print the CLI version
  --help           This help

${bold('ENVIRONMENT')}
  FLOE_API_KEY     Developer key (floe_live_…) — overrides the keychain
  FLOE_AGENT_KEY   Agent key (floe_…) — overrides the keychain
  FLOE_API_URL     API base URL

${bold('EXIT CODES')}
  0 ok · 1 error · 2 usage · 4 auth · 5 payment/budget

Get started:  ${bold('npx @floelabs/cli init')}
`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        key: { type: 'string' },
        agent: { type: 'string' },
        name: { type: 'string' },
        model: { type: 'string' },
        'stt-model': { type: 'string' },
        'tts-model': { type: 'string' },
        'tts-voice': { type: 'string' },
        per: { type: 'string' },
        task: { type: 'string' },
        'api-url': { type: 'string' },
        'new-key': { type: 'boolean' },
        open: { type: 'boolean' },
        voice: { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean' },
        version: { type: 'boolean' },
      },
    });
  } catch (err) {
    process.stderr.write(`${errRed('error:')} ${(err as Error).message}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }

  const { values, positionals } = parsed;
  const [command, subcommand, arg] = positionals;
  const common = { apiUrl: values['api-url'], json: values.json };

  // Commands must consume every positional — extra arguments are a typo, and
  // a typo must never silently reach a state-changing command.
  const expectArgs = (max: number) => {
    if (positionals.length > max) {
      throw new UsageError(`Unexpected argument "${positionals[max]}".`);
    }
  };

  if (values.version) {
    process.stdout.write(`floe-cli/${cliVersion()}\n`);
    return;
  }
  if (values.help || !command || command === 'help') {
    process.stdout.write(HELP);
    return;
  }

  try {
    switch (command) {
      case 'init':
        expectArgs(1);
        await initCommand({
          ...common,
          key: values.key,
          agent: values.agent,
          name: values.name,
          newKey: values['new-key'],
          open: values.open,
        });
        break;
      case 'status':
        expectArgs(1);
        await statusCommand(common);
        break;
      case 'test':
        expectArgs(1);
        await testCommand({
          ...common,
          voice: values.voice,
          model: values.model,
          sttModel: values['stt-model'],
          ttsModel: values['tts-model'],
          ttsVoice: values['tts-voice'],
        });
        break;
      case 'budget': {
        const flags = { ...common, per: values.per, task: values.task };
        if (subcommand === 'set') {
          if (!arg) throw new UsageError('Usage: floe budget set <usd> [--per day|task [--task <id>]]');
          expectArgs(3);
          await budgetSetCommand(arg, flags);
        } else if (subcommand === 'clear') {
          expectArgs(2);
          await budgetClearCommand(flags);
        } else if (subcommand === undefined || subcommand === 'show') {
          expectArgs(2);
          await budgetShowCommand(flags);
        } else {
          throw new UsageError(`Unknown budget subcommand "${subcommand}". Use: show, set <usd>, clear.`);
        }
        break;
      }
      case 'keys': {
        if (subcommand === 'rotate') {
          expectArgs(3);
          await keysRotateCommand(arg, common);
        } else if (subcommand === undefined || subcommand === 'list') {
          expectArgs(2);
          await keysListCommand(common);
        } else {
          throw new UsageError(`Unknown keys subcommand "${subcommand}". Use: list, rotate [keyId].`);
        }
        break;
      }
      default:
        process.stderr.write(`${errRed('error:')} unknown command "${command}"\n\n${HELP}`);
        process.exitCode = 2;
        return;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${errRed('error:')} ${err.message}\n`);
      process.exitCode = 2;
      return;
    }
    if (err instanceof ApiError) {
      process.stderr.write(`${errRed('error:')} ${err.message}\n`);
      if (err.hint) process.stderr.write(`${errDim(`hint: ${err.hint}`)}\n`);
      process.exitCode = err.exitCode;
      return;
    }
    process.stderr.write(`${errRed('error:')} ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}
