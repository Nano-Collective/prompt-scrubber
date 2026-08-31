import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import { loadConfig } from '../../core/config.js';
import { loadConfiguredRulePacks } from '../../core/rule-packs.js';
import { resolveLocale, warnIfLocaleUnused } from '../locale.js';
import { handleScrub } from './scrub.js';

/**
 * Every external process below is invoked through `spawnSync` with an argv
 * array and no shell. Titles, messages and file paths are therefore passed as
 * opaque arguments and are never parsed by `sh`/`cmd`, so a path such as
 * `$(whoami).txt` or `it's.txt` cannot break out of the command.
 */

const commandCache = new Map<string, boolean>();

/** Probe `PATH` once per binary so a missing tool is reported, not swallowed. */
export function isCommandAvailable(cmd: string): boolean {
  const cached = commandCache.get(cmd);
  if (cached !== undefined) return cached;

  const probe = process.platform === 'win32' ? 'where.exe' : 'which';
  const res = spawnSync(probe, [cmd], { stdio: 'ignore', windowsHide: true });
  const ok = !res.error && res.status === 0;

  commandCache.set(cmd, ok);
  return ok;
}

/** The binary this platform needs for clipboard access. */
export function clipboardTool(): string {
  if (process.platform === 'win32') return 'powershell.exe';
  if (process.platform === 'darwin') return 'pbpaste';
  return 'xclip';
}

/** The binary this platform needs for desktop notifications. */
export function notificationTool(): string {
  if (process.platform === 'win32') return 'powershell.exe';
  if (process.platform === 'darwin') return 'osascript';
  return 'notify-send';
}

function installHint(tool: string): string {
  switch (tool) {
    case 'xclip':
      return 'Install it with `sudo apt install xclip` (or your distro equivalent).';
    case 'notify-send':
      return 'Install it with `sudo apt install libnotify-bin` (or your distro equivalent).';
    case 'pbpaste':
    case 'osascript':
      return 'It ships with macOS - check that /usr/bin is on your PATH.';
    default:
      return 'Check that it is installed and on your PATH.';
  }
}

/** Fail fast with an actionable message rather than silently reading '' forever. */
export function assertClipboardSupport(): void {
  const tool = clipboardTool();
  if (!isCommandAvailable(tool)) {
    throw new Error(
      `Clipboard monitoring requires \`${tool}\`, which was not found on your PATH. ${installHint(tool)}`,
    );
  }
}

function readClipboard(): string {
  let res: ReturnType<typeof spawnSync>;
  if (process.platform === 'win32') {
    res = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard'], {
      encoding: 'utf8',
      windowsHide: true,
    });
  } else if (process.platform === 'darwin') {
    res = spawnSync('pbpaste', [], { encoding: 'utf8' });
  } else {
    res = spawnSync('xclip', ['-selection', 'clipboard', '-o'], { encoding: 'utf8' });
  }

  if (res.error || res.status !== 0 || typeof res.stdout !== 'string') return '';
  return process.platform === 'win32' ? res.stdout.replace(/\r\n$/, '') : res.stdout;
}

function writeClipboard(content: string): void {
  if (process.platform === 'win32') {
    // Passed via the environment so no quoting of `content` is ever required.
    spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Set-Clipboard -Value $env:CLIP_TEXT'], {
      env: { ...process.env, CLIP_TEXT: content },
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  if (process.platform === 'darwin') {
    spawnSync('pbcopy', [], { input: content, stdio: ['pipe', 'ignore', 'ignore'] });
    return;
  }
  spawnSync('xclip', ['-selection', 'clipboard'], {
    input: content,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
}

/** Escape a JS string for embedding in an AppleScript string literal. */
function escapeAppleScript(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

let notificationWarningShown = false;

/** Reset the once-per-process "notifier missing" warning latch (used by tests). */
export function resetNotificationWarning(): void {
  notificationWarningShown = false;
}

export function sendNotification(
  title: string,
  message: string,
  warnFn: (msg: string) => void = console.error,
): void {
  const tool = notificationTool();
  if (!isCommandAvailable(tool)) {
    if (!notificationWarningShown) {
      notificationWarningShown = true;
      warnFn(
        `[watch] Desktop notifications disabled: \`${tool}\` was not found on your PATH. ${installHint(tool)}`,
      );
    }
    return;
  }

  if (process.platform === 'darwin') {
    const script = `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}"`;
    spawnSync('osascript', ['-e', script], { stdio: 'ignore' });
    return;
  }

  if (process.platform === 'win32') {
    // Title/message travel via the environment; the script body stays constant.
    const psCmd =
      "[reflection.assembly]::loadwithpartialname('System.Windows.Forms'); " +
      '$notify = new-object system.windows.forms.notifyicon; ' +
      '$notify.icon = [system.drawing.systemicons]::information; ' +
      '$notify.visible = $true; ' +
      '$notify.showballoontip(3000, $env:PS_NOTIFY_TITLE, $env:PS_NOTIFY_MESSAGE, [system.windows.forms.tooltipicon]::info)';
    spawnSync('powershell.exe', ['-NoProfile', '-Command', psCmd], {
      env: { ...process.env, PS_NOTIFY_TITLE: title, PS_NOTIFY_MESSAGE: message },
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }

  // `--` stops notify-send treating a title/message beginning with `-` as a flag.
  spawnSync('notify-send', ['--', title, message], { stdio: 'ignore' });
}

export function formatNotificationMessage(sessionMap?: Record<string, string>): string {
  if (!sessionMap) return 'Scrubbed 0 items';
  const keys = Object.keys(sessionMap);
  if (keys.length === 0) return 'Scrubbed 0 items';

  const counts: Record<string, number> = {};
  for (const key of keys) {
    const cleanKey = key.replace(/[«»]/g, '');
    const prefix = cleanKey.split('_')[0] || 'item';
    const category = prefix.toLowerCase();
    counts[category] = (counts[category] || 0) + 1;
  }

  const parts = Object.entries(counts).map(([cat, cnt]) => {
    const name = cnt === 1 ? cat : `${cat}s`;
    return `${cnt} ${name}`;
  });

  return `Scrubbed ${parts.join(', ')}`;
}

interface WatchStepOptions {
  sessionId?: string;
  disable?: string;
  enable?: string;
  strictName?: boolean;
  codeTellTerms?: string;
  urlAllowlist?: string;
  locale?: string;
  dryRun?: boolean;
  backup?: boolean;
  readClipboardFn?: () => string;
  writeClipboardFn?: (text: string) => void;
  logFn?: (msg: string) => void;
  notifyFn?: (title: string, msg: string) => void;
}

export async function watchClipboardStep(
  lastContent: string,
  options: WatchStepOptions,
): Promise<string> {
  const readFn = options.readClipboardFn ?? readClipboard;
  const writeFn = options.writeClipboardFn ?? writeClipboard;
  const log = options.logFn ?? console.log;
  const notify = options.notifyFn ?? sendNotification;

  const current = readFn();
  if (current && current !== lastContent) {
    const result = await handleScrub(current, options);
    // Watch mode only handles string content
    const scrubbed = typeof result.scrubbedContent === 'string' ? result.scrubbedContent : current;
    if (scrubbed !== current) {
      const msg = formatNotificationMessage(result.sessionMap);
      if (options.dryRun) {
        log(`[watch] (dry-run) Would have ${msg.toLowerCase()} from clipboard.`);
        return current;
      }
      writeFn(scrubbed);
      log(`[watch] ${msg} from clipboard.`);
      notify('prompt-scrub', msg);
      return scrubbed;
    }
    return current;
  }
  return lastContent;
}

export async function watchFileStep(
  filePath: string,
  lastContent: string,
  options: WatchStepOptions,
): Promise<string> {
  const log = options.logFn ?? console.log;
  const notify = options.notifyFn ?? sendNotification;
  if (!existsSync(filePath)) {
    return lastContent;
  }
  const current = readFileSync(filePath, 'utf8');
  if (current !== lastContent) {
    const result = await handleScrub(current, options);
    // Watch mode only handles string content
    const scrubbed = typeof result.scrubbedContent === 'string' ? result.scrubbedContent : current;
    if (scrubbed !== current) {
      const msg = formatNotificationMessage(result.sessionMap);
      if (options.dryRun) {
        log(`[watch] (dry-run) Would have ${msg.toLowerCase()} in ${filePath}.`);
        return current;
      }
      if (options.backup) {
        const backupPath = `${filePath}.bak`;
        copyFileSync(filePath, backupPath);
        log(`[watch] Backed up ${filePath} to ${backupPath}.`);
      }
      writeFileSync(filePath, scrubbed, 'utf8');
      log(`[watch] ${msg} in ${filePath}.`);
      notify('prompt-scrub', `${msg} in ${filePath}`);
      return scrubbed;
    }
    return current;
  }
  return lastContent;
}

export async function handleWatch(
  options: WatchStepOptions & {
    clipboard?: boolean;
    file?: string | string[];
    interval?: string;
    once?: boolean;
    onStop?: () => void;
  },
) {
  if (!options.clipboard && !options.file) {
    throw new Error('Must specify --clipboard or --file <file>');
  }

  const log = options.logFn ?? console.log;
  const intervalMs = Number.parseInt(options.interval || '1000', 10) || 1000;

  // Resolved up front: a watch that only reports a bad locale once the first
  // change lands would run for minutes looking like it was working.
  const locale = resolveLocale(options.locale, loadConfig().locale);
  if (locale) {
    const { detectors } = await loadConfiguredRulePacks();
    warnIfLocaleUnused(locale, detectors);
  }

  // Only preflight the real clipboard path; injected mocks need no external tool.
  if (options.clipboard && !options.readClipboardFn) {
    assertClipboardSupport();
  }

  const readFn = options.readClipboardFn ?? readClipboard;
  let lastClip = options.clipboard ? readFn() : '';

  const files = options.file ? (Array.isArray(options.file) ? options.file : [options.file]) : [];

  const lastFileContents: Record<string, string> = {};

  if (options.dryRun) {
    log('[watch] Dry-run mode: no clipboard or file content will be written.');
  }

  const tick = async () => {
    if (options.clipboard) {
      lastClip = await watchClipboardStep(lastClip, options);
    }
    for (const f of files) {
      lastFileContents[f] = await watchFileStep(f, lastFileContents[f] ?? '', options);
    }
  };

  await tick();

  if (options.once) {
    return;
  }

  const timer = setInterval(() => {
    tick().catch(() => {});
  }, intervalMs);

  // Ctrl-C must stop the poll loop and exit cleanly rather than leaving the
  // interval pending. `onStop` lets tests observe this without exiting.
  const stop = () => {
    clearInterval(timer);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    log('[watch] Stopped watching.');
    if (options.onStop) {
      options.onStop();
      return;
    }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  return timer;
}

export function setupWatchCommand(program: Command) {
  program
    .command('watch')
    .description('Monitor system clipboard or specific files and automatically scrub content')
    .option('-c, --clipboard', 'Monitor system clipboard')
    .option('-f, --file <files...>', 'File(s) to monitor')
    .option('-i, --interval <ms>', 'Polling interval in milliseconds', '1000')
    .option('--once', 'Run a single check pass and exit')
    .option('--dry-run', 'Report what would be scrubbed without writing any changes')
    .option('--backup', 'Write <file>.bak before overwriting a watched file')
    .option('--session-id <id>', 'Resume or target a specific session')
    .option('--disable <detectors>', 'Comma-separated list of detector names to skip')
    .option('--enable <detectors>', 'Comma-separated list of off-by-default detectors to enable')
    .option('--strict-name', 'Enable strict allowlisting for NameDetector')
    .option('--code-tell-terms <terms>', 'Comma-separated list of private terms to detect')
    .option('--url-allowlist <hosts>', 'Comma-separated list of hostnames to pass-through')
    .option(
      '--locale <locale>',
      'BCP-47 locale (e.g. de-DE) enabling detectors scoped to that locale',
    )
    .action(async (options) => {
      try {
        await handleWatch(options);
      } catch (err: unknown) {
        console.error((err as Error).message);
        process.exit(1);
      }
    });
}
