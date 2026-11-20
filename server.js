#!/usr/bin/env node
/**
 * ai-review MCP server
 *
 * 作用：让 Codex 能在干活的过程中调用"第二个模型"做交叉审查（第二意见）。
 * 特点：
 *   - 零依赖：只用 Node 内置模块（Node >= 18，需要全局 fetch）
 *   - 传输：stdio，换行分隔的 JSON-RPC 2.0
 *   - 后端可插拔：本地 Ollama 或任意 OpenAI 兼容云端接口
 *   - 密钥复用：没配环境变量时，自动从 ~/.codex/config.toml 里发现
 *     base_url / token / 模型，所以不用把密钥再抄一份
 *
 * 环境变量：
 *   AI_REVIEW_BACKEND        auto | local | cloud        （默认 auto）
 *   AI_REVIEW_TIMEOUT_MS     单次模型调用超时，默认 180000
 *   AI_REVIEW_LOCAL_MODEL    本地模型名，默认 qwen3:8b
 *   AI_REVIEW_LOCAL_BASE_URL 默认 http://127.0.0.1:11434/v1
 *   AI_REVIEW_LOCAL_NODE    可选；本地推理服务的 Node 可执行文件
 *   AI_REVIEW_LOCAL_SERVER  可选；本地推理服务的入口脚本
 *   AI_REVIEW_CLOUD_BASE_URL 覆盖云端 base_url（默认自动发现）
 *   AI_REVIEW_CLOUD_MODEL    覆盖云端模型名（默认自动发现）
 *   AI_REVIEW_CLOUD_API_KEY  覆盖云端密钥（默认自动发现）
 *   CODEX_HOME               默认 ~/.codex
 */

import { createInterface } from 'node:readline';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = {
  name: 'ai-review',
  version: JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version,
};

const TIMEOUT_MS = clampInt(process.env.AI_REVIEW_TIMEOUT_MS, 180_000, 5_000, 900_000);
const PROBE_TIMEOUT_MS = 8_000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_CONTENT_CHARS = 160_000;
const DEFAULT_LOCAL_MODEL = process.env.AI_REVIEW_LOCAL_MODEL || 'qwen3:8b';
const DEFAULT_LOCAL_BASE = process.env.AI_REVIEW_LOCAL_BASE_URL || 'http://127.0.0.1:11434/v1';

// 本地推理服务按需自动拉起；路径必须由用户显式配置，避免绑定某台机器。
const LOCAL_AUTOSTART = (process.env.AI_REVIEW_LOCAL_AUTOSTART || 'auto').toLowerCase();
const LOCAL_NODE = process.env.AI_REVIEW_LOCAL_NODE || '';
const LOCAL_SERVER = process.env.AI_REVIEW_LOCAL_SERVER || '';
const LOCAL_START_WAIT_MS = clampInt(process.env.AI_REVIEW_LOCAL_START_WAIT_MS, 120_000, 5_000, 600_000);

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function codexHome() {
  const h = process.env.CODEX_HOME;
  if (h && h.trim()) return h.trim();
  try {
    return join(homedir(), '.codex');
  } catch {
    return join(process.env.USERPROFILE || '.', '.codex');
  }
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 后端发现
 * ------------------------------------------------------------------ */

function parseCodexConfig() {
  const raw = readText(join(codexHome(), 'config.toml'));
  if (!raw) return null;

  const scalar = (body, key) => {
    const m = body.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'));
    return m ? m[1] : undefined;
  };

  const providers = {};
  const blockRe = /\[model_providers\.([^\]]+)\]([\s\S]*?)(?=\n\s*\[|$)/g;
  let m;
  while ((m = blockRe.exec(raw)) !== null) {
    const name = m[1].trim();
    const body = m[2];
    const envKey = scalar(body, 'env_key');
    providers[name] = {
      name,
      baseUrl: scalar(body, 'base_url'),
      apiKey: scalar(body, 'experimental_bearer_token') || (envKey ? process.env[envKey] : undefined),
      wireApi: scalar(body, 'wire_api'),
    };
  }

  const activeMatch = raw.match(/^\s*model_provider\s*=\s*"([^"]+)"/m);
  return {
    activeProvider: activeMatch ? activeMatch[1] : undefined,
    defaultModel: scalar(raw.split(/^\s*\[/m)[0] || '', 'model'),
    catalogFile: raw.match(/^\s*model_catalog_json\s*=\s*"([^"]+)"/m)?.[1],
    providers,
  };
}

function catalogSlugs(catalogFile) {
  if (!catalogFile) return [];
  const path = /^[a-zA-Z]:[\\/]/.test(catalogFile) || catalogFile.startsWith('/')
    ? catalogFile
    : join(codexHome(), catalogFile);
  const raw = readText(path);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const models = Array.isArray(parsed?.models) ? parsed.models : [];
    return models.map((x) => x?.slug).filter((x) => typeof x === 'string' && x.length > 0);
  } catch {
    return [];
  }
}

function pickStrongModel(slugs, fallback) {
  const strong = slugs.find((s) => /pro|max|reasoner|thinking|large|opus/i.test(s));
  return strong || slugs.find((s) => !/flash|mini|small|tiny|air|lite/i.test(s)) || slugs[0] || fallback;
}

function cloudBackend() {
  const cfg = parseCodexConfig();
  const override = {
    baseUrl: process.env.AI_REVIEW_CLOUD_BASE_URL,
    model: process.env.AI_REVIEW_CLOUD_MODEL,
    apiKey: process.env.AI_REVIEW_CLOUD_API_KEY,
  };

  if (override.baseUrl && override.model) {
    return { id: 'cloud', label: '云端(env 覆盖)', baseUrl: override.baseUrl, model: override.model, apiKey: override.apiKey };
  }

  if (!cfg) return null;
  const provider =
    cfg.providers[cfg.activeProvider] ||
    Object.values(cfg.providers).find((p) => p.baseUrl);
  if (!provider || !provider.baseUrl) return null;

  const slug = pickStrongModel(catalogSlugs(cfg.catalogFile), cfg.defaultModel || 'default');
  return {
    id: 'cloud',
    label: `云端(${provider.name})`,
    baseUrl: provider.baseUrl,
    model: override.model || slug,
    apiKey: override.apiKey || provider.apiKey,
  };
}

function localBackend() {
  return {
    id: 'local',
    label: '本地(Ollama)',
    baseUrl: DEFAULT_LOCAL_BASE,
    model: DEFAULT_LOCAL_MODEL,
    apiKey: process.env.AI_REVIEW_LOCAL_API_KEY,
  };
}

function availableBackends() {
  return [cloudBackend(), localBackend()].filter(Boolean);
}

function resolveBackend(choice) {
  const wanted = (choice || process.env.AI_REVIEW_BACKEND || 'auto').toLowerCase();
  const all = availableBackends();
  if (wanted === 'auto') {
    return all.find((b) => b.id === 'cloud') || all.find((b) => b.id === 'local') || null;
  }
  return all.find((b) => b.id === wanted) || null;
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

function endpoint(baseUrl, suffix) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (/\/(v1|compatible-mode\/v1)$/.test(base)) return `${base}${suffix}`;
  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(base)) return `${base}/v1${suffix}`;
  return `${base}${suffix}`;
}

function authHeaders(backend) {
  const headers = { 'content-type': 'application/json' };
  if (backend.apiKey) headers.authorization = `Bearer ${backend.apiKey}`;
  return headers;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callModel(backend, { system, user, maxTokens = 4096 }) {
  const url = endpoint(backend.baseUrl, '/chat/completions');
  const body = (withMaxTokens) => ({
    model: backend.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    stream: false,
    ...(withMaxTokens ? { max_tokens: maxTokens } : {}),
  });

  const send = (withMaxTokens) =>
    fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: authHeaders(backend),
        body: JSON.stringify(body(withMaxTokens)),
      },
      TIMEOUT_MS,
    );

  let res = await send(true);
  let text = await res.text();
  if (res.status === 400 && /max_tokens/i.test(text)) {
    res = await send(false);
    text = await res.text();
  }
  if (!res.ok) {
    throw new Error(`${backend.model} @ ${url} 返回 HTTP ${res.status}：${text.slice(0, 600)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`响应不是合法 JSON：${text.slice(0, 300)}`);
  }
  const message = data?.choices?.[0]?.message ?? {};
  const out = String(message.content ?? '').trim() || String(message.reasoning_content ?? '').trim();
  if (!out) throw new Error(`模型没有返回文本：${text.slice(0, 300)}`);
  return { text: out, usage: data.usage ?? null };
}

async function probe(backend) {
  try {
    const res = await fetchWithTimeout(
      endpoint(backend.baseUrl, '/models'),
      { method: 'GET', headers: authHeaders(backend) },
      PROBE_TIMEOUT_MS,
    );
    return { reachable: res.ok, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { reachable: false, detail: err?.name === 'AbortError' ? '连接超时' : String(err?.message || err).slice(0, 160) };
  }
}

/**
 * 确保本地模型在跑：不在跑就拉起来，并等到健康检查通过。
 * 这样就不需要开机自启脚本，也不用你记着先启动模型。
 */
async function ensureLocalRunning() {
  const backend = localBackend();
  const first = await probe(backend);
  if (first.reachable) return { ok: true, started: false, detail: first.detail };

  if (LOCAL_AUTOSTART === 'off') {
    return { ok: false, started: false, detail: '本地服务未运行，且已通过 AI_REVIEW_LOCAL_AUTOSTART=off 关闭自动启动' };
  }
  if (!LOCAL_NODE || !LOCAL_SERVER) {
    return {
      ok: false,
      started: false,
      detail: '本地服务未运行。如需自动启动，请设置 AI_REVIEW_LOCAL_NODE 和 AI_REVIEW_LOCAL_SERVER。',
    };
  }
  if (!existsSync(LOCAL_NODE) || !existsSync(LOCAL_SERVER)) {
    return { ok: false, started: false, detail: `找不到配置的本地推理程序：${LOCAL_NODE} / ${LOCAL_SERVER}` };
  }

  try {
    const child = spawn(LOCAL_NODE, [LOCAL_SERVER], {
      cwd: dirname(LOCAL_SERVER),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch (err) {
    return { ok: false, started: false, detail: `启动失败：${err?.message || err}` };
  }

  const started = Date.now();
  while (Date.now() - started < LOCAL_START_WAIT_MS) {
    await new Promise((r) => setTimeout(r, 2000));
    const status = await probe(backend);
    if (status.reachable) {
      return { ok: true, started: true, detail: `已自动启动（等待 ${((Date.now() - started) / 1000).toFixed(0)} 秒）` };
    }
  }
  return {
    ok: false,
    started: true,
    detail: `已尝试启动，但 ${(LOCAL_START_WAIT_MS / 1000).toFixed(0)} 秒内未就绪（首次加载模型需 5-10 秒，可再试一次）`,
  };
}

/* ------------------------------------------------------------------ *
 * 提示词
 * ------------------------------------------------------------------ */

const REVIEWER_SYSTEM = [
  '你是一名极其严格的资深工程师，负责对另一位 AI 产出的代码或方案做独立审查。',
  '你的目标不是礼貌，而是找出真实缺陷。',
  '只报告实质问题：正确性、边界条件、并发、安全、性能、可维护性、与需求不符。',
  '不要复述代码，不要给泛泛的风格建议，不要为了凑数而编造问题。',
  '如果确实没有实质问题，就明确说"未发现实质问题"。',
  '用中文回答。',
].join('\n');

const REVIEW_FORMAT = [
  '输出格式（必须遵守）：',
  '每条发现占一行：[P0|P1|P2|P3] 位置 — 问题 — 建议',
  '最后单独一行：结论：<通过 | 有条件通过 | 需修改> — <最大风险点>',
].join('\n');

function bounded(label, content) {
  const text = String(content ?? '');
  if (text.length <= MAX_CONTENT_CHARS) return text;
  return `${text.slice(0, MAX_CONTENT_CHARS)}\n\n[${label} 已截断，原始长度 ${text.length} 字符]`;
}

function reviewPrompt({ content, focus, context }) {
  const parts = [];
  if (context) parts.push(`任务背景：\n${bounded('背景', context)}`);
  if (focus) parts.push(`审查重点：${focus}`);
  parts.push(`待审查内容：\n-----BEGIN CONTENT-----\n${bounded('内容', content)}\n-----END CONTENT-----`);
  parts.push(REVIEW_FORMAT);
  return parts.join('\n\n');
}

function opinionPrompt({ question, context }) {
  const parts = [`需要你独立判断的问题：\n${question}`];
  if (context) parts.push(`相关材料：\n-----BEGIN CONTENT-----\n${bounded('材料', context)}\n-----END CONTENT-----`);
  parts.push(
    [
      '要求：',
      '1. 先给出你的结论；',
      '2. 列出你结论所依据的关键事实（不要复述材料原文）；',
      '3. 明确说出你不同意或存疑的地方，以及你有多确定；',
      '4. 如果材料不足以判断，直接说缺什么。',
    ].join('\n'),
  );
  return parts.join('\n\n');
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

const TOOLS = [
  {
    name: 'ai_reviewers',
    description: '列出可用的审查模型后端，并探测它们是否真的能连通。排查"第二个 AI 不工作"时先跑这个。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ai_second_opinion',
    description:
      '把一个问题（可附材料）交给另一个模型做独立的第二意见。适合在方案取舍、判断有分歧、或需要交叉验证结论时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要请对方独立判断的问题。' },
        context: { type: 'string', description: '可选。相关材料、约束、已知信息。' },
        backend: { type: 'string', enum: ['auto', 'local', 'cloud'], description: '默认 auto。' },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
  {
    name: 'ai_review_code',
    description:
      '把代码或 diff 交给另一个模型做严格审查，返回带严重度的问题清单。适合改完代码后的交叉检查。',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要审查的代码、diff 或方案文本。与 path 二选一。' },
        path: { type: 'string', description: '可选。要审查的文件路径（相对当前工作目录或绝对路径）。' },
        focus: { type: 'string', description: '可选。审查重点，例如"关注并发安全 / 关注错误处理"。' },
        context: { type: 'string', description: '可选。这段代码要解决的问题。' },
        backend: { type: 'string', enum: ['auto', 'local', 'cloud'], description: '默认 auto。' },
      },
      additionalProperties: false,
    },
  },
];

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

async function toolReviewers() {
  const backends = availableBackends();
  if (backends.length === 0) return textResult('没有任何可用的审查后端。');

  const startup = await ensureLocalRunning();
  const lines = [
    `默认后端：${resolveBackend('auto')?.id ?? '无'}`,
    `本地模型自启：${startup.detail}`,
    '',
  ];
  for (const backend of backends) {
    const status = await probe(backend);
    lines.push(
      [
        `- id=${backend.id}  ${backend.label}`,
        `  model=${backend.model}`,
        `  base_url=${backend.baseUrl}`,
        `  key=${backend.apiKey ? '已配置' : '未配置（本地模型通常不需要）'}`,
        `  连通性=${status.reachable ? '正常' : '失败'} (${status.detail})`,
      ].join('\n'),
    );
  }
  return textResult(lines.join('\n'));
}

async function callReviewer({ system, user, backend: choice, toolName }) {
  const backend = resolveBackend(choice);
  if (!backend) return textResult(`${toolName} 失败：没有可用的审查后端。`, true);

  if (backend.id === 'local') {
    const startup = await ensureLocalRunning();
    if (!startup.ok) {
      return textResult(`${toolName} 失败：本地模型不可用 —— ${startup.detail}`, true);
    }
  }

  try {
    const { text } = await callModel(backend, { system, user });
    return textResult(`[审查后端：${backend.model} @ ${backend.baseUrl}]\n\n${text}`);
  } catch (err) {
    return textResult(`[审查后端：${backend.model} @ ${backend.baseUrl}]\n调用失败：${err?.message || err}`, true);
  }
}

async function toolSecondOpinion(args) {
  if (!args?.question) return textResult('缺少参数 question。', true);
  return callReviewer({
    system: REVIEWER_SYSTEM,
    user: opinionPrompt(args),
    backend: args.backend,
    toolName: 'ai_second_opinion',
  });
}

async function toolReviewCode(args) {
  let content = args?.content;
  let sourceNote = 'inline';
  if (!content && args?.path) {
    const path = resolve(process.cwd(), args.path);
    const raw = readText(path);
    if (raw === null) return textResult(`读不到文件：${path}`, true);
    if (Buffer.byteLength(raw, 'utf8') > MAX_FILE_BYTES) {
      return textResult(`文件过大（>${Math.round(MAX_FILE_BYTES / 1024)}KB），请改用 content 传片段：${path}`, true);
    }
    content = raw;
    sourceNote = path;
  }
  if (!content) return textResult('需要提供 content 或 path。', true);

  const result = await callReviewer({
    system: REVIEWER_SYSTEM,
    user: reviewPrompt({ content, focus: args.focus, context: args.context }),
    backend: args.backend,
    toolName: 'ai_review_code',
  });
  if (Array.isArray(result.content) && result.content[0]?.type === 'text' && sourceNote !== 'inline') {
    result.content[0].text = `[来源：${sourceNote}]\n${result.content[0].text}`;
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * JSON-RPC 循环
 * ------------------------------------------------------------------ */

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(message) {
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      sendResult(id, {
        protocolVersion: typeof requested === 'string' && requested.length > 0 ? requested : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
      return;
    }
    case 'notifications/initialized':
    case 'initialized':
      return;
    case 'ping':
      sendResult(id, {});
      return;
    case 'tools/list':
      sendResult(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      try {
        if (name === 'ai_reviewers') return sendResult(id, await toolReviewers());
        if (name === 'ai_second_opinion') return sendResult(id, await toolSecondOpinion(args));
        if (name === 'ai_review_code') return sendResult(id, await toolReviewCode(args));
        return sendResult(id, textResult(`未知工具：${name}`, true));
      } catch (err) {
        return sendResult(id, textResult(`执行 ${name} 时出错：${err?.message || err}`, true));
      }
    }
    default:
      if (isNotification) return;
      sendError(id, -32601, `Method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  Promise.resolve(handle(message)).catch((err) => {
    if (message?.id !== undefined && message?.id !== null) {
      sendError(message.id, -32603, `Internal error: ${err?.message || err}`);
    }
  });
});
rl.on('close', () => process.exit(0));
