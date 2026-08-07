import test from 'node:test';
import assert from 'node:assert/strict';
import { isHelpRequest, parseCliArgs } from '../src/cli-args.js';

test('global --help and -h are recognized before any config load', () => {
  assert.equal(isHelpRequest(parseCliArgs(['--help'])), true);
  assert.equal(isHelpRequest(parseCliArgs(['-h'])), true);
  assert.equal(isHelpRequest(parseCliArgs(['run', '--help'])), true);
  assert.equal(isHelpRequest(parseCliArgs(['run'])), false);
});
