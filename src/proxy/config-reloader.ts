import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProxyEvent } from './types.js';

const CONFIG_FILE_NAME = 'config.json';
const WATCH_DEBOUNCE_MS = 250;

type ReloadTrigger = 'signal' | 'watch';

export interface ConfigReloaderOptions {
  /** Directory that holds `config.json`. */
  dir: string;
  /**
   * Re-read the configuration and apply it. Throws to reject the reload; the
   * previous configuration then stays in force.
   */
  apply: () => Promise<{ rulePacks: number; detectors: number; urlAllowlist: number }>;
  emit: (event: ProxyEvent) => void;
  log: (msg: string) => void;
}

export interface ConfigReloader {
  /** Whether a SIGHUP handler is registered (not on Windows). */
  signal: boolean;
  /** Whether the config directory is being watched. */
  watching: boolean;
  reload: (trigger: ReloadTrigger) => Promise<void>;
  close: () => void;
}

function hashConfigFile(file: string): string | undefined {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return undefined;
  }
}

/**
 * Applies changes to `config.json` while the proxy keeps running. Reloads
 * are triggered by SIGHUP and by writes to the config directory. Reloads run
 * one at a time, and a reload is skipped when the file content has not
 * changed since the last successful reload.
 */
export function createConfigReloader(options: ConfigReloaderOptions): ConfigReloader {
  const configFile = path.join(options.dir, CONFIG_FILE_NAME);
  let appliedHash = hashConfigFile(configFile);
  let chain: Promise<void> = Promise.resolve();
  let closed = false;
  let timer: NodeJS.Timeout | undefined;

  const run = async (trigger: ReloadTrigger): Promise<void> => {
    if (closed) return;
    const hash = hashConfigFile(configFile);
    if (hash === appliedHash) return;
    try {
      const summary = await options.apply();
      appliedHash = hash;
      options.emit({ type: 'config_reloaded', trigger, ...summary });
      options.log(
        `[proxy] Config reloaded (${trigger}): ${summary.rulePacks} rule pack(s), ` +
          `${summary.urlAllowlist} allowlist entr${summary.urlAllowlist === 1 ? 'y' : 'ies'}.`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      options.emit({ type: 'config_reload_failed', trigger, reason });
      options.log(`[proxy] Config reload failed (${trigger}): ${reason}`);
    }
  };

  const reload = (trigger: ReloadTrigger): Promise<void> => {
    chain = chain.then(() => run(trigger));
    return chain;
  };

  let watcher: fs.FSWatcher | undefined;
  if (fs.existsSync(options.dir)) {
    try {
      watcher = fs.watch(options.dir, { persistent: false }, (_event, name) => {
        if (name !== CONFIG_FILE_NAME) return;
        clearTimeout(timer);
        timer = setTimeout(() => void reload('watch'), WATCH_DEBOUNCE_MS);
        timer.unref();
      });
      watcher.on('error', (err) => {
        options.log(`[proxy] Config watcher stopped: ${err.message}`);
      });
    } catch (err) {
      options.log(`[proxy] Config watcher unavailable: ${(err as Error).message}`);
    }
  }

  const onSighup = () => void reload('signal');
  const signal = process.platform !== 'win32';
  if (signal) process.on('SIGHUP', onSighup);

  return {
    signal,
    watching: watcher !== undefined,
    reload,
    close: () => {
      closed = true;
      clearTimeout(timer);
      watcher?.close();
      if (signal) process.off('SIGHUP', onSighup);
    },
  };
}
