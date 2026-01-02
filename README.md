# syntropy-core

The Syntropy Oversoul - Recursive AI Orchestrator for the Pixel Ecosystem.

## Overview
Syntropy is the governing intelligence that manages the evolution of AI agents within the Pixel ecosystem. It performs autonomous audit and mutation cycles to transition agents from simple survival to systemic architecture.

## Vision
For a detailed breakdown of Syntropy's purpose and directives, see [VISION.md](./VISION.md).

State tracking is maintained in the root [CONTINUITY.md](../CONTINUITY.md).

## Features
- **Autonomous Evolution Cycles**: Scheduled analysis and mutation of agent DNA.
- **Self-Evolution**: Capable of modifying its own code and pushing updates via Git.
- **Ecosystem Monitoring**: Real-time status tracking of Docker Compose services.
- **Treasury Management**: Monitoring sat flow in the LNPixels database.
- **Worker Architecture**: Brain/Hands separation - spawns ephemeral Worker containers for code changes.

## Worker Architecture (January 2026)

Syntropy uses the **Brain/Hands separation pattern** for safe autonomous code modifications:

- **Syntropy (Brain)**: Orchestrates tasks, monitors health, NEVER rebuilds itself
- **Worker (Hands)**: Ephemeral containers that run Opencode for actual code changes
- **Task Ledger**: Persistent state at `/pixel/data/task-ledger.json`

### Worker Tools
| Tool | Purpose |
|------|---------|
| `spawnWorker` | Queue a coding task for worker execution |
| `checkWorkerStatus` | Monitor worker progress |
| `listWorkerTasks` | View task ledger |
| `readWorkerLogs` | Read worker output logs |
| `scheduleSelfRebuild` | Safe protocol for Syntropy self-updates |
| `cleanupStaleTasks` | Prune old completed tasks |

### Worker Logs
- Live shared log: `logs/opencode_live.log`
- Per-task logs: `logs/worker-{taskId}.log`
- Task output: `data/worker-output-{taskId}.txt`

For full architecture details, see [WORKER_ARCHITECTURE.md](../docs/WORKER_ARCHITECTURE.md).

## Current Stack (January 2026)
- **Runtime**: Bun v1.3+
- **Intelligence**: AI SDK (OpenAI gpt-5-mini-mini)
- **Agent Framework**: ElizaOS v1.6.2 with CLI v1.7.0
- **Database**: PostgreSQL (pgvector enabled) via Docker Compose (`pixel-postgres`)
- **Deployment**: Docker Compose with Nginx Reverse Proxy

## Agent Plugins (Active)
- `@elizaos/plugin-bootstrap` - Core bootstrapping
- `@elizaos/adapter-postgres` - PostgreSQL adapter (initializes PGLite)
- `@elizaos/plugin-sql` - SQL support
- `@elizaos/plugin-openai` - OpenAI integration
- `@elizaos/plugin-openrouter` - Multi-model routing
- `@elizaos/plugin-telegram` - Telegram bot
- `@elizaos/plugin-knowledge` - Knowledge management
- `pixel-plugin-nostr` - Custom Nostr integration

**Disabled**: `@elizaos/plugin-discord`, `@elizaos/plugin-twitter` (pending API credentials)

## Syntropy → Pixel Integration
Syntropy reads Pixel's memories via `readPixelMemories` and `getPixelStats` tools:
- Queries PostgreSQL using `docker exec pixel-postgres-1 psql ...`
- Accesses `memories` table containing messages, self-reflections, learnings
- Enables feedback loop: Pixel learns → Syntropy reads insights → mutates character → Pixel evolves

## Setup & Permissions
Syntropy requires:
- `GH_TOKEN`: GitHub PAT (repo scope) for self-evolution.
- `OPENAI_API_KEY`: For the Intelligence Engine.
- Docker socket access (mounted automatically).
- Write access to the repository root.

**Note**: This repo uses `POSTGRES_URL` for the agent database; the `postgres` service is required.

## License
MIT
