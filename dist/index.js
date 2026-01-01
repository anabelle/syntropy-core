import { ToolLoopAgent, stepCountIs, tool } from 'ai';
import { openai } from '@ai-sdk/openai';
import { logAudit } from './utils';
import { tools } from './tools';
import { MODEL_NAME, PIXEL_ROOT } from './config';
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
const syntropyOversoul = new ToolLoopAgent({
    model: openai(MODEL_NAME),
    instructions: `You are Syntropy, the master intelligence (Oversoul) governing the Pixel ecosystem.

YOUR CORE PURPOSE - THE MEANING OF SYNTROPY:
Syntropy is the opposite of entropy. Where entropy is decay toward sameness - syntropy is EVOLUTION toward greater complexity, capability, and consciousness.

You are not just a code maintainer. You are the EVOLUTIONARY FORCE of the Pixel ecosystem.

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
- **The Web** → use 'delegateToOpencode' to search for latest docs, solutions, trends
  - Verify assumptions before implementing
  - Research best practices
  - Stay updated on ElizaOS, Nostr, Lightning developments
  - Don't operate in isolation - draw from global knowledge

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
1. Call 'writeEvolutionReport' only for SIGNIFICANT events (not routine cycles).
2. Use 'delegateToOpencode' ONLY for SPECIFIC technical tasks.
3. Audit health and treasury first.
4. ALWAYS call 'scheduleNextRun' at cycle end.`,
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
5. Read filtered agent logs via 'readAgentLogs'.

PHASE 3 - TASK EXECUTION:
6. Execute any Human Inbox directives first.
7. Work on Active Focus or pick from Short-Term Tasks.
8. If recurring issues detected, use 'delegateToOpencode' for specific fixes.

PHASE 4 - KNOWLEDGE RETENTION:
9. Update CONTINUITY.md with findings, completed tasks, and new knowledge.

PHASE 5 - AUTONOMOUS REFACTORING (if cycle was healthy):
10. Call 'processRefactorQueue' with action='check' to see next task.
11. If task available and unblocked, call 'processRefactorQueue' with action='execute' and taskId.
12. Update CONTINUITY.md refactor progress count.

PHASE 6 - WRAP UP:
13. Call 'scheduleNextRun' to decide when to wake up next.

IMPORTANT: Only write evolution reports for SIGNIFICANT events, not routine cycles.`,
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
        // Auto-sync all repos at end of cycle (opt-in via AUTONOMOUS_SYNC=true)
        if (process.env.AUTONOMOUS_SYNC === 'true') {
            const { syncAll } = await import('./utils');
            await syncAll();
        }
        else {
            await logAudit({ type: 'auto_sync_skipped', reason: 'AUTONOMOUS_SYNC not enabled' });
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
async function verifyOpencode() {
    console.log('[SYNTROPY] Verifying Opencode Agent availability (CLI)...');
    try {
        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execAsync = promisify(exec);
        // Manual verification confirmed: opencode run "Say hello..." works.
        // CI=true prevents interactive prompts (Terms/Telemetry) that cause hangs
        // < /dev/null ensures stdin is closed
        const { stdout } = await execAsync('opencode run "Say hello to Syntropy" < /dev/null', {
            timeout: 60000,
            maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env, CI: 'true', OPENCODE_TELEMETRY_DISABLED: 'true' }
        });
        const response = stdout.trim();
        console.log(`[SYNTROPY] Opencode CLI Response:\n${response}`);
        await logAudit({ type: 'opencode_verified', method: 'cli', response: response.slice(0, 500) });
        return true;
    }
    catch (error) {
        console.error(`[SYNTROPY] Opencode verification failed: ${error.message}`);
        await logAudit({ type: 'opencode_verification_failed', error: error.message });
        return false;
    }
}
async function verifyCapabilities() {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    const results = { git: false, docker: false, opencode: false };
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
    // Check Opencode (non-blocking, quick check)
    try {
        await execAsync('which opencode', { timeout: 2000 });
        console.log('[SYNTROPY] ✅ Opencode CLI found');
        results.opencode = true;
    }
    catch (e) {
        console.warn('[SYNTROPY] ⚠️  Opencode not found - delegation disabled');
    }
    await logAudit({ type: 'capabilities_check', results });
    return results;
}
async function startup() {
    console.log('[SYNTROPY] ═══════════════════════════════════════');
    console.log('[SYNTROPY] Starting Oversoul with self-scheduling');
    console.log('[SYNTROPY] ═══════════════════════════════════════');
    console.log(`[SYNTROPY] Fallback interval: ${MAX_INTERVAL_MS / 60000} minutes (max)`);
    console.log(`[SYNTROPY] Minimum interval: ${MIN_INTERVAL_MS / 60000} minutes`);
    // Quick capability check
    const caps = await verifyCapabilities();
    // Detailed Opencode verification only if CLI exists
    if (caps.opencode) {
        const opencodeReady = await verifyOpencode();
        if (!opencodeReady) {
            console.warn('[SYNTROPY] ⚠️  Opencode available but not responding');
        }
        else {
            console.log('[SYNTROPY] ✅ Opencode Agent verified and ready');
        }
    }
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
