import test from 'ava';
import { ProxyMetrics } from '../../src/proxy/metrics.js';
import type { ProxyEvent } from '../../src/proxy/types.js';

type ResponseEvent = Extract<ProxyEvent, { type: 'response' }>;

const request: ProxyEvent = {
  type: 'request',
  method: 'POST',
  path: '/v1/chat/completions',
  provider: 'openai',
  sessionId: 's',
};

function response(overrides: Partial<ResponseEvent> = {}): ResponseEvent {
  return {
    type: 'response',
    requestId: 'r',
    sessionId: 's',
    method: 'POST',
    path: '/v1/chat/completions',
    provider: 'openai',
    status: 200,
    durationMs: 12,
    streaming: false,
    outcome: 'ok',
    entities: 0,
    byCategory: {},
    suppressed: 0,
    suppressedByCategory: {},
    rehydrated: 0,
    ...overrides,
  };
}

test('counts requests, redactions by category and rehydrations', (t) => {
  const metrics = new ProxyMetrics('1.2.3');
  metrics.observe(request);
  metrics.observe(response({ entities: 3, byCategory: { Email: 2, Phone: 1 }, rehydrated: 1 }));

  const text = metrics.renderPrometheus();
  t.regex(text, /prompt_scrub_requests_total\{provider="openai",status_class="2xx"\} 1/);
  t.regex(text, /prompt_scrub_entities_redacted_total\{category="Email"\} 2/);
  t.regex(text, /prompt_scrub_entities_redacted_total\{category="Phone"\} 1/);
  t.regex(text, /prompt_scrub_placeholders_rehydrated_total 1/);
  t.regex(text, /prompt_scrub_inflight_requests 0/);
  t.regex(text, /prompt_scrub_build_info\{version="1.2.3"\} 1/);
});

test('inflight gauge tracks requests that have not responded yet', (t) => {
  const metrics = new ProxyMetrics('x');
  metrics.observe(request);
  metrics.observe(request);
  t.regex(metrics.renderPrometheus(), /prompt_scrub_inflight_requests 2/);
  metrics.observe(response());
  t.regex(metrics.renderPrometheus(), /prompt_scrub_inflight_requests 1/);
});

test('latency histogram buckets are cumulative', (t) => {
  const metrics = new ProxyMetrics('x');
  // 12ms falls in the 0.025s bucket and every bucket above it.
  metrics.observe(response({ durationMs: 12 }));
  const text = metrics.renderPrometheus();
  t.regex(text, /prompt_scrub_request_duration_seconds_bucket\{le="0.01"\} 0\n/);
  t.regex(text, /prompt_scrub_request_duration_seconds_bucket\{le="0.025"\} 1\n/);
  t.regex(text, /prompt_scrub_request_duration_seconds_bucket\{le="\+Inf"\} 1\n/);
  t.regex(text, /prompt_scrub_request_duration_seconds_count 1\n/);
});

test('findings left unredacted below minConfidence are counted by category', (t) => {
  const metrics = new ProxyMetrics('x');
  metrics.observe(response({ suppressed: 3, suppressedByCategory: { Url: 2, Phone: 1 } }));
  metrics.observe(response({ suppressed: 1, suppressedByCategory: { Url: 1 } }));
  metrics.observe(response());

  const text = metrics.renderPrometheus();
  t.regex(text, /prompt_scrub_suppressed_total\{category="Url"\} 3\n/);
  t.regex(text, /prompt_scrub_suppressed_total\{category="Phone"\} 1\n/);
});

test('errors and passthrough are counted by kind and reason', (t) => {
  const metrics = new ProxyMetrics('x');
  metrics.observe({ type: 'passthrough', reason: 'unknown provider' });
  metrics.observe(response({ status: 502, outcome: 'error', errorKind: 'upstream_timeout' }));

  const text = metrics.renderPrometheus();
  t.regex(text, /prompt_scrub_passthrough_total\{reason="unknown provider"\} 1/);
  t.regex(text, /prompt_scrub_errors_total\{kind="upstream_timeout"\} 1/);
  t.regex(text, /prompt_scrub_requests_total\{provider="openai",status_class="5xx"\} 1/);
});

test('blocked requests are counted by reason', (t) => {
  const metrics = new ProxyMetrics('x');
  metrics.observe({ type: 'blocked', reason: 'unknown provider' });
  metrics.observe({ type: 'blocked', reason: 'unknown provider' });
  metrics.observe({ type: 'blocked', reason: 'compressed body' });

  const text = metrics.renderPrometheus();
  t.regex(text, /prompt_scrub_blocked_total\{reason="unknown provider"\} 2/);
  t.regex(text, /prompt_scrub_blocked_total\{reason="compressed body"\} 1/);
  t.deepEqual(
    (metrics.toJSON().blocked as { labels: Record<string, string>; value: number }[]).map(
      (s) => s.value,
    ),
    [1, 2],
  );
});

test('label values are escaped in the Prometheus output', (t) => {
  const metrics = new ProxyMetrics('x');
  metrics.observe(response({ entities: 1, byCategory: { 'a"b\\c': 1 } }));
  t.true(metrics.renderPrometheus().includes('category="a\\"b\\\\c"'));
});

test('audit drops are counted and start at zero', (t) => {
  const metrics = new ProxyMetrics('x');
  t.regex(metrics.renderPrometheus(), /prompt_scrub_audit_dropped_total 0\n/);
  metrics.recordAuditDropped();
  t.regex(metrics.renderPrometheus(), /prompt_scrub_audit_dropped_total 1\n/);
});

test('toJSON mirrors the counters', (t) => {
  const metrics = new ProxyMetrics('9.9.9');
  metrics.observe(response({ byCategory: { Email: 1 }, entities: 1 }));
  const json = metrics.toJSON() as {
    version: string;
    requests: Array<{ labels: Record<string, string>; value: number }>;
    entitiesRedacted: Array<{ labels: Record<string, string>; value: number }>;
  };
  t.is(json.version, '9.9.9');
  t.deepEqual(json.requests, [{ labels: { provider: 'openai', status_class: '2xx' }, value: 1 }]);
  t.deepEqual(json.entitiesRedacted, [{ labels: { category: 'Email' }, value: 1 }]);
});
