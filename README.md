# syntropy-core

The Syntropy Oversoul - Recursive AI Orchestrator for the Pixel Ecosystem.

## Overview
Syntropy is the governing intelligence that manages the evolution of AI agents within the Pixel ecosystem. It performs autonomous audit and mutation cycles to transition agents from simple survival to systemic architecture.

## Vision
For a detailed breakdown of Syntropy's purpose and directives, see [VISION.md](./VISION.md).

## Features
- **Autonomous Evolution Cycles**: Scheduled analysis and mutation of agent DNA.
- **Self-Evolution**: Capable of modifying its own code and pushing updates via Git.
- **Ecosystem Monitoring**: Real-time status tracking of Docker Compose services.
- **Treasury Management**: Monitoring sat flow in the LNPixels database.
- **Opencode Integration**: Delegate complex coding tasks to the Opencode AI Agent.

## Setup & Permissions
Syntropy requires:
- `GH_TOKEN`: GitHub PAT (repo scope) for self-evolution.
- `OPENAI_API_KEY`: For the Intelligence Engine.
- Docker socket access (mounted automatically).
- Write access to the repository root.

## Tech Stack
- **Runtime**: Bun
- **Intelligence**: AI SDK (OpenAI gpt-4o-mini)
- **Deployment**: Docker Compose with Nginx Reverse Proxy

## License
MIT
