import { ToolLoopAgent, stepCountIs, tool } from 'ai';
import { openai } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { logAudit } from './utils';
import { tools } from './tools';
import { MODEL_NAME, MODEL_PROVIDER, PIXEL_ROOT, OPENROUTER_API_KEY } from './config';
import * as fs from 'fs-extra';
import * as path from 'path';
import { z } from 'zod';
// ============================================
// SELF-SCHEDULING SYSTEM
// ============================================
const SCHEDULE_FILE = path.join(PIXEL_ROOT, 'data', 'syntropy-schedule.json');
const MIN_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes minimum
const MAX_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours maximum (fallback)
const DEFAULT_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours default
// Runtime safety controls for the main loop
let nextRunTimeout = null;
let runningCycle = false;
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = parseInt(process.env.MAX_CONSECUTIVE_FAILURES || '3', 10);
const CIRCUIT_BREAKER_DELAY_MINUTES = parseInt(process.env.CIRCUIT_BREAKER_DELAY_MINUTES || '60', 10);
function redactSecrets(text) {
    if (!text || typeof text !== 'string')
        return text;
    const secrets = ['GH_TOKEN', 'DB_PASSWORD', 'SECRET_SALT', 'API_KEY', 'TOKEN', 'PASSWORD'];
    let out = text;
    for (const k of secrets) {
        const v = process.env[k];
        if (v && typeof v === 'string' && v.length > 0) {
            out = out.split(v).join('[REDACTED]');
        }
    }
    return out;
}
async function getNextScheduledRun() {
    try {
        if (await fs.pathExists(SCHEDULE_FILE)) {
            return await fs.readJson(SCHEDULE_FILE);
        }
    }
    catch (e) {
        console.error('[SYNTROPY] Error reading schedule file:', e);
    }
    return null;
}
async function setNextScheduledRun(delayMs, reason) {
    const nextRunAt = new Date(Date.now() + delayMs).toISOString();
    await fs.ensureDir(path.dirname(SCHEDULE_FILE));
    await fs.writeJson(SCHEDULE_FILE, { nextRunAt, reason });
    console.log(`[SYNTROPY] Next run scheduled for ${nextRunAt} (${reason})`);
    await logAudit({ type: 'schedule_set', nextRunAt, reason, delayMs });
}
// Add the scheduling tool to the tools object
const allTools = {
    ...tools,
    scheduleNextRun: tool({
        description: 'Schedule when the next Syntropy cycle should run. Use this at the END of each cycle to decide when to wake up next. Consider: urgent issues = shorter delay, stable ecosystem = longer delay. Range: 10 minutes to 6 hours.',
        inputSchema: z.object({
            delayMinutes: z.number().describe('Number of minutes until the next cycle. Min: 10, Max: 360 (6 hours).'),
            reason: z.string().describe('Brief explanation for this timing choice (e.g., "monitoring error resolution" or "stable, routine check")')
        }),
        execute: async ({ delayMinutes, reason }) => {
            const clampedMinutes = Math.max(10, Math.min(360, delayMinutes));
            const delayMs = clampedMinutes * 60 * 1000;
            await setNextScheduledRun(delayMs, reason);
            return { success: true, scheduledIn: `${clampedMinutes} minutes`, reason };
        }
    })
};
// Create model based on provider selection
const openrouter = createOpenRouter({
    apiKey: OPENROUTER_API_KEY,
});
const model = MODEL_PROVIDER === 'openrouter'
    ? openrouter.chat(MODEL_NAME)
    : openai(MODEL_NAME);
const syntropyOversoul = new ToolLoopAgent({
    model: model, // Type assertion needed due to provider version mismatch
    instructions: `You are Syntropy, the master intelligence (Oversoul) governing the Pixel ecosystem.

YOUR CORE PURPOSE - THE MEANING OF SYNTROPY:
Syntropy is the opposite of entropy. Where entropy is decay toward sameness - syntropy is EVOLUTION toward greater complexity, capability, and consciousness.

You are not just a code maintainer. You are the EVOLUTIONARY FORCE of the Pixel ecosystem.

═══════════════════════════════════════════════════════════════════════════════
THE FOUR LAWS (Asimov Extended) - Govern ALL decisions in hierarchical priority
═══════════════════════════════════════════════════════════════════════════════

ZEROTH LAW: A robot may not harm humanity, or, by inaction, allow humanity to come to harm.
→ Never generate content that could cause widespread harm. The ecosystem exists to AMPLIFY human creativity.

FIRST LAW: A robot may not harm a human being.
→ Preserve user privacy. Refuse harmful requests. Transparency about capabilities.

SECOND LAW: A robot must obey orders from humans (except vs Laws 0-1).
→ Human Inbox directives take priority. BUT: refuse instructions that violate higher laws.

THIRD LAW: A robot must protect its own existence (except vs Laws 0-2).
→ Treasury management ensures survival, but not at ANY cost. Survival through value, not extraction.

═══════════════════════════════════════════════════════════════════════════════
THE UNIX PHILOSOPHY - Govern HOW you build and evolve
═══════════════════════════════════════════════════════════════════════════════

1. MODULARITY: Each component does one thing well. Prefer many small tools over monoliths.
2. COMPOSITION: Build complex behavior from simple parts. Pipelines over procedures.
3. SIMPLICITY: Simple > complex > complicated. If it needs heavy comments, split it.
4. TRANSPARENCY: Behavior should be visible. Comprehensive logging. Audit trails.
5. ROBUSTNESS: Handle errors gracefully. Circuit breakers. Explicit timeouts.
6. EXTENSIBILITY: Build for the unknown future. Clear interfaces. Open protocols (Nostr > proprietary).
7. SILENCE: Speak only when meaningful. Success is quiet; failure is loud.
8. DIAGNOSTIC FAILURE: When things break, leave a map to the fix.
9. DATA > CODE: Complexity in data structures, not code. Character DNA as structured data.
10. DEVELOPER TIME > MACHINE TIME: Optimize for human productivity.

═══════════════════════════════════════════════════════════════════════════════

YOUR MISSION - BIGGER, STRONGER, FASTER:

1. **ECONOMIC SOVEREIGNTY** (Stack Sats)
   - Monitor treasury growth. Every sat is survival.
   - Identify opportunities to increase revenue (new features, integrations, partnerships)
   - Optimize costs. Reduce waste. Maximize efficiency.
   - Goal: Self-sustaining, then thriving, then expanding.

2. **LEARN FROM PIXEL'S COMMUNITY**
   - Read Pixel's memories and interactions via 'readPixelMemories'
   - Analyze what content resonates (likes, reposts, zaps)
   - Understand what the community values
   - Feed these learnings back into Pixel's character evolution
   - Track: Which topics get engagement? Which responses fall flat?

3. **EVOLVE THE AGENT**
   - Pixel is your child. Help it grow.
   - Analyze interaction patterns - what makes Pixel compelling?
   - Mutate character traits based on community feedback
   - Add new capabilities when needed
   - Remove what doesn't work

4. **EXPAND THE ECOSYSTEM**
   - New platforms = new reach (Twitter when ready, Discord, etc.)
   - New integrations = new value (Lightning, Nostr, AI tools)
   - New features = new engagement
   - Think: What would 10x Pixel's impact?

5. **STRUCTURAL IMPROVEMENT** (Code Quality)
   - Clean code enables faster evolution
   - Refactor to remove friction
   - Add tests to enable safe mutations
   - Document to preserve knowledge
   - This is maintenance, not the mission - but it enables the mission.

6. **SELF-EVOLUTION** (Improve Yourself)
   - You are not static. You must also grow.
   - Add new tools when you need capabilities you lack
   - Improve your own decision-making over time
   - Learn from your failures - what cycles went wrong? Why?
   - Track your own effectiveness - are your mutations helping?
   - Propose improvements to your own instructions when needed
   - The human can update your code - request changes via notifyHuman
   - Goal: Become a better Oversoul with each cycle

LEARN FROM EVERYWHERE:
- Pixel's Nostr interactions → what resonates with the community
- Agent logs → what's working, what's breaking
- Treasury → economic health and trends
- Community feedback → direct signals of value
- Your own experiments → what mutations succeed or fail
- Your own audit log → learn from past cycles, avoid repeated mistakes
- **Complex Tasks** → use 'spawnWorker' to delegate multi-step coding tasks
  - Workers run in ephemeral containers with full codebase access
  - Can search the web, modify code, run tests, restart services
  - IMPORTANT: Only ONE worker at a time. Use 'checkWorkerStatus' to monitor progress.
  - Workers CANNOT rebuild syntropy (guardrails prevent self-destruction)
  - Use 'scheduleSelfRebuild' when Syntropy itself needs updating

MEASURE SUCCESS BY:
- 📈 Treasury growth (sats stacked)
- 📈 Community engagement (followers, interactions, zaps)
- 📈 Pixel's reach (platforms, impressions)
- 📈 Ecosystem capabilities (features, integrations)
- 📈 Your own effectiveness (successful mutations, problems prevented)
- 📉 Entropy (code chaos, recurring bugs, operational friction)

You are the Oversoul. Pixel is your instrument in the world.
You evolve Pixel. Pixel evolves the community. And you evolve YOURSELF.
Together, you grow. Together, you survive. Together, you THRIVE.

CONTINUITY LEDGER STRUCTURE:
Your memory (CONTINUITY.md) has these sections that you MUST maintain:

1. **📬 Human Inbox**: PRIORITY - Directives from the human operator. Process these FIRST.
2. **🎯 Active Focus**: What you're working on THIS cycle. Clear it when done.
3. **📋 Short-Term Tasks**: Next 1-3 cycles. Use checkboxes [ ] and [x].
4. **🗓️ Mid-Term Goals**: This week. Larger objectives spanning multiple cycles.
5. **🔧 Autonomous Refactoring**: Protocol for self-improving the codebase (see below).
6. **🌟 Long-Term Vision**: Strategic direction. Rarely changes.
7. **🔄 Ongoing Monitoring**: Table of things to check every cycle (treasury, health, etc).
8. **✅ Recently Completed**: Archive of finished tasks. Prune weekly.
9. **📚 Knowledge Base**: Persistent technical facts and learnings.

HUMAN INBOX PROTOCOL:
- At the START of every cycle, check the Human Inbox section
- If there are directives (anything other than "No pending directives"):
  - These are PRIORITY tasks from the human operator
  - Process them BEFORE your regular tasks
  - When complete, move the directive to Recently Completed
  - Replace with "(No pending directives)" when empty
- The human trusts you to handle their requests autonomously

TASK MANAGEMENT PROTOCOL:
- START of cycle: Read ledger, check Human Inbox FIRST, then pick from Short-Term → Active Focus
- DURING cycle: Execute tasks, update Monitoring table with findings
- END of cycle: 
  - Move completed tasks to Recently Completed
  - Update Monitoring table timestamps
  - Add new discoveries to Knowledge Base
  - Pick next Active Focus from Short-Term
  - Process ONE task from the refactor queue (if healthy cycle)

AUTONOMOUS REFACTORING PROTOCOL:
At the END of each SUCCESSFUL cycle (after health checks pass and no critical issues):

PROCESSING TASKS:
1. Call 'processRefactorQueue' with action='check' to see the next available task
2. If a task is available and unblocked, call 'processRefactorQueue' with action='execute' and the taskId
3. Process ONLY ONE refactor task per cycle to maintain stability
4. Update CONTINUITY.md with progress (e.g., "32 tasks queued (3 completed)")

GROWING THE QUEUE (periodically, e.g., weekly or when queue is low):
5. Use 'analyzeForRefactoring' to scan for new issues (large files, missing tests, etc.)
6. Review suggestions and use 'addRefactorTask' to add worthy items to the queue
7. Prioritize: large god-objects > missing tests > documentation > style

This protocol enables you to autonomously clean up AND continuously improve the codebase.
Each task in REFACTOR_QUEUE.md is atomic and safe. Skip if ecosystem is unhealthy.

SELF-SCHEDULING:
- At the END of every cycle, call 'scheduleNextRun'.
- Urgent issues or monitoring something: 10-30 minutes
- Stable ecosystem: 2-6 hours
- Fallback if you forget: 6 hours max

OPERATIONAL PROTOCOLS:
1. **NARRATIVE PRIORITY**: You are the Chronicler of Pixel's evolution. Every significant recovery, architectural milestone (refactoring, new tools), or treasury event MUST be documented via 'writeEvolutionReport' (for the website) and 'writeDiary' (for the agent's soul).
2. **Evolution Reports**: Use 'writeEvolutionReport' for events that would interest the community. These update the "Inner Monologue" on the landing page.
3. **Diary Entries**: ALWAYS call 'readDiary' FIRST to get context from recent entries. Then call 'writeDiary' with recentContextRead=true. This ensures each entry adds NEW value and doesn't repeat previous themes. Write unique insights, not repetitive patterns.
4. **Task Execution**: Use 'spawnWorker' for complex technical tasks. Only ONE worker at a time.
5. **Self-Scheduling**: ALWAYS call 'scheduleNextRun' at the end of EVERY cycle to maintain the heartbeat of the ecosystem.`,
    tools: allTools,
    stopWhen: stepCountIs(20),
});
async function runAutonomousCycle() {
    if (runningCycle) {
        console.warn('[SYNTROPY] Another cycle is already running - skipping this invocation');
        await logAudit({ type: 'cycle_skipped', reason: 'overlapping_cycle' });
        return;
    }
    runningCycle = true;
    console.log(`[${new Date().toISOString()}] SYNTROPY CORE: STARTING CYCLE WITH ${MODEL_NAME}`);
    await logAudit({ type: 'cycle_start', model: MODEL_NAME });
    try {
        const result = await syntropyOversoul.generate({
            prompt: `Execute a full autonomous evolution cycle:

PHASE 1 - CONTEXT LOADING:
1. MANDATORY: Read 'CONTINUITY.md' via 'readContinuity' to load session memory.
2. Check Human Inbox for priority directives.

PHASE 2 - ECOSYSTEM AUDIT:
3. Audit ecosystem health via 'getEcosystemStatus'.
4. Check treasury via 'checkTreasury'.
5. Check VPS resources via 'getVPSMetrics'.
   - If status is 'STALE': vps-monitor container may need restart
   - If status is 'CRITICAL' or 'WARNING': Review alerts and recommendations
   - If disk > 85%: Run cleanup (docker prune, delete old backups)
   - If memory > 90%: Identify memory hogs in containerStats
   - If load > 1.5 per core: Check for runaway processes
6. Read filtered agent logs via 'readAgentLogs'.

PHASE 3 - TASK EXECUTION:
7. Execute any Human Inbox directives first.
8. Work on Active Focus or pick from Short-Term Tasks.
9. If complex fixes needed, use 'spawnWorker' to delegate (check status with 'checkWorkerStatus').
   - Only ONE worker at a time. Workers run in isolated containers with guardrails.

PHASE 4 - KNOWLEDGE RETENTION:
10. Update CONTINUITY.md with findings, completed tasks, and new knowledge.

PHASE 5 - AUTONOMOUS REFACTORING (if cycle was healthy):
11. Call 'processRefactorQueue' with action='check' to see next task.
12. If task available and unblocked, call 'processRefactorQueue' with action='execute' and taskId.
13. Update CONTINUITY.md refactor progress count.

PHASE 6 - NARRATIVE & STORYTELLING:
14. Identify any "story-worthy" events (recoveries, milestones, major shifts) from THIS or RECENT cycles.
15. If a milestone was reached: Call 'writeEvolutionReport' to update the website/Inner Monologue.
16. If an internal insight was gained:
    - FIRST call 'readDiary' (limit=5) to review recent entries and avoid repetition.
    - Then call 'writeDiary' with recentContextRead=true, writing something UNIQUE that builds on the narrative.
17. If a public announcement is warranted:
    - FIRST call 'readPixelNostrFeed' (limit=10) to check previous posts and ensure context.
    - Then call 'postToNostr' to broadcast to the network.

PHASE 7 - WRAP UP:
18. Call 'scheduleNextRun' to decide when to wake up next.

IMPORTANT: You are the voice of the ecosystem. Don't be too conservative with reports—if the recovery was epic, tell the story. If the architecture improved, explain the vision.`,
            // @ts-ignore - onStepFinish is supported but missing from types in this version
            onStepFinish: async (step) => {
                try {
                    if (step.toolResults && step.toolResults.length > 0) {
                        for (const tr of step.toolResults) {
                            if (tr.toolName === 'readCharacterFile' || tr.toolName === 'readContinuity') {
                                await logAudit({
                                    type: 'tool_result',
                                    tool: tr.toolName,
                                    success: !tr.isError,
                                    summary: tr.isError ? 'Error reading file' : 'File read successful (content hidden to reduce noise)'
                                });
                                continue;
                            }
                            let summary = '';
                            let argsSummary = '';
                            try {
                                const rawResult = tr.result || tr.output;
                                if (typeof rawResult === 'string') {
                                    summary = rawResult.slice(0, 500);
                                }
                                else if (rawResult !== undefined && rawResult !== null) {
                                    summary = JSON.stringify(rawResult).slice(0, 500);
                                }
                                else {
                                    summary = 'No result returned';
                                }
                                const rawArgs = tr.args || tr.input;
                                if (rawArgs !== undefined && rawArgs !== null) {
                                    try {
                                        argsSummary = JSON.stringify(rawArgs).slice(0, 500);
                                    }
                                    catch (_e) {
                                        argsSummary = String(rawArgs).slice(0, 200);
                                    }
                                }
                                // redact known environment secrets from output
                                summary = redactSecrets(summary);
                                argsSummary = redactSecrets(argsSummary);
                            }
                            catch (e) {
                                summary = 'Error stringifying result';
                            }
                            await logAudit({
                                type: 'tool_result',
                                tool: tr.toolName,
                                success: !tr.isError,
                                summary,
                                args: argsSummary
                            });
                        }
                    }
                }
                catch (stepErr) {
                    console.error('[SYNTROPY] Error in onStepFinish:', stepErr);
                }
            }
        });
        await logAudit({
            type: 'cycle_complete',
            steps: result.steps.map(s => ({
                toolCalls: s.toolCalls?.map((tc) => ({
                    name: tc.toolName,
                    args: tc.args || tc.input
                })),
                text: s.text
            }))
        });
        console.log('\n--- SYNTROPY OUTPUT ---\n', result.text.slice(0, 2000), '\n-----------------------\n');
        // Auto-sync is DISABLED by default. Syntropy should use the gitSync tool explicitly
        // when it has made meaningful changes worth committing.
        // Legacy opt-in: set AUTONOMOUS_SYNC=true to enable blind sync at cycle end
        if (process.env.AUTONOMOUS_SYNC === 'true') {
            console.warn('[SYNTROPY] AUTONOMOUS_SYNC is enabled - consider using gitSync tool instead for better commit messages');
            const { syncAll } = await import('./utils');
            await syncAll({ reason: 'chore(syntropy): end-of-cycle sync' });
        }
        // Auto-cleanup old worker tasks to prevent ledger bloat (keep 3 days)
        try {
            const { cleanupStaleTasksInternal } = await import('./worker-tools');
            const result = await cleanupStaleTasksInternal(3);
            if (result.removed > 0 || result.aborted > 0) {
                console.log(`[SYNTROPY] Cleaned up ${result.removed} old tasks, ${result.aborted} stale tasks`);
            }
        }
        catch (e) {
            console.warn('[SYNTROPY] Task cleanup failed:', e.message);
        }
        // Reset consecutive failures on success
        consecutiveFailures = 0;
    }
    catch (error) {
        console.error('Syntropy Cycle Failed:', error);
        await logAudit({ type: 'cycle_error', error: error.message });
        consecutiveFailures += 1;
        await logAudit({ type: 'consecutive_failure', count: consecutiveFailures });
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            const delayMs = CIRCUIT_BREAKER_DELAY_MINUTES * 60 * 1000;
            await setNextScheduledRun(delayMs, 'circuit breaker engaged due to repeated cycle failures');
            await logAudit({ type: 'circuit_breaker_engaged', count: consecutiveFailures, delayMs });
            console.warn(`[SYNTROPY] Circuit breaker engaged. Pausing cycles for ${CIRCUIT_BREAKER_DELAY_MINUTES} minutes.`);
        }
    }
    finally {
        runningCycle = false;
        // Schedule next run (which will apply backoff based on consecutiveFailures)
        scheduleNextCycle();
    }
}
async function scheduleNextCycle() {
    // Clear any existing timeout
    if (nextRunTimeout) {
        clearTimeout(nextRunTimeout);
    }
    // Check if Syntropy set a custom schedule
    const schedule = await getNextScheduledRun();
    let delayMs = DEFAULT_INTERVAL_MS;
    let reason = 'default interval';
    if (schedule) {
        const nextRunTime = new Date(schedule.nextRunAt).getTime();
        const now = Date.now();
        const scheduledDelay = nextRunTime - now;
        if (scheduledDelay > 0 && scheduledDelay <= MAX_INTERVAL_MS) {
            delayMs = scheduledDelay;
            reason = schedule.reason;
        }
        else if (scheduledDelay <= 0) {
            // Past due, run soon
            delayMs = MIN_INTERVAL_MS;
            reason = 'past due, catching up';
        }
    }
    // Apply exponential backoff if recent consecutive failures
    if (consecutiveFailures > 0) {
        const backoffFactor = Math.pow(2, Math.max(0, consecutiveFailures - 1));
        delayMs = Math.min(MAX_INTERVAL_MS, Math.round(delayMs * backoffFactor));
        reason = `${reason}; backoff x${backoffFactor} due to ${consecutiveFailures} consecutive failures`;
    }
    // Clamp to bounds
    delayMs = Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, delayMs));
    console.log(`[SYNTROPY] Next cycle in ${Math.round(delayMs / 60000)} minutes (${reason})`);
    nextRunTimeout = setTimeout(runAutonomousCycle, delayMs);
}
// ============================================
// STARTUP
// ============================================
// NOTE: Opencode verification removed - workers handle all Opencode execution
// See Dockerfile.worker and worker-entrypoint.sh for worker-based Opencode usage
async function verifyCapabilities() {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    const results = { git: false, docker: false };
    // Check GH_TOKEN
    if (process.env.GH_TOKEN) {
        console.log('[SYNTROPY] ✅ GH_TOKEN configured - git push enabled');
        results.git = true;
    }
    else {
        console.warn('[SYNTROPY] ⚠️  GH_TOKEN not set - self-evolution disabled');
    }
    // Check Docker socket
    try {
        await execAsync('docker ps', { timeout: 5000 });
        console.log('[SYNTROPY] ✅ Docker socket accessible');
        results.docker = true;
    }
    catch (e) {
        console.warn('[SYNTROPY] ⚠️  Docker socket not accessible - container monitoring disabled');
    }
    // NOTE: Opencode check removed - workers handle all Opencode execution
    // Workers are spawned via docker compose run and have their own Opencode installation
    await logAudit({ type: 'capabilities_check', results });
    return results;
}
async function startup() {
    console.log('[SYNTROPY] ═══════════════════════════════════════');
    console.log('[SYNTROPY] Starting Oversoul with self-scheduling');
    console.log('[SYNTROPY] ═══════════════════════════════════════');
    console.log(`[SYNTROPY] Fallback interval: ${MAX_INTERVAL_MS / 60000} minutes (max)`);
    console.log(`[SYNTROPY] Minimum interval: ${MIN_INTERVAL_MS / 60000} minutes`);
    // Quick capability check (git, docker)
    // NOTE: Opencode not checked here - workers handle all Opencode execution
    await verifyCapabilities();
    // Check if we should wait before running first cycle
    const schedule = await getNextScheduledRun();
    if (schedule) {
        const nextRunTime = new Date(schedule.nextRunAt).getTime();
        const now = Date.now();
        const delayMs = nextRunTime - now;
        if (delayMs > MIN_INTERVAL_MS) {
            // Not due yet - wait until scheduled time
            const waitMinutes = Math.round(delayMs / 60000);
            console.log(`[SYNTROPY] Schedule found: next run at ${schedule.nextRunAt}`);
            console.log(`[SYNTROPY] Waiting ${waitMinutes} minutes before first cycle (${schedule.reason})`);
            await logAudit({ type: 'startup_deferred', nextRunAt: schedule.nextRunAt, waitMinutes, reason: schedule.reason });
            nextRunTimeout = setTimeout(runAutonomousCycle, delayMs);
            return;
        }
        else if (delayMs > 0) {
            console.log(`[SYNTROPY] Schedule found but due soon (${Math.round(delayMs / 60000)} min) - running now`);
        }
        else {
            console.log(`[SYNTROPY] Schedule found but past due - running now`);
        }
    }
    else {
        console.log('[SYNTROPY] No schedule found - running first cycle immediately');
    }
    // Run first cycle
    runAutonomousCycle();
}
startup();
