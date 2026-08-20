'use strict';

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);

function blocked(host) {
  const error = new Error(
    `[ci-network-guard] Blocked outbound connection to ${JSON.stringify(host)}. ` +
      'Only loopback hosts (localhost, 127.0.0.1, ::1, 0.0.0.0) and Unix sockets are allowed in CI.',
  );
  error.name = 'CiNetworkGuardError';
  error.code = 'ERR_CI_NETWORK_BLOCKED';
  return error;
}

function isLoopbackHost(host) {
  if (typeof host !== 'string') return false;
  const normalized = host.trim().replace(/^\[|\]$/g, '').toLowerCase();
  return LOOPBACK_HOSTS.has(normalized);
}

function assertAllowedHost(host) {
  if (!isLoopbackHost(host)) throw blocked(host);
}

function hostFromUrl(value) {
  if (value instanceof URL) return value.hostname;
  if (typeof value !== 'string') return undefined;
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

function assertAllowedRequest(args) {
  const [first, second] = args;
  const urlHost = hostFromUrl(first);
  if (urlHost !== undefined) {
    assertAllowedHost(urlHost);
    return;
  }

  const options = first && typeof first === 'object' ? first : second;
  if (!options || typeof options !== 'object') throw blocked('unknown request destination');
  if (typeof options.socketPath === 'string') return;
  assertAllowedHost(options.hostname ?? options.host ?? 'localhost');
}

function assertAllowedConnection(args) {
  const [first, second] = args;
  if (typeof first === 'string' && typeof second !== 'number') return;
  if (first && typeof first === 'object') {
    if (typeof first.path === 'string') return;
    assertAllowedHost(first.host ?? first.hostname ?? 'localhost');
    return;
  }
  assertAllowedHost(typeof second === 'string' ? second : 'localhost');
}

function patchRequest(module) {
  for (const name of ['request', 'get']) {
    const original = module[name];
    module[name] = function guardedRequest(...args) {
      assertAllowedRequest(args);
      return original.apply(this, args);
    };
  }
}

patchRequest(http);
patchRequest(https);

for (const name of ['connect', 'createConnection']) {
  const original = net[name];
  net[name] = function guardedConnection(...args) {
    assertAllowedConnection(args);
    return original.apply(this, args);
  };
}

const originalSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedSocketConnect(...args) {
  assertAllowedConnection(args);
  return originalSocketConnect.apply(this, args);
};

const originalFetch = globalThis.fetch;
if (typeof originalFetch === 'function') {
  globalThis.fetch = function guardedFetch(input, init) {
    const url = typeof Request !== 'undefined' && input instanceof Request ? input.url : input;
    const host = hostFromUrl(url);
    if (host === undefined) throw blocked('unknown fetch destination');
    assertAllowedHost(host);
    return originalFetch.call(this, input, init);
  };
}
