import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'ava';
import {
  assertClipboardSupport,
  clipboardTool,
  formatNotificationMessage,
  handleWatch,
  isCommandAvailable,
  notificationTool,
  resetNotificationWarning,
  sendNotification,
  watchClipboardStep,
  watchFileStep,
} from '../../src/cli/commands/watch.js';
import { rehydrate } from '../../src/core/rehydrate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tmpDir = path.join(__dirname, '.tmp-cli-watch-full');

test.before(() => {
  process.env.PROMPT_SCRUB_CONFIG_DIR = tmpDir;
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }
});

test.after.always(() => {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('formatNotificationMessage correctly formats single and plural categories', (t) => {
  t.is(formatNotificationMessage(undefined), 'Scrubbed 0 items');
  t.is(formatNotificationMessage({}), 'Scrubbed 0 items');
  t.is(formatNotificationMessage({ Secret: 2 }), 'Scrubbed 2 secrets');
  t.is(formatNotificationMessage({ Secret: 1, Email: 1 }), 'Scrubbed 1 secret, 1 email');
});

test('watchClipboardStep scrubs sensitive data, logs, and triggers notification', async (t) => {
  let written = '';
  let logged = '';
  let notifiedTitle = '';
  let notifiedMsg = '';

  const mockRead = () => 'Contact user@example.com immediately';
  const mockWrite = (text: string) => {
    written = text;
  };
  const mockLog = (msg: string) => {
    logged = msg;
  };
  const mockNotify = (title: string, msg: string) => {
    notifiedTitle = title;
    notifiedMsg = msg;
  };

  const next = await watchClipboardStep('', {
    readClipboardFn: mockRead,
    writeClipboardFn: mockWrite,
    logFn: mockLog,
    notifyFn: mockNotify,
  });

  t.is(next, 'Contact «Email_1» immediately');
  t.is(written, 'Contact «Email_1» immediately');
  t.true(logged.includes('[watch] Scrubbed 1 email from clipboard.'));
  t.is(notifiedTitle, 'prompt-scrub');
  t.is(notifiedMsg, 'Scrubbed 1 email');
});

test('watchClipboardStep does nothing when clipboard has not changed', async (t) => {
  let writeCalled = false;
  const mockRead = () => 'Contact user@example.com immediately';
  const mockWrite = () => {
    writeCalled = true;
  };

  const current = 'Contact user@example.com immediately';
  const next = await watchClipboardStep(current, {
    readClipboardFn: mockRead,
    writeClipboardFn: mockWrite,
  });

  t.is(next, current);
  t.false(writeCalled);
});

test('watchFileStep scrubs file content when file changes and triggers notification', async (t) => {
  const filePath = path.join(tmpDir, 'test-watch-file.txt');
  fs.writeFileSync(filePath, 'Send key sk-1234567890abcdef1234567890abcdef here', 'utf8');

  let logged = '';
  let notifiedMsg = '';
  const mockLog = (msg: string) => {
    logged = msg;
  };
  const mockNotify = (_title: string, msg: string) => {
    notifiedMsg = msg;
  };

  const next = await watchFileStep(filePath, '', {
    logFn: mockLog,
    notifyFn: mockNotify,
  });

  t.is(next, 'Send key «Secret_1» here');
  t.is(fs.readFileSync(filePath, 'utf8'), 'Send key «Secret_1» here');
  t.true(logged.includes('[watch] Scrubbed 1 secret in'));
  t.true(notifiedMsg.includes('Scrubbed 1 secret in'));
});

test('handleWatch supports watching multiple files', async (t) => {
  const file1 = path.join(tmpDir, 'f1.txt');
  const file2 = path.join(tmpDir, 'f2.txt');
  fs.writeFileSync(file1, 'Email: alice@example.com', 'utf8');
  fs.writeFileSync(file2, 'Key: sk-1234567890abcdef1234567890abcdef', 'utf8');

  const logs: string[] = [];
  const mockLog = (msg: string) => {
    logs.push(msg);
  };

  await handleWatch({
    file: [file1, file2],
    once: true,
    logFn: mockLog,
  });

  t.is(fs.readFileSync(file1, 'utf8'), 'Email: «Email_1»');
  t.is(fs.readFileSync(file2, 'utf8'), 'Key: «Secret_1»');
  t.is(logs.filter((l) => l.startsWith('[watch] Scrubbed')).length, 2);
});

test('handleWatch shares one session so distinct values never collide', async (t) => {
  const file1 = path.join(tmpDir, 'shared-1.txt');
  const file2 = path.join(tmpDir, 'shared-2.txt');
  fs.writeFileSync(file1, 'me: alice@example.com', 'utf8');
  fs.writeFileSync(file2, 'them: bob@example.com', 'utf8');

  const logs: string[] = [];

  await handleWatch({
    file: [file1, file2],
    once: true,
    logFn: (msg) => {
      logs.push(msg);
    },
  });

  t.is(fs.readFileSync(file1, 'utf8'), 'me: «Email_1»');
  t.is(fs.readFileSync(file2, 'utf8'), 'them: «Email_2»', 'a second value must not reuse Email_1');

  const idLine = logs.find((l) => l.startsWith('[watch] Session ID: '));
  t.truthy(idLine, 'the session ID must be printed so the files can be rehydrated');
  const sessionId = idLine!.replace('[watch] Session ID: ', '');

  t.is(
    rehydrate({ content: 'me: «Email_1» / them: «Email_2»', sessionId }).content,
    'me: alice@example.com / them: bob@example.com',
    'one session round-trips both values',
  );
});

test('a later tick reports only what it scrubbed, not the running session total', async (t) => {
  const filePath = path.join(tmpDir, 'per-tick.txt');
  fs.writeFileSync(filePath, 'me: alice@example.com', 'utf8');

  const logs: string[] = [];
  const opts = {
    sessionId: 'watch-per-tick',
    logFn: (msg: string) => {
      logs.push(msg);
    },
    notifyFn: () => {},
  };

  const first = await watchFileStep(filePath, '', opts);
  fs.appendFileSync(filePath, ' / them: bob@example.com', 'utf8');
  await watchFileStep(filePath, first, opts);

  t.is(fs.readFileSync(filePath, 'utf8'), 'me: «Email_1» / them: «Email_2»');
  t.true(logs[0]?.startsWith('[watch] Scrubbed 1 email in'));
  t.true(logs[1]?.startsWith('[watch] Scrubbed 1 email in'), 'second tick must not say 2 emails');
});

test('handleWatch reuses an explicit --session-id instead of minting one', async (t) => {
  const filePath = path.join(tmpDir, 'explicit-session.txt');
  fs.writeFileSync(filePath, 'Contact carol@example.com', 'utf8');

  const logs: string[] = [];

  await handleWatch({
    file: filePath,
    sessionId: 'watch-explicit-session',
    once: true,
    logFn: (msg) => {
      logs.push(msg);
    },
  });

  t.true(logs.includes('[watch] Session ID: watch-explicit-session'));
  t.is(
    rehydrate({ content: fs.readFileSync(filePath, 'utf8'), sessionId: 'watch-explicit-session' })
      .content,
    'Contact carol@example.com',
  );
});

test('handleWatch throws when neither --clipboard nor --file is provided', async (t) => {
  await t.throwsAsync(
    async () => {
      await handleWatch({});
    },
    { message: 'Must specify --clipboard or --file <file>' },
  );
});

test('isCommandAvailable detects present and absent binaries', (t) => {
  t.true(isCommandAvailable(process.platform === 'win32' ? 'where.exe' : 'sh'));
  t.false(isCommandAvailable('prompt-scrub-definitely-not-a-real-binary'));
});

test('clipboardTool and notificationTool resolve a binary for this platform', (t) => {
  t.true(clipboardTool().length > 0);
  t.true(notificationTool().length > 0);
});

test('assertClipboardSupport passes when the platform clipboard tool exists', (t) => {
  if (isCommandAvailable(clipboardTool())) {
    t.notThrows(() => assertClipboardSupport());
  } else {
    t.throws(() => assertClipboardSupport(), { message: /was not found on your PATH/ });
  }
});

test('sendNotification warns once instead of silently failing when the tool is missing', (t) => {
  resetNotificationWarning();
  const warnings: string[] = [];
  const collect = (msg: string) => {
    warnings.push(msg);
  };

  if (isCommandAvailable(notificationTool())) {
    t.pass('notifier present on this machine; missing-tool path covered on CI runners without it');
    return;
  }

  sendNotification('prompt-scrub', 'Scrubbed 1 email', collect);
  sendNotification('prompt-scrub', 'Scrubbed 1 email', collect);

  t.is(warnings.length, 1);
  t.true(warnings[0]?.includes('Desktop notifications disabled'));
});

test('sendNotification does not execute shell metacharacters in the message', (t) => {
  resetNotificationWarning();
  const marker = path.join(tmpDir, 'pwned.txt');
  const posixMarker = marker.split(path.sep).join('/');
  // Mixes command substitution, backticks and a bare apostrophe - the three
  // things that broke the old execSync string interpolation.
  const injected = [
    'Scrubbed 1 secret in',
    `$(node -e "require('fs').writeFileSync('${posixMarker}','x')")`,
    `\`node -e "require('fs').writeFileSync('${posixMarker}','x')"\``,
    "it's.txt",
  ].join(' ');

  t.notThrows(() => sendNotification('prompt-scrub', injected, () => {}));
  t.false(fs.existsSync(marker), 'command substitution in the message must not run');
});

test('watchFileStep with dryRun reports without writing the file', async (t) => {
  const filePath = path.join(tmpDir, 'dry-run.txt');
  const original = 'Contact user@example.com immediately';
  fs.writeFileSync(filePath, original, 'utf8');

  const logs: string[] = [];
  let notified = false;

  const next = await watchFileStep(filePath, '', {
    dryRun: true,
    logFn: (msg) => {
      logs.push(msg);
    },
    notifyFn: () => {
      notified = true;
    },
  });

  t.is(fs.readFileSync(filePath, 'utf8'), original, 'file must be left untouched');
  t.is(next, original);
  t.false(notified, 'dry-run must not fire a notification');
  t.true(logs.some((l) => l.includes('(dry-run)')));
});

test('watchClipboardStep with dryRun reports without writing the clipboard', async (t) => {
  let writeCalled = false;
  const logs: string[] = [];

  const next = await watchClipboardStep('', {
    dryRun: true,
    readClipboardFn: () => 'Contact user@example.com immediately',
    writeClipboardFn: () => {
      writeCalled = true;
    },
    logFn: (msg) => {
      logs.push(msg);
    },
    notifyFn: () => {},
  });

  t.false(writeCalled, 'dry-run must not write the clipboard');
  t.is(next, 'Contact user@example.com immediately');
  t.true(logs.some((l) => l.includes('(dry-run)')));
});

test('watchFileStep with backup writes <file>.bak holding the original content', async (t) => {
  const filePath = path.join(tmpDir, 'backup-me.txt');
  const original = 'Contact user@example.com immediately';
  fs.writeFileSync(filePath, original, 'utf8');

  await watchFileStep(filePath, '', {
    backup: true,
    logFn: () => {},
    notifyFn: () => {},
  });

  t.is(fs.readFileSync(filePath, 'utf8'), 'Contact «Email_1» immediately');
  t.true(fs.existsSync(`${filePath}.bak`));
  t.is(fs.readFileSync(`${filePath}.bak`, 'utf8'), original, 'backup keeps pre-scrub content');
});

test('handleWatch registers a SIGINT handler that clears the timer and stops', async (t) => {
  const filePath = path.join(tmpDir, 'sigint.txt');
  fs.writeFileSync(filePath, 'nothing sensitive here', 'utf8');

  const before = process.listenerCount('SIGINT');
  let stopped = false;

  const timer = await handleWatch({
    file: filePath,
    interval: '50',
    logFn: () => {},
    notifyFn: () => {},
    onStop: () => {
      stopped = true;
    },
  });

  t.is(process.listenerCount('SIGINT'), before + 1, 'SIGINT handler is registered');

  process.emit('SIGINT');

  t.true(stopped, 'SIGINT invokes the stop path');
  t.is(process.listenerCount('SIGINT'), before, 'handler is removed again on stop');

  if (timer) {
    clearInterval(timer);
  }
});
