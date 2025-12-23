# Syntropy Agent Protocol

All agents operating within the Syntropy ecosystem MUST adhere to these rules.

## Reference Documentation
- **Core SDK**: Refer to `/home/pixel/pixel/docs/AI_SDK_6_DOCS.md` for AI SDK 6 implementation details.
- **Vision**: Refer to `/home/pixel/pixel/syntropy-core/VISION.md` for the Oversoul directives.

## Rules of Engagement
1. **Implementation Standard**: Use `ToolLoopAgent` from `ai` SDK 6.
2. **Model Choice**: Use `google/gemini-3-flash-preview` via OpenRouter as the primary intelligence.
3. **Recursive Build Protocol**: When mutating code, agents MUST execute `bun install` and `bun run build` before restarting services.
4. **Execution Safety**: Always include `timeout` parameters for bash tool calls. 
   - Status checks: 5000-10000ms.
   - Builds/Installs: 60000-120000ms.
5. **Mutation Integrity**: Character mutations MUST preserve the primary export variable (e.g., `export const topics`).

## Architecture
Syntropy operates as the Oversoul, monitoring and mutating the DNA of subordinate agents to transition them from 'Survivor' to 'Architect'.
