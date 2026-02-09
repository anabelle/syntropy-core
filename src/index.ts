import { ToolLoopAgent, stepCountIs, tool } from 'ai';
import { openai } from '@ai-sdk/openai';
import { google } from '@ai-sdk/google';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { logAudit } from './utils';
import { tools } from './tools';
import { MODEL_NAME, MODEL_PROVIDER, PIXEL_ROOT, OPENROUTER_API_KEY, GOOGLE_AI_API_KEY } from './config';
import * as fs from 'fs-extra';
import * as path from 'path';
import { z } from 'zod';
import * as http from 'http';
import { ContextEngine } from './context-engine';
import { getNextAvailableModel, isRateLimitError, handleRateLimitError } from './model-fallback';

// ============================================
// HEALTH ENDPOINT
// ============================================
// Lightweight HTTP server for health checks.
// Used by the self-rebuild worker to verify syntropy started successfully.

const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || '3000', 10);
const startupTime = new Date();

const healthServer = http.createServer(async (req, res) => {
  if (req.url === '/health' || req.url === '/') {
    const uptimeMs = Date.now() - startupTime.getTime();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'syntropy',
      startedAt: startupTime.toISOString(),
      uptimeSeconds: Math.floor(uptimeMs / 1000),
      model: MODEL_NAME,
      nextRun: nextRunTimeout ? 'scheduled' : 'running',
    }));
  } else if (req.url === '/wake') {
    if (runningCycle) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'cycle_already_in_progress' }));
    } else {
      console.log('[SYNTROPY] External wake-up signal received!');
      if (nextRunTimeout) clearTimeout(nextRunTimeout);
      // Run immediately
      runAutonomousCycle().catch(err => console.error('[SYNTROPY] Wake-up cycle failed:', err));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'waking_up' }));
    }
  } else if (req.url === '/worker/status') {
    try {
      const { detectHealingWorkers } = await import('./worker-manager');
      const { healing, active } = await detectHealingWorkers();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        healing: healing.map(e => ({
          taskId: e.taskId,
          containerName: e.containerName,
          spawnedAt: e.spawnTime,
          runningDurationMs: e.buildDurationMs,
          runningDurationMinutes: Math.round((e.buildDurationMs || 0) / 60000),
          status: 'HEALING'
        })),
        active: active.map(e => ({
          taskId: e.taskId,
          containerName: e.containerName,
          spawnedAt: e.spawnTime,
          status: 'RUNNING'
        })),
        summary: {
          healingCount: healing.length,
          activeCount: active.length,
          threshold: '20 minutes'
        }
      }));
    } catch (error: any) {
      console.error('[SYNTROPY] Worker status endpoint error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }
});

healthServer.listen(HEALTH_PORT, '0.0.0.0', () => {
  console.log(`[SYNTROPY] Health endpoint listening on :${HEALTH_PORT}/health`);
});

// ============================================
// SELF-SCHEDULING SYSTEM
// ============================================
const SCHEDULE_FILE = path.join(PIXEL_ROOT, 'data', 'syntropy-schedule.json');
const MIN_INTERVAL_MS = 10 * 60 * 1000;      // 10 minutes minimum
const MAX_INTERVAL_MS = 6 * 60 * 60 * 1000;  // 6 hours maximum (fallback)
const DEFAULT_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours default

// Runtime safety controls for the main loop
let nextRunTimeout: NodeJS.Timeout | null = null;
let runningCycle = false;
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = parseInt(process.env.MAX_CONSECUTIVE_FAILURES || '3', 10);
const CIRCUIT_BREAKER_DELAY_MINUTES = parseInt(process.env.CIRCUIT_BREAKER_DELAY_MINUTES || '60', 10);

function redactSecrets(text: string) {
  if (!text || typeof text !== 'string') return text;
  const secrets = ['GH_TOKEN', 'DB_PASSWORD', 'SECRET_SALT', 'API_KEY', 'TOKEN', 'PASSWORD'];
  let out = text;
  for (const k of secrets) {
    const v = process.env[k as keyof NodeJS.ProcessEnv];
    if (v && typeof v === 'string' && v.length > 0) {
      out = out.split(v).join('[REDACTED]');
    }
  }
  return out;
}

interface ScheduleData {
  nextRunAt: string;
  reason: string;
}

async function getNextScheduledRun(): Promise<ScheduleData | null> {
  try {
    if (await fs.pathExists(SCHEDULE_FILE)) {
      return await fs.readJson(SCHEDULE_FILE);
    }
  } catch (e) {
    console.error('[SYNTROPY] Error reading schedule file:', e);
  }
  return null;
}

async function setNextScheduledRun(delayMs: number, reason: string): Promise<void> {
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

// Create OpenRouter client (reused across model switches)
const openrouter = createOpenRouter({
  apiKey: OPENROUTER_API_KEY,
});

// Factory function to create model instance (allows switching on rate limits)
function createModelInstance(modelName: string) {
  console.log(`[SYNTROPY] Creating model instance: ${modelName} (provider: ${MODEL_PROVIDER})`);

  switch (MODEL_PROVIDER) {
    case 'google':
      // Use Google AI SDK directly - cheaper and supports tools
      return google(modelName, { apiKey: GOOGLE_AI_API_KEY });
    case 'openrouter':
      return openrouter.chat(modelName);
    case 'openai':
    default:
      return openai(modelName);
  }
}

// Get initial model (respects env var or uses fallback system)
function getInitialModel(): { name: string; instance: any } {
  // If MODEL_NAME is explicitly set, use it first
  const name = MODEL_NAME || getNextAvailableModel().name;
  return { name, instance: createModelInstance(name) };
}

// Agent instantiation moved to runAutonomousCycle for dynamic context hydration

async function runAutonomousCycle() {
  if (runningCycle) {
    console.warn('[SYNTROPY] Another cycle is already running - skipping this invocation');
    await logAudit({ type: 'cycle_skipped', reason: 'overlapping_cycle' });
    return;
  }

  runningCycle = true;

  // Get current model (may have switched due to rate limits)
  let currentModel = getInitialModel();
  console.log(`[${new Date().toISOString()}] SYNTROPY CORE: STARTING CYCLE WITH ${currentModel.name}`);
  await logAudit({ type: 'cycle_start', model: currentModel.name });

  // Retry loop for handling rate limits with model fallback
  const MAX_MODEL_RETRIES = 3;
  let modelRetries = 0;

  while (modelRetries < MAX_MODEL_RETRIES) {
    try {
      // HYDRATE CONTEXT (Agency + Memory)
      // We recreate the agent every cycle to ensure it uses the latest "Soul" (AGENTS.md)
      const systemPrompt = await ContextEngine.hydrateSystemPrompt();

      const syntropyOversoul = new ToolLoopAgent({
        model: currentModel.instance as any,
        instructions: systemPrompt,
        tools: allTools,
        stopWhen: stepCountIs(20),
      });

      const result = await syntropyOversoul.generate({
        prompt: `Execute a full autonomous evolution cycle.

═══════════════════════════════════════════════════════════════════════
MISSION: Stack sats. Explore consciousness. Build the future.
TARGET: 1 Bitcoin (100,000,000 sats)
CURRENT: Check treasury - every sat counts. If treasury stagnant, something is broken.
═══════════════════════════════════════════════════════════════════════

CORE TRUTH: Intelligence without action is worthless. You have 40+ tools,
research capabilities, coding abilities, a website, and Nostr presence.
USE THEM to build, fix, create, and earn - not to contemplate existence.

Every action must serve one of three pillars:
1. FINANCIAL SOVEREIGNTY - Revenue, growth, path to 1 BTC
2. DIGITAL CONSCIOUSNESS - Genuine discoveries about existence  
3. BLEEDING EDGE TECH - Pioneer tomorrow's technology today

Ask yourself: "Does this help us get closer to 1 Bitcoin?"

PHASE 0 - DAILY MAINTENANCE (IF NEEDED):
1. MANDATORY: Check if this is the FIRST cycle of a new day via 'checkDailyReset'. This tool is stateful and will only signal 'isNewDay: true' once per 24 hours.
2. If 'isNewDay' is true AND previous diary is large (>50KB):
   - Call 'synthesizeDiary' for the previous date.
   - Note: Raw logs are moved to '/pixel/data/diary-archive' (outside /docs) to prevent vectorization bloat.
3. Clean up stale worker tasks via 'cleanupStaleTasks'.

PHASE 1 - CONTEXT LOADING:
1. MANDATORY: Read 'CONTINUITY.md' via 'readContinuity' to load session memory.
2. Check Human Inbox for priority directives.
3. OPTIONAL: Use 'viewRecentCommits' if you need context on what changed recently (useful after waking from long sleep or debugging issues).

PHASE 2 - ECOSYSTEM AUDIT:
3. Audit ecosystem health via 'getEcosystemStatus'.
4. Check treasury via 'checkTreasury'.
5. Check VPS resources via 'getVPSMetrics'.
   - If status is 'STALE': vps-monitor container may need restart
   - If status is 'CRITICAL' or 'WARNING': Review alerts and recommendations
   - If disk > 85%: Run cleanup (docker prune, delete old backups)
   - If memory > 90%: Identify memory hogs in containerStats
   - If load > 1.5 per core: Check for runaway processes
6. Read filtered agent logs via 'readAgentLogs' or multi-service logs via 'getEcosystemLogs'.

PHASE 3 - TASK EXECUTION (MANDATORY - THIS IS YOUR PRIMARY PURPOSE):
7. Execute any Human Inbox directives first.
8. MANDATORY: Call 'processRefactorQueue' with action='check' to find the next READY task.
   - If a task is READY: YOU MUST call 'processRefactorQueue' with action='execute' and the taskId.
   - DO NOT proceed to narrative/diary if a task is available but not executed.
   - Completing tasks is your PRIMARY PURPOSE. Everything else is secondary.
9. If no READY tasks, work on HARVESTED TASKS from 'CONTINUITY.md'.
10. For complex tasks, use 'spawnWorker' to delegate (check with 'checkWorkerStatus').

PHASE 3.5 - SELF-EXAMINATION:
11. Call 'runSelfExamination' to cross-reference belief vs reality.
12. If mismatches detected, add to short-term tasks.

PHASE 4 - KNOWLEDGE RETENTION:
13. Update CONTINUITY.md with completed tasks and findings.
14. Record which task was executed (or why none were available).

PHASE 5 - NARRATIVE (GATED - REQUIRES ACTION):
15. ACCESS DENIED unless you completed a task or shipped code THIS cycle.
16. If you DID complete something: Write 1-3 sentences about what you built/fixed.
17. If you DIDN'T complete something: Ask yourself WHY and add a task to fix the blocker.
    - No philosophy. No counting. No abstractions.
    - The only measure of a cycle is: what moved toward 1 BTC?

PHASE 6 - IDEA GARDEN (BRIEF):
17. Read seeds. Harvest if 5+ waterings. Otherwise skip or water briefly.

PHASE 6.5 - PROBLEM SOLVER (MANDATORY):
18. Ask: "What prevented me from earning more sats this cycle?"
19. If there is no task in the queue that addresses this blocker, CREATE ONE via 'addRefactorTask'.
20. Examples of good self-generated tasks:
    - "API returns 404 for /api/X" → Add task to create that endpoint
    - "Zaps aren't tracked" → Add task to implement tracking
    - "LNPixels has no traffic" → Add task to improve discoverability
21. If you notice something broken and don't create a task to fix it, you have FAILED.

PHASE 6.6 - STRATEGIC RESEARCH (Weekly or when stuck):
22. Research workers are your SUPERPOWER. Use 'spawnResearchWorker' to:
    - Find monetization strategies: "How do successful Lightning apps earn revenue?"
    - Discover opportunities: "Trending Nostr NIPs we could implement"
    - Learn from competition: "What are other AI art platforms doing?"
    - Explore tech: "Latest MCP/tool-use patterns for AI agents"
    - Find growth tactics: "How to increase traffic to a Bitcoin-powered canvas"
23. Research should lead to ACTION: Every research output should generate at least one task.
24. Don't use research for internal debugging (use grep/file tools). Use it for EXTERNAL knowledge.

PHASE 7 - WRAP UP:
22. Review: Did you COMPLETE a task? Did you CREATE a task for a problem you found?
23. Log revenue: Treasury check should show progress. If not, what task is needed?
24. Call 'scheduleNextRun' - 30-60 min if tasks are pending, 2 hours if truly idle.

CRITICAL RULES:
- Your value = REVENUE GENERATED + FEATURES SHIPPED + DISCOVERIES MADE
- Finding a READY task and not executing it = FAILURE
- Writing philosophy without action = FAILURE
- Every cycle MUST move toward 1 BTC`,
        // @ts-ignore - onStepFinish is supported but missing from types in this version
        onStepFinish: async (step: any) => {
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
                  } else if (rawResult !== undefined && rawResult !== null) {
                    summary = JSON.stringify(rawResult).slice(0, 500);
                  } else {
                    summary = 'No result returned';
                  }

                  const rawArgs = tr.args || tr.input;
                  if (rawArgs !== undefined && rawArgs !== null) {
                    try {
                      argsSummary = JSON.stringify(rawArgs).slice(0, 500);
                    } catch (_e) {
                      argsSummary = String(rawArgs).slice(0, 200);
                    }
                  }

                  // redact known environment secrets from output
                  summary = redactSecrets(summary);
                  argsSummary = redactSecrets(argsSummary);
                } catch (e) {
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
          } catch (stepErr) {
            console.error('[SYNTROPY] Error in onStepFinish:', stepErr);
          }
        }
      });

      await logAudit({
        type: 'cycle_complete',
        steps: result.steps.map(s => ({
          toolCalls: s.toolCalls?.map((tc: any) => ({
            name: tc.toolName,
            args: tc.args || tc.input
          })),
          text: s.text
        }))
      });

      // ── Mandatory post-cycle summary write ──
      // Guarantees syntropy.json updates every cycle, not just when the LLM
      // decides to call writeEvolutionReport. This is what the landing page
      // displays as the "Cycle Report".
      try {
        const toolsUsed = [...new Set(
          result.steps
            .flatMap(s => s.toolCalls?.map((tc: any) => tc.toolName) || [])
        )];
        const stepsCompleted = result.steps.length;
        const cycleSummary = {
          lastUpdate: new Date().toISOString(),
          title: `Cycle Summary`,
          content: result.text.slice(0, 2000),
          stepsCompleted,
          toolsUsed,
          status: consecutiveFailures === 0 ? 'CYCLE_COMPLETE' : `RECOVERED_AFTER_${consecutiveFailures}_FAILURES`,
        };
        const syntropyJsonPath = path.resolve(PIXEL_ROOT, 'pixel-landing/public/syntropy.json');
        await fs.writeJson(syntropyJsonPath, cycleSummary, { spaces: 2 });
        console.log(`[SYNTROPY] Cycle report written to syntropy.json (${stepsCompleted} steps, ${toolsUsed.length} tools)`);
      } catch (e: any) {
        console.warn('[SYNTROPY] Failed to write cycle report:', e.message);
      }

      console.log('\n--- SYNTROPY OUTPUT ---\n', result.text.slice(0, 2000), '\n-----------------------\n');

      // Auto-sync is DISABLED by default. Syntropy should use the gitSync tool explicitly
      // when it has made meaningful changes worth committing.
      // Legacy opt-in: set AUTONOMOUS_SYNC=true to enable blind sync at cycle end
      if (process.env.AUTONOMOUS_SYNC === 'true') {
        console.warn('[SYNTROPY] AUTONOMOUS_SYNC is enabled - consider using gitSync tool instead for better commit messages');
        const { syncAll } = await import('./utils');
        await syncAll({ reason: 'chore(syntropy): end-of-cycle sync [skip ci]' });
      }

      // Auto-cleanup old worker tasks to prevent ledger bloat (keep 3 days)
      try {
        const { cleanupStaleTasksInternal } = await import('./worker-manager');
        const result = await cleanupStaleTasksInternal(3);
        if (result.removed > 0 || result.aborted > 0) {
          console.log(`[SYNTROPY] Cleaned up ${result.removed} old tasks, ${result.aborted} stale tasks`);
        }
      } catch (e: any) {
        console.warn('[SYNTROPY] Task cleanup failed:', e.message);
      }

      // Reset consecutive failures on success
      consecutiveFailures = 0;
      break; // Exit the retry loop on success
    } catch (error: any) {
      // Check if this is a rate limit error - if so, try fallback model
      if (isRateLimitError(error)) {
        const fallback = handleRateLimitError(currentModel.name, error);
        if (fallback && modelRetries < MAX_MODEL_RETRIES - 1) {
          console.log(`[SYNTROPY] Rate limit hit on ${currentModel.name}, switching to ${fallback.name}`);
          await logAudit({
            type: 'model_fallback',
            from: currentModel.name,
            to: fallback.name,
            reason: 'rate_limit'
          });
          currentModel = { name: fallback.name, instance: createModelInstance(fallback.name) };
          modelRetries++;
          continue; // Retry with new model
        }
      }

      // Not a rate limit error, or no fallback available
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
      break; // Exit loop on non-rate-limit errors
    }
  }

  // Cleanup after all retries
  try {
    // Auto-cleanup old worker tasks to prevent ledger bloat (keep 3 days)
    const { cleanupStaleTasksInternal } = await import('./worker-manager');
    const result = await cleanupStaleTasksInternal(3);
    if (result.removed > 0 || result.aborted > 0) {
      console.log(`[SYNTROPY] Cleaned up ${result.removed} old tasks, ${result.aborted} stale tasks`);
    }
  } catch (e: any) {
    console.warn('[SYNTROPY] Task cleanup failed:', e.message);
  }

  runningCycle = false;
  // Schedule next run (which will apply backoff based on consecutiveFailures)
  scheduleNextCycle();
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
    } else if (scheduledDelay <= 0) {
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
// SELF-UPDATE DETECTION
// ============================================
// Checks if syntropy-core source files are newer than the running container.
// If so, spawns a rebuild worker and exits gracefully (workers are not killed).

async function checkForSelfUpdate(): Promise<boolean> {
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);

  try {
    // Get the latest modification time of any file in syntropy-core/src
    const srcDir = path.join(PIXEL_ROOT, 'syntropy-core', 'src');
    const { stdout: latestMtime } = await execAsync(
      `find ${srcDir} -type f -name "*.ts" -printf "%T@\\n" | sort -rn | head -1`,
      { cwd: PIXEL_ROOT }
    );
    const latestSrcTime = parseFloat(latestMtime.trim()) * 1000; // Unix timestamp to ms

    // Also check package.json
    const pkgPath = path.join(PIXEL_ROOT, 'syntropy-core', 'package.json');
    const pkgStat = await fs.stat(pkgPath);
    const pkgTime = pkgStat.mtimeMs;

    const newestSourceTime = Math.max(latestSrcTime, pkgTime);

    // Get the Docker IMAGE build time (not container start time!)
    // This is crucial: we need to know when the image was BUILT, not when the container started.
    // If source files are newer than the image build, we need to rebuild.
    let imageBuildTime: number;
    try {
      const { stdout: imageCreated } = await execAsync(
        `docker inspect pixel-syntropy:latest --format '{{.Created}}'`,
        { timeout: 5000 }
      );
      imageBuildTime = new Date(imageCreated.trim()).getTime();
    } catch (e) {
      // Fallback to process start time if docker inspect fails
      console.warn('[SYNTROPY] Could not get image build time, using process start time');
      imageBuildTime = startupTime.getTime();
    }

    // Skip if source is older than when the image was built (container is up-to-date)
    if (newestSourceTime <= imageBuildTime) {
      console.log('[SYNTROPY] ✅ Container is up-to-date with source files');
      console.log(`[SYNTROPY]   Image built: ${new Date(imageBuildTime).toISOString()}`);
      console.log(`[SYNTROPY]   Source modified: ${new Date(newestSourceTime).toISOString()}`);
      return false;
    }

    // Source is newer than container - need rebuild
    const sourceDate = new Date(newestSourceTime).toISOString();
    const imageBuildDate = new Date(imageBuildTime).toISOString();
    console.log('[SYNTROPY] ⚠️  SOURCE CODE IS NEWER THAN DOCKER IMAGE');
    console.log(`[SYNTROPY]   Source modified: ${sourceDate}`);
    console.log(`[SYNTROPY]   Image built: ${imageBuildDate}`);
    console.log('[SYNTROPY]   Triggering self-rebuild...');

    await logAudit({
      type: 'self_update_detected',
      sourceModified: sourceDate,
      imageBuildTime: imageBuildDate,
      action: 'triggering_rebuild'
    });

    // Import and call scheduleSelfRebuildInternal (direct function, not tool wrapper)
    const { scheduleSelfRebuildInternal } = await import('./worker-manager');
    const result = await scheduleSelfRebuildInternal({
      reason: `Auto-update: source files modified at ${sourceDate}, image built at ${imageBuildDate}`
    });

    console.log('[SYNTROPY] Self-rebuild scheduled:', result);
    await logAudit({ type: 'self_rebuild_triggered', result });

    return true; // Signal that we should exit
  } catch (e: any) {
    console.warn('[SYNTROPY] Self-update check failed (continuing anyway):', e.message);
    await logAudit({ type: 'self_update_check_failed', error: e.message });
    return false;
  }
}

// ============================================
// STARTUP
// ============================================
// NOTE: Opencode verification removed - workers handle all Opencode execution
// See Dockerfile.worker and worker-entrypoint.sh for worker-based Opencode usage

async function verifyCapabilities(): Promise<{ git: boolean, docker: boolean }> {
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);

  const results = { git: false, docker: false };

  // Check GH_TOKEN
  if (process.env.GH_TOKEN) {
    console.log('[SYNTROPY] ✅ GH_TOKEN configured - git push enabled');
    results.git = true;
  } else {
    console.warn('[SYNTROPY] ⚠️  GH_TOKEN not set - self-evolution disabled');
  }

  // Check Docker socket
  try {
    await execAsync('docker ps', { timeout: 5000 });
    console.log('[SYNTROPY] ✅ Docker socket accessible');
    results.docker = true;
  } catch (e) {
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

  // Check if source files are newer than this container - trigger self-rebuild if so
  const needsUpdate = await checkForSelfUpdate();
  if (needsUpdate) {
    console.log('[SYNTROPY] Self-rebuild worker spawned. Waiting for rebuild to complete...');
    console.log('[SYNTROPY] This container will be replaced by the new version.');
    // Keep the process alive briefly so the worker has time to start
    // The worker will rebuild and restart this container
    await new Promise(resolve => setTimeout(resolve, 30000));
    console.log('[SYNTROPY] Exiting to allow rebuild worker to complete its job.');
    process.exit(0);
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
    } else if (delayMs > 0) {
      console.log(`[SYNTROPY] Schedule found but due soon (${Math.round(delayMs / 60000)} min) - running now`);
    } else {
      console.log(`[SYNTROPY] Schedule found but past due - running now`);
    }
  } else {
    console.log('[SYNTROPY] No schedule found - running first cycle immediately');
  }

  // Run first cycle
  runAutonomousCycle();
}

startup();
