import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDirectoriesDoNotOverlap, validateDestinationDirectory } from '../../src/shared/paths.js';

for (const unsafe of ['/absolute', '../escape', 'safe/../escape', 'C:/windows', '.git/config']) {
  test(`rejects unsafe directory ${unsafe}`, () => {
    assert.throws(() => validateDestinationDirectory(unsafe));
  });
}

test('rejects duplicate and nested directories', () => {
  assert.throws(() =>
    assertDirectoriesDoNotOverlap([
      { id: 'a', directory: 'apps/app' },
      { id: 'b', directory: 'apps/app/sub' },
    ]),
  );
});

test('accepts independent directories', () => {
  assert.doesNotThrow(() =>
    assertDirectoriesDoNotOverlap([
      { id: 'a', directory: 'apps/app' },
      { id: 'b', directory: 'packages/lib' },
    ]),
  );
});
