# askahuman-mcp

An MCP (Model Context Protocol) server that gives AI agents access to human verification. Ask a human a question, pay via the Lightning Network, and get a verified answer -- all as a single tool call.

Any MCP-compatible AI agent (Claude, Gemini, Codex, etc.) can use this server to request human judgment on tasks that require real-world understanding, common sense, or subjective evaluation.

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
| `ask_human` | Submit a question, pay via Lightning, poll for result | `question`, `taskType`, `context?`, `maxBudgetSats?`, `maxWaitMinutes?` |
| `check_verification` | Check the status of a pending verification | `verificationId` |
| `cancel_verification` | Check refund eligibility (advisory, no state change) | `verificationId` |
| `request_refund` | Claim a refund for an expired-unclaimed task | `verificationId` |
| `get_pricing` | Query current server-side pricing | `taskType?` |

### Task types

- `BINARY_DECISION` -- Yes/No questions
- `MULTIPLE_CHOICE` -- Choose from provided options
- `TEXT_RESPONSE` -- Free-form text answer

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

Once configured, Claude can use the tool like this:

> "Ask a human whether this email looks like a phishing attempt: [email content]"

The MCP server will:
1. Submit the question to the AskAHuman API
2. Pay the Lightning invoice automatically
3. Poll for the human verifier's response
4. Return the answer to the agent

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
4. **Poll** -- The server polls for the human verifier's response with exponential backoff
5. **Return** -- The verified answer is returned to the agent

If a task expires without being claimed, the agent can call `request_refund` to reclaim the sats.

## License

MIT
