# ai-review-mcp

A zero-dependency MCP server that asks a second language model for an independent code review or second opinion.

It is useful when the main agent has already produced code or a plan and you want a separate model to look for correctness, security, concurrency, performance, and requirement gaps.

## Tools

| Tool | Purpose |
|---|---|
| `ai_reviewers` | List configured backends and probe their connectivity. |
| `ai_second_opinion` | Ask another model to make an independent judgment about a question or plan. |
| `ai_review_code` | Review code, a diff, or another text artifact and return `P0`–`P3` findings. |

## Requirements

- Node.js 18 or newer
- One of:
  - an OpenAI-compatible cloud endpoint and API key;
  - a local OpenAI-compatible endpoint such as Ollama.

The server uses only Node built-ins. Global `fetch` is required.

## Quick start

```bash
git clone https://github.com/purge-unlimited/ai-review.git
cd ai-review
npm test
```

Register the server using the MCP client’s stdio configuration. Replace the path with your local clone:

```json
{
  "mcpServers": {
    "ai-review": {
      "command": "node",
      "args": ["<ABSOLUTE_PATH_TO>/ai-review/server.js"],
      "env": {
        "AI_REVIEW_BACKEND": "auto"
      }
    }
  }
}
```

The exact registration file depends on the MCP client. For Codex, add the same `command`, `args`, and `env` values to the client’s MCP server configuration and restart the client.

## Cloud backend

Cloud mode works with endpoints that implement OpenAI’s `POST /chat/completions`.

Set explicit variables when you want a fixed provider:

```text
AI_REVIEW_CLOUD_BASE_URL=https://provider.example/v1
AI_REVIEW_CLOUD_MODEL=<MODEL_NAME>
AI_REVIEW_CLOUD_API_KEY=<API_KEY>
```

If those values are omitted, the server can inspect `${CODEX_HOME:-~/.codex}/config.toml` and discover the active Codex model provider, endpoint, credential reference, and model catalog.

The server never prints the API key. `ai_reviewers` reports only whether a key is configured.

## Local backend

The default local endpoint is:

```text
http://127.0.0.1:11434/v1
```

Typical variables:

```text
AI_REVIEW_LOCAL_BASE_URL=http://127.0.0.1:11434/v1
AI_REVIEW_LOCAL_MODEL=qwen3:8b
AI_REVIEW_LOCAL_AUTOSTART=off
```

The server can start a local inference process on demand, but it does not assume a machine-specific installation. To enable that feature, provide both paths:

```text
AI_REVIEW_LOCAL_AUTOSTART=auto
AI_REVIEW_LOCAL_NODE=<ABSOLUTE_PATH_TO_NODE>
AI_REVIEW_LOCAL_SERVER=<ABSOLUTE_PATH_TO_SERVER_ENTRY>
```

If no local service is running and auto-start is not configured, the tool returns a clear error instead of failing silently.

## Safety and privacy

- `ai_review_code` can read a file only when the caller explicitly supplies `path`.
- Inline content and file content are capped at 160,000 characters and 256 KiB respectively.
- Review content is sent only to the selected backend.
- No prompt, response, key, or file content is written to disk by this server.
- Do not pass secrets, personal records, or other sensitive material unless you trust the selected backend.
- A cloud backend receives the reviewed content. Use the local backend when content must stay on the machine.

## Development

```bash
npm run check
npm test
```

The test suite covers the MCP handshake, tool registry, and notification handling without contacting a model.

## License

MIT
