'use strict';

// The Tower builds API as this action sees it: three endpoints, reachable with a deploy
// token. Kept free of Actions specifics so it can be tested against a local server.

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'superseded']);

// Statuses that mean "this build did not produce a deploy, but nothing is wrong".
// A superseded build was retired because a newer commit won the race; a cancelled one was
// stopped deliberately. Failing the job for either would paint a red X on a run whose
// outcome was correct.
const NEUTRAL = new Set(['cancelled', 'superseded']);

class ApiError extends Error {
  constructor(message, { status, code, reason, details, requestId } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.reason = reason;
    this.details = details;
    this.requestId = requestId;
  }
}

// The function is gone. Its workflow is orphaned and every future push would fail, so this
// is reported distinctly from an auth failure.
class FunctionGoneError extends ApiError {}

function normaliseBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `api-url is not a valid URL: "${raw}". It comes from the TOWER_API_URL repository ` +
      `secret — if that secret is missing, this input arrives empty.`
    );
  }
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !isLocal) {
    throw new Error(`api-url must use https (got "${url.protocol}//"). The deploy token is sent on this connection.`);
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class TowerClient {
  constructor({ baseUrl, token, functionId, fetchImpl = globalThis.fetch, onRetry = () => {} }) {
    this.baseUrl = normaliseBaseUrl(baseUrl);
    this.token = token;
    this.functionId = functionId;
    this.fetch = fetchImpl;
    this.onRetry = onRetry;
  }

  async request(method, path, { body, headers = {}, retries = 3, timeoutMs = 30000 } = {}) {
    let attempt = 0;
    for (;;) {
      attempt++;
      let res;
      let transportError;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        res = await this.fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            accept: 'application/json',
            'user-agent': 'tower-function-deploy-action',
            ...(body ? { 'content-type': 'application/json' } : {}),
            ...headers,
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
      } catch (e) {
        transportError = e;
      } finally {
        clearTimeout(timer);
      }

      // Retry only what is genuinely transient. A 4xx is the caller's fault and retrying
      // it burns runner minutes to produce the same answer — 429 included, which carries
      // its own window and would only be re-rejected.
      const retryable = transportError || (res && res.status >= 500);
      if (retryable && attempt <= retries) {
        const backoff = Math.min(1000 * 2 ** (attempt - 1), 8000);
        this.onRetry({ attempt, backoff, status: res?.status, error: transportError?.message });
        await sleep(backoff);
        continue;
      }
      if (transportError) {
        throw new Error(`could not reach Tower at ${this.baseUrl}: ${transportError.message}`);
      }

      const text = await res.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }

      if (res.ok) return payload?.data ?? payload;

      const code = payload?.error?.code;
      const message = payload?.message || `HTTP ${res.status}`;
      // Tower's auth middlewares leave error.code as the blunt UNAUTHORIZED/FORBIDDEN and
      // put the specific cause in error.details.reason. Reading only the code would make
      // every auth failure look identical, which is the difference between "this function
      // was deleted, stop failing" and "your secret is stale, keep failing".
      const meta = {
        status: res.status,
        code,
        reason: payload?.error?.details?.reason,
        details: payload?.error?.details,
        requestId: payload?.error?.requestId,
      };
      if (res.status === 404) throw new FunctionGoneError(message, meta);
      throw new ApiError(message, meta);
    }
  }

  // A deploy token may build only the function's declared source: github type, bound
  // repository, bound ref, bound path. Runtime is inherited from the previous build and
  // must NOT be sent — a token that could choose a runtime could change what gets built.
  startBuild({ ref, commit, idempotencyKey }) {
    return this.request('POST', `/api/functions/${encodeURIComponent(this.functionId)}/builds`, {
      body: { source: { type: 'github', ...(ref ? { ref } : {}), ...(commit ? { commit } : {}) } },
      headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
    });
  }

  getBuild(buildId) {
    return this.request(
      'GET',
      `/api/functions/${encodeURIComponent(this.functionId)}/builds/${encodeURIComponent(buildId)}`,
      { retries: 5 } // polling tolerates more transient failure than a mutation does
    );
  }

  cancelBuild(buildId) {
    return this.request(
      'POST',
      `/api/functions/${encodeURIComponent(this.functionId)}/builds/${encodeURIComponent(buildId)}/cancel`,
      { retries: 2, timeoutMs: 15000 } // the runner is already being torn down
    );
  }
}

module.exports = { TowerClient, ApiError, FunctionGoneError, TERMINAL, NEUTRAL, normaliseBaseUrl, sleep };
