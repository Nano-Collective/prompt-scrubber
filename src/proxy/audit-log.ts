import * as fs from 'node:fs';
import * as path from 'node:path';

export interface AuditLogOptions {
  /** Logger for sink failures. Errors are reported once, then the sink is disabled. */
  log: (msg: string) => void;
  /** Called for each record that could not be written. */
  onDrop: () => void;
}

/**
 * Append-only JSON Lines sink for proxy request summaries.
 *
 * Records contain counts, categories, timings and the request path. They
 * never contain values, bodies, headers or query strings. The file is
 * created with mode 0600 inside a 0700 directory, matching the session store.
 */
export class AuditLog {
  private readonly stream: fs.WriteStream;
  private failed = false;
  private closing: Promise<void> | undefined;

  private constructor(
    private readonly options: AuditLogOptions,
    stream: fs.WriteStream,
  ) {
    this.stream = stream;
    this.stream.on('error', (err: Error) => {
      if (this.failed) return;
      this.failed = true;
      this.options.log(`[proxy] audit log disabled: ${err.message}`);
    });
  }

  /**
   * Open (or create) the audit file synchronously so a bad path is reported
   * before the proxy starts listening.
   */
  static open(filePath: string, options: AuditLogOptions): AuditLog {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(filePath, 'a', 0o600);
      return new AuditLog(options, fs.createWriteStream(filePath, { fd }));
    } catch (err) {
      throw new Error(`Cannot open audit log "${filePath}": ${(err as Error).message}`);
    }
  }

  write(record: Record<string, unknown>): void {
    if (this.failed || this.closing || this.stream.writableNeedDrain) {
      this.options.onDrop();
      return;
    }
    this.stream.write(`${JSON.stringify(record)}\n`);
  }

  /** Flush pending writes and close the file. Safe to call more than once. */
  close(): Promise<void> {
    this.closing ??= new Promise<void>((resolve) => {
      // A failed sink is already destroyed and may never emit `close` again.
      if (this.failed) return resolve();
      this.stream.once('close', () => resolve());
      this.stream.end(() => resolve());
    });
    return this.closing;
  }
}
