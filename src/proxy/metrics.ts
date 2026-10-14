import type { ProxyEvent } from './types.js';

/**
 * In-process counters and a latency histogram for the proxy's `/metrics`
 * endpoint. Rendered by hand in the Prometheus text format so the package
 * stays dependency-free.
 *
 * Label values come from fixed sets (provider, status class, passthrough
 * reason, error kind) or from detector categories. Paths, session IDs and
 * matched values are never used as labels: that would grow cardinality
 * without bound and leak data through the scrape endpoint.
 */

type Labels = Record<string, string>;

const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

interface Series {
  labels: Labels;
  value: number;
}

class CounterFamily {
  private readonly series = new Map<string, Series>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: Labels = {}, by = 1): void {
    const key = seriesKey(labels);
    const existing = this.series.get(key);
    if (existing) {
      existing.value += by;
    } else {
      this.series.set(key, { labels, value: by });
    }
  }

  snapshot(): Series[] {
    return sortedSeries(this.series);
  }
}

export class ProxyMetrics {
  private readonly startedAt = Date.now();
  private inflight = 0;

  private readonly requests = new CounterFamily(
    'prompt_scrub_requests_total',
    'Requests handled by the proxy, by provider and response status class.',
  );
  private readonly entities = new CounterFamily(
    'prompt_scrub_entities_redacted_total',
    'Values replaced by the scrubber, by detector category.',
  );
  private readonly rehydrated = new CounterFamily(
    'prompt_scrub_placeholders_rehydrated_total',
    'Placeholders restored in upstream responses. Streaming counts are approximate.',
  );
  private readonly passthrough = new CounterFamily(
    'prompt_scrub_passthrough_total',
    'Requests forwarded without scrubbing, by reason.',
  );
  private readonly errors = new CounterFamily(
    'prompt_scrub_errors_total',
    'Requests that ended in an error, by kind.',
  );
  private readonly auditDropped = new CounterFamily(
    'prompt_scrub_audit_dropped_total',
    'Audit records that could not be written.',
  );

  private readonly durationBuckets: number[] = DURATION_BUCKETS.map(() => 0);
  private durationSum = 0;
  private durationCount = 0;

  constructor(private readonly version: string) {
    // Emit label-free counters at zero so scrapers see them before the first event.
    this.auditDropped.inc({}, 0);
  }

  /** Update counters from a proxy event. Unknown or irrelevant events are ignored. */
  observe(event: ProxyEvent): void {
    switch (event.type) {
      case 'request':
        this.inflight += 1;
        return;
      case 'response':
        this.recordResponse(event);
        return;
      case 'passthrough':
        this.passthrough.inc({ reason: event.reason });
        return;
      default:
        return;
    }
  }

  recordAuditDropped(): void {
    this.auditDropped.inc();
  }

  uptimeSeconds(): number {
    return Math.round((Date.now() - this.startedAt) / 1000);
  }

  renderPrometheus(): string {
    const lines: string[] = [];
    for (const family of [
      this.requests,
      this.entities,
      this.rehydrated,
      this.passthrough,
      this.errors,
      this.auditDropped,
    ]) {
      lines.push(`# HELP ${family.name} ${family.help}`, `# TYPE ${family.name} counter`);
      for (const { labels, value } of family.snapshot()) {
        lines.push(`${family.name}${formatLabels(labels)} ${value}`);
      }
    }

    lines.push(
      '# HELP prompt_scrub_inflight_requests Requests currently being handled.',
      '# TYPE prompt_scrub_inflight_requests gauge',
      `prompt_scrub_inflight_requests ${this.inflight}`,
      '# HELP prompt_scrub_uptime_seconds Seconds since the proxy started.',
      '# TYPE prompt_scrub_uptime_seconds gauge',
      `prompt_scrub_uptime_seconds ${this.uptimeSeconds()}`,
      '# HELP prompt_scrub_build_info Build information. Always 1.',
      '# TYPE prompt_scrub_build_info gauge',
      `prompt_scrub_build_info${formatLabels({ version: this.version })} 1`,
    );

    const name = 'prompt_scrub_request_duration_seconds';
    lines.push(
      `# HELP ${name} Time from request receipt to response completion.`,
      `# TYPE ${name} histogram`,
    );
    let cumulative = 0;
    DURATION_BUCKETS.forEach((le, i) => {
      cumulative += this.durationBuckets[i] ?? 0;
      lines.push(`${name}_bucket{le="${le}"} ${cumulative}`);
    });
    lines.push(
      `${name}_bucket{le="+Inf"} ${this.durationCount}`,
      `${name}_sum ${this.durationSum}`,
      `${name}_count ${this.durationCount}`,
    );

    return `${lines.join('\n')}\n`;
  }

  toJSON(): Record<string, unknown> {
    let cumulative = 0;
    const buckets = DURATION_BUCKETS.map((le, i) => {
      cumulative += this.durationBuckets[i] ?? 0;
      return { le, count: cumulative };
    });
    return {
      version: this.version,
      uptimeSeconds: this.uptimeSeconds(),
      inflightRequests: this.inflight,
      requests: this.requests.snapshot(),
      entitiesRedacted: this.entities.snapshot(),
      placeholdersRehydrated: this.rehydrated.snapshot(),
      passthrough: this.passthrough.snapshot(),
      errors: this.errors.snapshot(),
      auditDropped: this.auditDropped.snapshot(),
      requestDurationSeconds: { count: this.durationCount, sum: this.durationSum, buckets },
    };
  }

  private recordResponse(event: Extract<ProxyEvent, { type: 'response' }>): void {
    this.inflight = Math.max(0, this.inflight - 1);
    this.requests.inc({
      provider: event.provider,
      status_class: `${Math.floor(event.status / 100)}xx`,
    });
    for (const [category, count] of Object.entries(event.byCategory)) {
      if (count > 0) this.entities.inc({ category }, count);
    }
    if (event.rehydrated > 0) this.rehydrated.inc({}, event.rehydrated);
    if (event.errorKind) this.errors.inc({ kind: event.errorKind });
    this.observeDuration(event.durationMs / 1000);
  }

  private observeDuration(seconds: number): void {
    this.durationSum += seconds;
    this.durationCount += 1;
    const index = DURATION_BUCKETS.findIndex((le) => seconds <= le);
    if (index !== -1) {
      this.durationBuckets[index] = (this.durationBuckets[index] ?? 0) + 1;
    }
  }
}

function seriesKey(labels: Labels): string {
  return JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
}

function sortedSeries(map: Map<string, Series>): Series[] {
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, series]) => series);
}

function formatLabels(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  const parts = keys.map((key) => `${key}="${escapeLabelValue(labels[key] ?? '')}"`);
  return `{${parts.join(',')}}`;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
