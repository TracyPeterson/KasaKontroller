import readline from 'node:readline';
import { Writable } from 'node:stream';

export function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

// Like ask(), but doesn't echo what's typed.
export function askHidden(question) {
  const muted = new Writable({
    write(chunk, enc, cb) { if (!muted.isMuted) process.stdout.write(chunk); cb(); },
  });
  muted.isMuted = false;
  const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: !!process.stdin.isTTY });
  return new Promise((resolve) => {
    rl.question(question, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
    muted.isMuted = true;
  });
}
