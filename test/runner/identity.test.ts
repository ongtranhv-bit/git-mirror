import test from 'node:test';
import assert from 'node:assert/strict';
import { identityFromAzure, identityFromGithub, resolveRunnerIdentity } from '../../src/runner/identity.js';

test('github identity parses GITHUB_WORKFLOW_REF into owner/repo/workflow file', () => {
  const identity = identityFromGithub({
    GITHUB_ACTIONS: 'true',
    GITHUB_WORKFLOW_REF: 'ongtrieuhauphuchien29-oss/git-mirror/.github/workflows/git-mirror-worker.yml@refs/heads/main',
  });
  assert.deepEqual(identity, {
    provider: 'github',
    owner: 'ongtrieuhauphuchien29-oss',
    repo: 'git-mirror',
    workflowFile: 'git-mirror-worker.yml',
    key: 'github:ongtrieuhauphuchien29-oss/git-mirror:git-mirror-worker.yml',
    displayName: 'ongtrieuhauphuchien29-oss/git-mirror (git-mirror-worker.yml)',
  });
});

test('github identity falls back to GITHUB_REPOSITORY + GITHUB_WORKFLOW', () => {
  const identity = identityFromGithub({
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_WORKFLOW: 'Git Mirror Sync Worker',
  });
  assert.equal(identity?.key, 'github:owner/repo:Git Mirror Sync Worker');
});

test('github identity is null without repository info', () => {
  assert.equal(identityFromGithub({ GITHUB_ACTIONS: 'true' }), null);
});

test('azure identity uses RUNNER_WORKFLOW_FILE when present', () => {
  const identity = identityFromAzure({
    TF_BUILD: 'true',
    SYSTEM_TEAMPROJECT: 'RawFiles',
    BUILD_REPOSITORY_URI: 'https://dev.azure.com/org/RawFiles/_git/code-dh-hospital-all',
    RUNNER_WORKFLOW_FILE: 'azure-pipelines.yml',
  });
  assert.deepEqual(identity, {
    provider: 'azure',
    owner: 'RawFiles',
    repo: 'code-dh-hospital-all',
    workflowFile: 'azure-pipelines.yml',
    key: 'azure:RawFiles/RawFiles/code-dh-hospital-all:azure-pipelines.yml',
    displayName: 'RawFiles/RawFiles/code-dh-hospital-all (azure-pipelines.yml)',
  });
});

test('azure identity falls back to pipeline id when yml file is unknown', () => {
  const identity = identityFromAzure({
    TF_BUILD: 'true',
    SYSTEM_TEAMPROJECT: 'RawFiles',
    BUILD_REPOSITORY_URI: 'https://github.com/code-dh-hospital/code-dh-hospital-all',
    SYSTEM_PIPELINEID: '42',
  });
  assert.equal(identity?.key, 'azure:RawFiles/code-dh-hospital/code-dh-hospital-all:pipeline:42');
});

test('RUNNER_KEY overrides everything as manual identity', () => {
  const identity = resolveRunnerIdentity({
    env: {
      RUNNER_KEY: 'docker-prod-1',
      GITHUB_ACTIONS: 'true',
    },
  });
  assert.equal(identity?.provider, 'manual');
  assert.equal(identity?.key, 'manual:docker-prod-1');
});

test('registry disabled returns null even with CI env', () => {
  assert.equal(resolveRunnerIdentity({
    env: { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'o/r' },
    registryDisabled: true,
  }), null);
  assert.equal(resolveRunnerIdentity({ env: { RUNNER_REGISTRY_DISABLED: '1', GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'o/r' } }), null);
});

test('no CI context returns null', () => {
  assert.equal(resolveRunnerIdentity({ env: {} }), null);
});
