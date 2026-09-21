'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const core = require('../src/core');

function withEnv(vars, fn) {
  const previous = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test('input names map to the env vars GitHub actually sets', () => {
  // GitHub uppercases the name and replaces spaces, but KEEPS hyphens — so `api-url`
  // arrives as INPUT_API-URL, not INPUT_API_URL. Getting this wrong makes every input
  // silently empty.
  withEnv({ 'INPUT_API-URL': ' https://x.test ' }, () => {
    assert.equal(core.getInput('api-url'), 'https://x.test', 'value should be trimmed');
  });
});

test('a required input that is empty is an InputError, not a generic failure', () => {
  withEnv({ 'INPUT_TOKEN': '   ' }, () => {
    assert.throws(() => core.getInput('token', { required: true }), core.InputError);
  });
});

test('booleans accept the spellings people actually write', () => {
  const cases = { true: true, TRUE: true, yes: true, 1: true, false: false, FALSE: false, no: false, 0: false };
  for (const [raw, expected] of Object.entries(cases)) {
    withEnv({ INPUT_WAIT: raw }, () => assert.equal(core.getBool('wait', null), expected, `"${raw}"`));
  }
  withEnv({ INPUT_WAIT: '' }, () => assert.equal(core.getBool('wait', true), true, 'empty falls back'));
  withEnv({ INPUT_WAIT: 'maybe' }, () => assert.throws(() => core.getBool('wait', true), core.InputError));
});

test('numeric inputs reject values below their minimum', () => {
  // The poll interval guards the API: a sub-second interval would hammer it for the whole
  // build. This is the check the test fake used to skip, which is why it is pinned here.
  withEnv({ 'INPUT_POLL-INTERVAL-SECONDS': '0.05' }, () => {
    assert.throws(() => core.getNumber('poll-interval-seconds', 5), core.InputError);
  });
  withEnv({ 'INPUT_POLL-INTERVAL-SECONDS': 'soon' }, () => {
    assert.throws(() => core.getNumber('poll-interval-seconds', 5), core.InputError);
  });
  withEnv({ 'INPUT_POLL-INTERVAL-SECONDS': '' }, () => {
    assert.equal(core.getNumber('poll-interval-seconds', 5), 5);
  });
});

test('workflow command arguments cannot be broken by a newline', () => {
  // An unescaped newline truncates the ::error:: command and prints the rest as plain log
  // text — a multi-line build failure would lose everything after its first line.
  assert.equal(core.escapeData('a\nb'), 'a%0Ab');
  assert.equal(core.escapeData('100%'), '100%25');
});

test('outputs survive values containing newlines', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'twr-')), 'out');
  fs.writeFileSync(file, '');
  withEnv({ GITHUB_OUTPUT: file }, () => core.setOutput('status', 'line1\nline2'));
  const written = fs.readFileSync(file, 'utf8');
  assert.match(written, /^status<<ghadelim_/m);
  assert.match(written, /line1\nline2/);
});

test('missing Actions files are tolerated so local runs do not crash', () => {
  withEnv({ GITHUB_OUTPUT: undefined, GITHUB_ENV: undefined, GITHUB_STEP_SUMMARY: undefined }, () => {
    assert.doesNotThrow(() => { core.setOutput('a', 'b'); core.exportVariable('c', 'd'); core.summary('# x'); });
  });
});
