import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface PromptScrubConfig {
  rulePacks?: string[];
  urlAllowlist?: string[];
}

/**
 * Determines the base configuration directory based on the OS.
 *
 * An explicit override via the `PROMPT_SCRUB_CONFIG_DIR` environment variable
 * always takes precedence. This is primarily intended for tests, but it also
 * lets users relocate the storage directory on any platform.
 */
export function getConfigDir(): string {
  const override = process.env.PROMPT_SCRUB_CONFIG_DIR;
  if (override && override.length > 0) {
    return override;
  }

  const platform = process.env.MOCK_PLATFORM || os.platform();
  const homedir = os.homedir();

  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Application Support', 'prompt-scrub');
  } else if (platform === 'win32') {
    return path.join(
      process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming'),
      'prompt-scrub',
    );
  } else {
    // Linux and others
    return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir, '.config'), 'prompt-scrub');
  }
}

/**
 * Reads configuration from ~/.config/prompt-scrub/config.json and local package.json,
 * merging the rulePacks arrays.
 */
export function loadConfig(): PromptScrubConfig {
  const config: PromptScrubConfig = {
    rulePacks: [],
    urlAllowlist: [],
  };

  const rulePacks = new Set<string>();
  const urlAllowlist = new Set<string>();

  // 1. Read global config
  const globalConfigPath = path.join(getConfigDir(), 'config.json');
  if (fs.existsSync(globalConfigPath)) {
    try {
      const globalData = JSON.parse(fs.readFileSync(globalConfigPath, 'utf8'));
      if (Array.isArray(globalData?.rulePacks)) {
        for (const pack of globalData.rulePacks) {
          if (typeof pack === 'string') rulePacks.add(pack);
        }
      }
      if (Array.isArray(globalData?.urlAllowlist)) {
        for (const host of globalData.urlAllowlist) {
          if (typeof host === 'string') urlAllowlist.add(host);
        }
      }
    } catch (_e) {
      // Ignore global config read/parse errors
    }
  }



  config.rulePacks = Array.from(rulePacks);
  config.urlAllowlist = Array.from(urlAllowlist);
  return config;
}
