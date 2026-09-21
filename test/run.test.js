'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { run, explain, BUILD_ID_ENV } = require('../src/run');
const { normaliseBaseUrl } = require('../src/api');
const realCore = require('../src/core');

// A real server rather than a stubbed fetch: the parts most likely to break are the wire
// details — the auth header, the Idempotency-Key header, the exact request body the
// deploy-token pin accepts — and a hand-rolled mock would happily agree with a wrong
// implementation.
function server(handler, t) {
  const requests = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null };
      requests.push(entry);
      handler(entry, res, requests.length);
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const close = () => new Promise((r) => srv.close(r));
      // Registered as teardown, not left to a trailing await: an assertion that throws
      // mid-test would skip that await, leave the socket listening, and hang the runner
      // instead of reporting the failure.
      if (t) t.after(close);
      resolve({ url: `http://127.0.0.1:${srv.address().port}`, requests, close });
    });
  });
}

// Argument order puts the test context first so every call site reads srv(t, handler)
// and cannot forget the teardown registration.
const srv = (t, handler) => server(handler, t);

const ok = (res, data, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ success: true, message: 'ok', data }));
};
const fail = (res, status, code, message, details) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ success: false, message, error: { code, details, requestId: 'req-1' } }));
};

// Captures what the action reported, so assertions can be about the user-visible outcome
// rather than about internal calls.
//
// Input PARSING delegates to the real core rather than being reimplemented here. A
// hand-written parser in the fake is how the poll-interval minimum went untested: the fake
// happily accepted 0.05 while the real action rejected it, so every flow test ran against
// inputs production would refuse.
function fakeCore(t, inputs) {
  const out = { outputs: {}, env: {}, errors: [], warnings: [], notices: [], info: [], summaries: [] };
  const previous = {};
  for (const [k, v] of Object.entries(inputs)) {
    const key = `INPUT_${k.replace(/ /g, '_').toUpperCase()}`;
    previous[key] = process.env[key];
    process.env[key] = String(v);
  }
  if (t) {
    t.after(() => {
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    });
  }
  return {
    InputError: realCore.InputError,
    getInput: realCore.getInput,
    getBool: realCore.getBool,
    getNumber: realCore.getNumber,
    mask() {},
    info: (m) => out.info.push(m),
    notice: (m) => out.notices.push(m),
    warning: (m) => out.warnings.push(m),
    error: (m) => out.errors.push(m),
    setOutput: (k, v) => { out.outputs[k] = v; },
    exportVariable: (k, v) => { out.env[k] = v; process.env[k] = v; },
    summary: (m) => out.summaries.push(m),
    out,
  };
}

const baseInputs = (url, extra = {}) => ({
  'api-url': url,
  'function-id': 'fn-1',
  token: 'deploy-token-value',
  'poll-interval-seconds': '1',
  ...extra,
});

test.beforeEach(() => { delete process.env[BUILD_ID_ENV]; });

test('a successful build exits 0 and reports the image', async (t) => {
  const s = await srv(t, (req, res, n) => {
    if (req.method === 'POST') return ok(res, { id: 'b1', status: 'queued' }, 202);
    return ok(res, n < 3
      ? { id: 'b1', status: 'running' }
      : { id: 'b1', status: 'succeeded', image: { reference: 'reg/img:tag', digest: 'sha256:abc' } });
  });
  const core = fakeCore(t, baseInputs(s.url, { ref: 'main', 'idempotency-key': 'sha-1' }));
  const code = await run(core);

  assert.equal(code, 0);
  assert.equal(core.out.outputs['build-id'], 'b1');
  assert.equal(core.out.outputs.status, 'succeeded');
  assert.equal(core.out.outputs['image-reference'], 'reg/img:tag');
  assert.deepEqual(core.out.errors, []);
});

test('the start request sends exactly what a deploy token is allowed to send', async (t) => {
  const s = await srv(t, (req, res) => {
    if (req.method === 'POST') return ok(res, { id: 'b1', status: 'queued' }, 202);
    return ok(res, { id: 'b1', status: 'succeeded' });
  });
  const core = fakeCore(t, baseInputs(s.url, { ref: 'main', 'idempotency-key': 'sha-1-1' }));
  await run(core);

  const start = s.requests[0];
  assert.equal(start.url, '/api/functions/fn-1/builds');
  assert.equal(start.headers.authorization, 'Bearer deploy-token-value');
  assert.equal(start.headers['idempotency-key'], 'sha-1-1');
  assert.deepEqual(start.body, { source: { type: 'github', ref: 'main' } });
  // Runtime is inherited from the previous build; a token that could pick one could
  // change what gets built, and the server rejects it outright.
  assert.ok(!('runtime' in start.body), 'must not send a runtime');
});

test('a failed build exits 1 and surfaces the build error', async (t) => {
  const s = await srv(t, (req, res) => {
    if (req.method === 'POST') return ok(res, { id: 'b1', status: 'queued' }, 202);
    return ok(res, { id: 'b1', status: 'failed', error: { code: 'BUILD_FAILED', message: 'compile error on line 3' } });
  });
  const core = fakeCore(t, baseInputs(s.url));
  const code = await run(core);

  assert.equal(code, 1);
  assert.match(core.out.errors.join('\n'), /compile error on line 3/);
});

test('a superseded build is not a failure', async (t) => {
  // A newer commit won the race. Painting this run red would report a correct outcome as
  // a broken one, and push-to-deploy makes it a routine occurrence.
  const s = await srv(t, (req, res) => {
    if (req.method === 'POST') return ok(res, { id: 'b1', status: 'queued' }, 202);
    return ok(res, { id: 'b1', status: 'superseded' });
  });
  const core = fakeCore(t, baseInputs(s.url));
  const code = await run(core);

  assert.equal(code, 0);
  assert.deepEqual(core.out.errors, []);
  assert.match(core.out.notices.join('\n'), /newer commit/i);
});

test('a deleted function warns and exits 0 instead of failing forever', async (t) => {
  const s = await srv(t, (req, res) => fail(res, 404, 'NOT_FOUND', 'function not found'));
  const core = fakeCore(t, baseInputs(s.url));
  const code = await run(core);

  assert.equal(code, 0);
  assert.match(core.out.warnings.join('\n'), /no longer exists/);
});

test('a rejected token fails loudly and is never treated as orphaned', async (t) => {
  // The dangerous inverse of the test above: if a revoked or stale token exited 0, every
  // push would report success while nothing was ever built.
  for (const status of [401, 403]) {
    const s = await srv(t, (req, res) => fail(res, status, 'UNAUTHORIZED', 'invalid deploy token'));
    const core = fakeCore(t, baseInputs(s.url));
    const code = await run(core);

    assert.equal(code, 1, `HTTP ${status} must fail the job`);
    // Assert on OUR guidance, not on wording the server also emits: the API's own message
    // is "invalid deploy token", so matching /deploy token/ would pass even with the
    // 401 branch deleted. This text exists nowhere but that branch.
    assert.match(core.out.errors.join('\n'), /Re-enable auto-deploy/);
    assert.equal(core.out.warnings.length, 0, 'must not report an orphaned workflow');
  }
});

test('a ref mismatch explains the branch problem rather than echoing a code', async (t) => {
  const s = await srv(t, (req, res) =>
    fail(res, 422, 'REF_NOT_IN_CONNECTED_REPO', 'ref is not in the connected repository'));
  const core = fakeCore(t, baseInputs(s.url, { ref: 'feature/x' }));
  const code = await run(core);

  assert.equal(code, 1);
  assert.match(core.out.errors.join('\n'), /branch/i);
});

test('rate limiting fails fast without retrying', async (t) => {
  let calls = 0;
  const s = await srv(t, (req, res) => {
    calls++;
    fail(res, 429, 'BUILD_RATE_LIMITED', 'too many builds', { limit: 20, window: '1h' });
  });
  const core = fakeCore(t, baseInputs(s.url));
  const code = await run(core);

  assert.equal(code, 1);
  assert.equal(calls, 1, 'a rate limit must not be retried — it would burn runner minutes for the same answer');
  assert.match(core.out.errors.join('\n'), /limit 20 per 1h/);
});

test('transient 5xx is retried and then succeeds', async (t) => {
  let calls = 0;
  const s = await srv(t, (req, res) => {
    calls++;
    if (req.method === 'POST' && calls === 1) { res.writeHead(503); return res.end(); }
    if (req.method === 'POST') return ok(res, { id: 'b1', status: 'queued' }, 202);
    return ok(res, { id: 'b1', status: 'succeeded' });
  });
  const core = fakeCore(t, baseInputs(s.url));
  const code = await run(core);

  assert.equal(code, 0);
  assert.ok(calls >= 3, 'the 503 should have been retried');
});

test('wait:false returns as soon as the build is accepted', async (t) => {
  const s = await srv(t, (req, res) => ok(res, { id: 'b1', status: 'queued' }, 202));
  const core = fakeCore(t, baseInputs(s.url, { wait: 'false' }));
  const code = await run(core);

  assert.equal(code, 0);
  assert.equal(s.requests.length, 1, 'must not poll when wait is false');
  assert.equal(core.out.outputs.status, 'queued');
});

test('the build id reaches the cancel step, which then cancels it', async (t) => {
  const s = await srv(t, (req, res) => {
    if (req.url.endsWith('/cancel')) return ok(res, { id: 'b1', status: 'cancelled' });
    if (req.method === 'POST') return ok(res, { id: 'b1', status: 'queued' }, 202);
    return ok(res, { id: 'b1', status: 'succeeded' });
  });
  const deployCore = fakeCore(t, baseInputs(s.url));
  await run(deployCore);
  assert.equal(deployCore.out.env[BUILD_ID_ENV], 'b1', 'the deploy step must export the build id');

  const cancelCore = fakeCore(t, baseInputs(s.url, { cancel: 'true' }));
  const code = await run(cancelCore);

  assert.equal(code, 0);
  assert.ok(s.requests.some((r) => r.url === '/api/functions/fn-1/builds/b1/cancel'),
    'cancel mode must call the cancel endpoint for the exported build id');
});

test('cancellation never fails the job, even when the cancel call fails', async (t) => {
  // The run is already being torn down; a red X here would misreport a cancellation as a
  // build failure.
  process.env[BUILD_ID_ENV] = 'b1';
  const s = await srv(t, (req, res) => fail(res, 500, 'INTERNAL_ERROR', 'boom'));
  const core = fakeCore(t, baseInputs(s.url, { cancel: 'true' }));
  const code = await run(core);

  assert.equal(code, 0);
  assert.equal(core.out.errors.length, 0);
  assert.match(core.out.warnings.join('\n'), /Could not cancel/);
});

test('cancelling before a build id exists warns rather than failing', async (t) => {
  const s = await srv(t, (req, res) => ok(res, { id: 'b1', status: 'cancelled' }));
  const core = fakeCore(t, baseInputs(s.url, { cancel: 'true' }));
  const code = await run(core);

  assert.equal(code, 0);
  assert.equal(s.requests.length, 0);
  assert.match(core.out.warnings.join('\n'), /before a Tower build id was known/);
});

test('an empty api-url names the missing secret', async (t) => {
  // The most likely real misconfiguration once the URL moved into TOWER_API_URL: the
  // secret is absent, so the input arrives empty and the error must say so.
  const core = fakeCore(t, { 'api-url': '', 'function-id': 'fn-1', token: 't' });
  const code = await run(core);
  assert.equal(code, 1);
  assert.match(core.out.errors.join('\n'), /api-url/);
});

test('a plaintext http endpoint is refused, but localhost is allowed', () => {
  assert.throws(() => normaliseBaseUrl('http://api.example.com'), /https/);
  assert.equal(normaliseBaseUrl('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(normaliseBaseUrl('https://api.example.com/'), 'https://api.example.com');
});

test('timing out stops waiting without cancelling the build', async (t) => {
  // The build is still legitimately running on Tower; cancelling it because we stopped
  // watching would destroy work the tenant is still paying for.
  const s = await srv(t, (req, res) => {
    if (req.method === 'POST') return ok(res, { id: 'b1', status: 'queued' }, 202);
    return ok(res, { id: 'b1', status: 'running' });
  });
  const core = fakeCore(t, baseInputs(s.url, { 'timeout-seconds': '1' }));
  const code = await run(core);

  assert.equal(code, 1);
  assert.ok(!s.requests.some((r) => r.url.endsWith('/cancel')), 'a watch timeout must not cancel the build');
  assert.match(core.out.errors.join('\n'), /still running on Tower/);
});

test('explain covers the codes a tenant can actually act on', () => {
  assert.ok(explain({ code: 'REF_NOT_IN_CONNECTED_REPO' }));
  assert.ok(explain({ code: 'BUILD_RATE_LIMITED', details: {} }));
  assert.equal(explain({ code: 'SOMETHING_NEW' }), null, 'unknown codes fall through to the raw message');
});
