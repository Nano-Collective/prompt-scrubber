import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'ava';
import { AuditLog } from '../../src/proxy/audit-log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = path.join(__dirname, '.tmp-audit-log');

test.after.always(async () => {
  await fs.promises.rm(tmpRoot, { recursive: true, force: true });
});

function readLines(file: string): unknown[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

test('writes JSON lines with a 0600 file inside a 0700 directory', async (t) => {
  const file = path.join(tmpRoot, 'nested', 'audit', 'audit.jsonl');
  const log = AuditLog.open(file, { log: () => {}, onDrop: () => {} });
  log.write({ a: 1 });
  log.write({ b: 2 });
  await log.close();

  t.deepEqual(readLines(file), [{ a: 1 }, { b: 2 }]);
  t.is(fs.statSync(file).mode & 0o777, 0o600);
  t.is(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
});

test('appends across reopen', async (t) => {
  const file = path.join(tmpRoot, 'append', 'audit.jsonl');
  const first = AuditLog.open(file, { log: () => {}, onDrop: () => {} });
  first.write({ run: 1 });
  await first.close();

  const second = AuditLog.open(file, { log: () => {}, onDrop: () => {} });
  second.write({ run: 2 });
  await second.close();

  t.deepEqual(readLines(file), [{ run: 1 }, { run: 2 }]);
});

test('open reports a clear error when the path is a directory', (t) => {
  const dir = path.join(tmpRoot, 'is-a-dir');
  fs.mkdirSync(dir, { recursive: true });
  const error = t.throws(() => AuditLog.open(dir, { log: () => {}, onDrop: () => {} }));
  t.regex(error?.message ?? '', /Cannot open audit log/);
});

test('close is idempotent and later writes are counted as dropped', async (t) => {
  const file = path.join(tmpRoot, 'close', 'audit.jsonl');
  let dropped = 0;
  const log = AuditLog.open(file, {
    log: () => {},
    onDrop: () => {
      dropped += 1;
    },
  });
  await Promise.all([log.close(), log.close()]);
  log.write({ late: true });
  t.is(dropped, 1);
  t.deepEqual(readLines(file), []);
});
