import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ciDirectory = path.dirname(fileURLToPath(import.meta.url));
const nodeGuard = path.join(ciDirectory, 'node-network-guard.cjs');
const pythonGuard = path.join(ciDirectory, 'python');

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe', ...options });
}

function failed(command, args, options = {}) {
  try {
    run(command, args, options);
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  assert.fail(`${command} unexpectedly succeeded`);
}

test('Node guard permits every configured loopback fetch host', () => {
  run(process.execPath, [
    '--require',
    nodeGuard,
    '-e',
    "Promise.all(['localhost','127.0.0.1','0.0.0.0','[::1]'].map((host) => fetch(`http://${host}:3000`).catch(() => {})))",
  ]);
});

test('Node guard blocks public fetches before dispatch', () => {
  const output = failed(process.execPath, ['--require', nodeGuard, '-e', "fetch('https://api.stripe.com')"]);
  assert.match(output, /ERR_CI_NETWORK_BLOCKED/);
  assert.match(output, /api\.stripe\.com/);
});

test('Node guard blocks Request objects and all patched HTTP entry points', () => {
  for (const source of [
    "fetch(new Request('https://api.stripe.com'))",
    "require('node:http').get('http://api.duffel.com')",
    "require('node:https').get('https://api.duffel.com')",
  ]) {
    const output = failed(process.execPath, ['--require', nodeGuard, '-e', source]);
    assert.match(output, /ERR_CI_NETWORK_BLOCKED/);
  }
});

test('Node guard permits Unix sockets and blocks http option hosts', () => {
  run(process.execPath, [
    '--require', nodeGuard,
    '-e',
    "require('node:net').connect({path:'missing-ci-guard.sock'}).on('error',()=>{});",
  ]);
  const output = failed(process.execPath, [
    '--require', nodeGuard,
    '-e',
    "require('node:https').request({hostname:'api.duffel.com', path:'/'});",
  ]);
  assert.match(output, /ERR_CI_NETWORK_BLOCKED/);
});

test('Node guard blocks direct socket connections to public hosts', () => {
  const output = failed(process.execPath, [
    '--require', nodeGuard,
    '-e',
    "new (require('node:net').Socket)().connect(443, 'api.duffel.com');",
  ]);
  assert.match(output, /ERR_CI_NETWORK_BLOCKED/);
});

test('Node guard blocks net.connect and net.createConnection', () => {
  for (const method of ['connect', 'createConnection']) {
    const output = failed(process.execPath, [
      '--require',
      nodeGuard,
      '-e',
      `require('node:net').${method}(443, 'api.duffel.com')`,
    ]);
    assert.match(output, /ERR_CI_NETWORK_BLOCKED/);
  }
});

test('Python guard permits every configured loopback host and blocks public addresses', () => {
  const environment = { ...process.env, PYTHONPATH: pythonGuard };
  run('python', ['-c', "import socket\nfor host in ('localhost', '127.0.0.1', '0.0.0.0', '::1'):\n try:\n  socket.create_connection((host, 9), .01, all_errors=True)\n except (RuntimeError, TypeError):\n  raise\n except BaseException:\n  pass\nif hasattr(socket, 'AF_UNIX'):\n try:\n  socket.socket(socket.AF_UNIX).connect('missing-ci-guard.sock')\n except OSError:\n  pass"], { env: environment });
  const output = failed('python', ['-c', "import socket\nsocket.create_connection(('api.stripe.com', 443))"], { env: environment });
  assert.match(output, /RuntimeError/);
  assert.match(output, /ci-network-guard/);
});

test('Python guard blocks direct socket connections', () => {
  run('python', ['-c', "import socket\ntry:\n socket.socket().connect(('api.duffel.com', 443))\nexcept RuntimeError as error:\n assert 'ci-network-guard' in str(error)\nelse:\n raise AssertionError('network guard did not block')"], { env: { ...process.env, PYTHONPATH: pythonGuard } });
});
