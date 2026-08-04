import { createInterface } from 'node:readline';

export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Prompt without echoing the input (for API keys). */
export function askSecret(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const anyRl = rl as unknown as {
    _writeToOutput: (s: string) => void;
    output: NodeJS.WritableStream;
  };
  let muted = false;
  const original = anyRl._writeToOutput.bind(rl);
  anyRl._writeToOutput = (s: string) => {
    if (muted) {
      // Echo a placeholder only for printable input, never the key itself.
      if (!s.includes('\n') && !s.includes('\r')) anyRl.output.write('*');
      else anyRl.output.write('\n');
      return;
    }
    original(s);
  };
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
    muted = true;
  });
}
