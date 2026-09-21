'use strict';

// Minimal replacements for @actions/core. Deliberately dependency-free: this action is
// committed into tenant repositories and may be pinned to a commit and audited, so it
// runs straight from source with no bundling step and no node_modules to vendor.

const fs = require('fs');
const os = require('os');

// GitHub uppercases the input name and replaces spaces with underscores; hyphens are
// kept. So `api-url` arrives as INPUT_API-URL.
function getInput(name, { required = false } = {}) {
  const raw = process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '';
  const value = raw.trim();
  if (required && !value) {
    throw new InputError(`Input "${name}" is required but was empty.`);
  }
  return value;
}

function getBool(name, fallback) {
  const v = getInput(name).toLowerCase();
  if (v === '') return fallback;
  if (['true', 'yes', '1'].includes(v)) return true;
  if (['false', 'no', '0'].includes(v)) return false;
  throw new InputError(`Input "${name}" must be true or false, got "${v}".`);
}

function getNumber(name, fallback, { min = 1 } = {}) {
  const v = getInput(name);
  if (v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) {
    throw new InputError(`Input "${name}" must be a number >= ${min}, got "${v}".`);
  }
  return n;
}

// A workflow command argument must not contain a raw newline or it truncates the command
// and the remainder is printed as log text.
function escapeData(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function issue(command, message) {
  process.stdout.write(`::${command}::${escapeData(message)}${os.EOL}`);
}

const info = (m) => process.stdout.write(`${m}${os.EOL}`);
const notice = (m) => issue('notice', m);
const warning = (m) => issue('warning', m);
const error = (m) => issue('error', m);
const mask = (v) => { if (v) issue('add-mask', v); };
const startGroup = (m) => issue('group', m);
const endGroup = () => process.stdout.write(`::endgroup::${os.EOL}`);

// Values may contain newlines (an error message can), so the file commands need the
// heredoc form with a delimiter the value cannot contain.
function writeKeyValue(file, key, value) {
  const path = process.env[file];
  if (!path) return; // not running under Actions (tests, local runs)
  const delimiter = `ghadelim_${Math.random().toString(36).slice(2)}`;
  const body = String(value);
  if (body.includes(delimiter)) throw new Error('generated delimiter collided with value');
  fs.appendFileSync(path, `${key}<<${delimiter}${os.EOL}${body}${os.EOL}${delimiter}${os.EOL}`);
}

const setOutput = (k, v) => writeKeyValue('GITHUB_OUTPUT', k, v);
const exportVariable = (k, v) => { process.env[k] = String(v); writeKeyValue('GITHUB_ENV', k, v); };

function summary(markdown) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  try {
    fs.appendFileSync(path, markdown + os.EOL);
  } catch {
    // A missing summary file must never be the reason a deploy reports failure.
  }
}

// Thrown for bad inputs — distinguished from API failures so the message can tell the
// user to fix their workflow rather than look at Tower.
class InputError extends Error {}

module.exports = {
  getInput, getBool, getNumber, info, notice, warning, error, mask,
  startGroup, endGroup, setOutput, exportVariable, summary, escapeData, InputError,
};
