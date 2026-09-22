'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const yaml = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8');

// GitHub parses action.yml before running anything, and it evaluates ${{ }} EVERYWHERE in
// that file — including inside `description` text, where an expression is only prose to a
// human reader. An expression naming a context that action.yml does not allow (`secrets`
// is the obvious trap, since every input here comes from one) fails the whole action at
// job setup with "Unrecognized named-value", before a single line of index.js runs.
//
// This shipped once: a description reading "the workflow passes ${{ secrets.TOWER_API_URL }}"
// broke every consumer. No unit test caught it because nothing parsed this file.
test('action.yml contains no template expressions at all', () => {
  const found = yaml.match(/\$\{\{[^}]*\}\}/g) || [];
  assert.deepEqual(found, [],
    `action.yml must contain no \${{ }} expressions — GitHub evaluates them even in ` +
    `descriptions and rejects unknown contexts at job setup. Found: ${found.join(', ')}`);
});

test('every input the action reads is declared, and every declared input is read', () => {
  const declared = new Set();
  const inputsBlock = yaml.slice(yaml.indexOf('\ninputs:'), yaml.indexOf('\noutputs:'));
  for (const m of inputsBlock.matchAll(/^ {2}([a-z0-9-]+):$/gm)) declared.add(m[1]);

  const src = ['core.js', 'api.js', 'run.js']
    .map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')).join('\n');
  const read = new Set([...src.matchAll(/get(?:Input|Bool|Number)\('([a-z0-9-]+)'/g)].map((m) => m[1]));

  for (const name of read) {
    assert.ok(declared.has(name), `code reads input "${name}" but action.yml does not declare it`);
  }
  for (const name of declared) {
    assert.ok(read.has(name), `action.yml declares input "${name}" but no code reads it`);
  }
});

test('the declared runtime matches the entrypoint that exists', () => {
  assert.match(yaml, /using:\s*node20/, 'CI pins node 20; action.yml must declare it');
  const main = yaml.match(/main:\s*(\S+)/)[1];
  assert.ok(fs.existsSync(path.join(__dirname, '..', main)), `main: ${main} does not exist`);
});
