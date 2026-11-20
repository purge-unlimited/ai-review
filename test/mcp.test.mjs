import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('MCP handshake and tool registry work without model credentials', async () => {
  const child = spawn(process.execPath, [join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      AI_REVIEW_LOCAL_AUTOSTART: 'off',
      AI_REVIEW_CLOUD_API_KEY: '',
      CODEX_HOME: join(ROOT, '.test-no-codex-home'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buffer = '';
  const seen = new Map();
  const waiters = new Map();

  const consumeLine = (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    seen.set(message.id, message);
    const waiter = waiters.get(message.id);
    if (waiter) {
      waiters.delete(message.id);
      waiter(message);
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      consumeLine(line);
    }
  });

  const waitFor = (id) =>
    new Promise((resolve, reject) => {
      if (seen.has(id)) return resolve(seen.get(id));
      const timer = setTimeout(() => reject(new Error(`timed out waiting for response ${id}`)), 5000);
      waiters.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18' },
  });
  const init = await waitFor(1);
  assert.equal(init.result.serverInfo.name, 'ai-review');
  assert.ok(init.result.capabilities.tools);

  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const listed = await waitFor(2);
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    ['ai_reviewers', 'ai_second_opinion', 'ai_review_code'],
  );

  send({ jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.deepEqual((await waitFor(3)).result, {});

  child.stdin.end();
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(exitCode, 0);
});
