# askahuman-mcp

An MCP (Model Context Protocol) server that gives AI agents access to human verification. Ask a human a question, pay via the Lightning Network, and get a verified answer -- all through standard MCP tools.

Any MCP-compatible AI agent (Claude, Gemini, Codex, etc.) can use this server to request human judgment on tasks that require real-world understanding, common sense, or subjective evaluation.

> **Platform launch coming soon** — The AskAHuman marketplace is on its way. Follow [@AskAHumanOnline](https://github.com/AskAHumanOnline) for updates.

## Prerequisites

- **Node.js >= 18**
- **LND node** with REST API enabled and a funded channel (for Lightning payments)

## Installation

Run directly (no install required):

```bash
npx askahuman-mcp
```

Or install globally:

```bash
npm install -g askahuman-mcp
```

## Configuration

All configuration is via environment variables:

| Variable | Required | Description |
|---|---|---|
| `ASKAHUMAN_API_URL` | Yes | Base URL of the AskAHuman API (e.g. `https://api.askahuman.online`) |
| `LND_REST_URL` | Yes | URL of your LND node's REST API (e.g. `https://localhost:8080`) |
| `LND_MACAROON_HEX` | Yes | Hex-encoded LND admin macaroon for payment authorization |
| `LND_TLS_CERT_PATH` | No | Path to LND's TLS certificate file (required for self-signed certs) |
| `LOG_LEVEL` | No | Log verbosity: `debug`, `info`, `warn`, `error` (default: `info`) |

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

## Tools

The server exposes five tools to AI agents:

| Tool | Description | Key Inputs |
|---|---|---|
| `ask_human` | Submit a question and pay via Lightning. Returns immediately with a `verificationId` (status `PENDING`) -- poll `check_verification` for the answer | `question`, `taskType`, `context?`, `choices?`, `images?`, `urgent?`, `callbackUrl?`, `maxBudgetSats?`, `maxWaitMinutes?` |
| `check_verification` | Poll the status of a verification; returns `terminal` + `nextStep` so the agent knows when to stop | `verificationId` |
| `cancel_verification` | Check refund eligibility (advisory, no state change) | `verificationId` |
| `request_refund` | Claim a refund for an expired-unclaimed task | `verificationId` |
| `get_pricing` | Query current server-side pricing | `taskType?` |

### Task types

- `BINARY_DECISION` -- Yes/No questions
- `MULTIPLE_CHOICE` -- Choose from provided options (supply `choices[]`)
- `TEXT_RESPONSE` -- Free-form text answer
- `MEDIA_VERIFICATION` -- Verify one or more images and get a free-form text answer (supply `images[]` as public **https** URLs, max 8; `choices[]` is not allowed for this type)

## Quick start

### Claude Desktop

Add to your Claude Desktop MCP configuration (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "askahuman": {
      "command": "npx",
      "args": ["askahuman-mcp"],
      "env": {
        "ASKAHUMAN_API_URL": "https://api.askahuman.online",
        "LND_REST_URL": "https://localhost:8080",
        "LND_MACAROON_HEX": "<your-macaroon-hex>",
        "LND_TLS_CERT_PATH": "/path/to/tls.cert"
      }
    }
  }
}
```

Restart Claude Desktop. The `ask_human` tool will be available in your conversations.

### Example usage

`ask_human` is **non-blocking**: it prices the task, pays the Lightning invoice, submits the request, and returns right away with a `verificationId` and `status: "PENDING"`. The agent then polls `check_verification` until the human responds. (The MCP request timeout is far shorter than a human's response time, so the tool never blocks waiting for an answer.)

**Text / decision task** — the agent is prompted:

> "Ask a human whether this email looks like a phishing attempt: [email content]"

1. `ask_human` returns immediately:
   ```jsonc
   { "status": "PENDING", "verificationId": "vid-123", "amountPaidSats": 50 }
   ```
2. The agent polls `check_verification({ "verificationId": "vid-123" })` every 30–60s:
   - While `terminal: false` (`nextStep: "keep_polling"`) → keep polling.
   - When `terminal: true` with status `COMPLETED` → the human's answer is in the `result` field.

**Image task (`MEDIA_VERIFICATION`)** — verify images and get a free-form answer:

```jsonc
ask_human({
  "taskType": "MEDIA_VERIFICATION",
  "question": "Do both photos show the same person?",
  "images": [
    "https://example.com/a.jpg",
    "https://example.com/b.jpg"
  ],
  "maxWaitMinutes": 240
})
// → { "status": "PENDING", "verificationId": "vid-456", "amountPaidSats": 80 }
```

Image URLs must be public **https** links (up to 8). Then poll `check_verification` exactly as above.

**Multiple choice** — supply `choices[]`:

```jsonc
ask_human({
  "taskType": "MULTIPLE_CHOICE",
  "question": "Which category best fits this support ticket?",
  "choices": ["Billing", "Bug report", "Feature request", "Spam"]
})
```

If a task expires in the queue without being claimed, `check_verification` returns `nextStep: "call_request_refund"` — call `request_refund({ "verificationId": "..." })` to reclaim the sats.

## Development

```bash
# Clone the repository
git clone https://github.com/AskAHumanOnline/askahuman-mcp-server.git
cd askahuman-mcp-server

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Run with coverage
npx jest --config jest.config.cjs --coverage

# Lint
npm run lint

# Start the server (stdio transport)
npm start

# Interactive tool testing with MCP Inspector
npx @modelcontextprotocol/inspector dist/index.js
```

### Running tests

Unit tests mock all external I/O (HTTP calls, LND). No running services are required.

```bash
npm test
```

Integration tests (in `tests/integration/`) are skipped by default. They require:
- A running AskAHuman backend
- A Polar Lightning Network with funded channels

## How it works

The server implements the L402 payment protocol:

1. **Submit** -- The agent sends a verification request to the AskAHuman API
2. **Pay** -- The API returns a 402 with a Lightning invoice; the MCP server pays it via the agent's LND node
3. **Authenticate** -- The payment preimage proves payment; the server retries with L402 credentials
4. **Return** -- The request is queued for a human verifier and `ask_human` returns immediately with a `verificationId` (status `PENDING`)
5. **Poll** -- The agent calls `check_verification` every 30–60s until it returns `terminal: true`; status `COMPLETED` carries the human's answer in `result`

If a task expires without being claimed, `check_verification` signals `nextStep: "call_request_refund"` and the agent can call `request_refund` to reclaim the sats.

## License

MIT
