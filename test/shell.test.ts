import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSpawnEnv, resolveInlineShellCommand } from '../src/shell.js';

test('resolveInlineShellCommand prefers SHELL on POSIX by default', () => {
  const resolved = resolveInlineShellCommand({
    command: 'echo hello',
    env: { SHELL: '/bin/zsh' },
    platform: 'darwin',
  });

  assert.equal(resolved.command, '/bin/zsh');
  assert.deepEqual(resolved.argv, ['-f', '-c', 'setopt no_nomatch 2>/dev/null; echo hello']);
});

test('resolveInlineShellCommand falls back to /bin/sh when SHELL is missing', () => {
  const resolved = resolveInlineShellCommand({
    command: 'echo hello',
    env: {},
    platform: 'darwin',
  });

  assert.equal(resolved.command, '/bin/sh');
  assert.deepEqual(resolved.argv, ['-c', 'echo hello']);
});

test('resolveInlineShellCommand uses cmd on Windows', () => {
  const resolved = resolveInlineShellCommand({
    command: 'echo hello',
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    platform: 'win32',
  });

  assert.equal(resolved.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(resolved.argv, ['/d', '/s', '/c', 'echo hello']);
});

test('resolveInlineShellCommand respects powershell override', () => {
  const resolved = resolveInlineShellCommand({
    command: 'Write-Host hello',
    env: { LOBSTER_SHELL: 'pwsh' },
    platform: 'linux',
  });

  assert.equal(resolved.command, 'pwsh');
  assert.deepEqual(resolved.argv, ['-NoProfile', '-Command', 'Write-Host hello']);
});

test('resolveInlineShellCommand uses zsh without startup files', () => {
  const resolved = resolveInlineShellCommand({
    command: 'echo hello',
    env: { LOBSTER_SHELL: '/bin/zsh' },
    platform: 'darwin',
  });

  assert.equal(resolved.command, '/bin/zsh');
  assert.deepEqual(resolved.argv, ['-f', '-c', 'setopt no_nomatch 2>/dev/null; echo hello']);
});

test('resolveInlineShellCommand uses bash without profile files', () => {
  const resolved = resolveInlineShellCommand({
    command: 'echo hello',
    env: { LOBSTER_SHELL: '/bin/bash' },
    platform: 'darwin',
  });

  assert.equal(resolved.command, '/bin/bash');
  assert.deepEqual(resolved.argv, ['--noprofile', '--norc', '-c', 'echo hello']);
});

test('normalizeSpawnEnv puts the current node directory first on PATH', () => {
  const env = normalizeSpawnEnv({
    PATH: `/tmp/old-node/bin:/usr/bin:${process.execPath.replace(/\/[^/]+$/, '')}`,
  });
  const currentNodeDir = process.execPath.replace(/\/[^/]+$/, '');
  assert.equal(env.PATH?.startsWith(`${currentNodeDir}:`), true);
});
