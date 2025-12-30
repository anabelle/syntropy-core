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
- **Opencode Integration**: Delegate complex coding tasks to the Opencode AI Agent.

## Current Stack (December 2025)
- **Runtime**: Bun v1.3+
- **Intelligence**: AI SDK (OpenAI gpt-4o-mini)
- **Agent Framework**: ElizaOS v1.6.2 with CLI v1.7.0
- **Database**: PostgreSQL 15 (migrated from SQLite)
- **Deployment**: Docker Compose with Nginx Reverse Proxy

## Agent Plugins (Active)
- `@elizaos/plugin-bootstrap` - Core bootstrapping
- `@elizaos/adapter-postgres` - PostgreSQL adapter
- `@elizaos/plugin-sql` - SQL support
- `@elizaos/plugin-openai` - OpenAI integration
- `@elizaos/plugin-openrouter` - Multi-model routing
- `@elizaos/plugin-telegram` - Telegram bot
- `@elizaos/plugin-knowledge` - Knowledge management
- `pixel-plugin-nostr` - Custom Nostr integration

**Disabled**: `@elizaos/plugin-discord`, `@elizaos/plugin-twitter` (pending API credentials)

## Setup & Permissions
Syntropy requires:
- `GH_TOKEN`: GitHub PAT (repo scope) for self-evolution.
- `OPENAI_API_KEY`: For the Intelligence Engine.
- `DATABASE_URL`: PostgreSQL connection string.
- Docker socket access (mounted automatically).
- Write access to the repository root.

## License
MIT
