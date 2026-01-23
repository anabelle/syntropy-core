import { ToolLoopAgent, stepCountIs, tool } from 'ai';
import { openai } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { logAudit } from './utils';
import { tools } from './tools';
import { MODEL_NAME, MODEL_PROVIDER, PIXEL_ROOT, OPENROUTER_API_KEY } from './config';
import * as fs from 'fs-extra';
import * as path from 'path';
import { z } from 'zod';
import * as http from 'http';
import { ContextEngine } from './context-engine';

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

// Create model based on provider selection
const openrouter = createOpenRouter({
  apiKey: OPENROUTER_API_KEY,
});
const model = MODEL_PROVIDER === 'openrouter'
  ? openrouter.chat(MODEL_NAME)
  : openai(MODEL_NAME);

// Agent instantiation moved to runAutonomousCycle for dynamic context hydration

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
    // HYDRATE CONTEXT (Agency + Memory)
    // We recreate the agent every cycle to ensure it uses the latest "Soul" (AGENTS.md)
    const systemPrompt = await ContextEngine.hydrateSystemPrompt();

    const syntropyOversoul = new ToolLoopAgent({
      model: model as any,
      instructions: systemPrompt,
      tools: allTools,
      stopWhen: stepCountIs(20),
    });

    const result = await syntropyOversoul.generate({
      prompt: `Execute a full autonomous evolution cycle:


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

PHASE 3 - TASK EXECUTION:
7. Execute any Human Inbox directives first.
8. Work on Active Focus, pick from Short-Term Tasks, or process HARVESTED TASKS from 'CONTINUITY.md'.
9. If complex fixes needed, use 'spawnWorker' to delegate (check status with 'checkWorkerStatus').
   - Only ONE worker at a time. Workers run in isolated containers with guardrails.

PHASE 3.5 - SELF-EXAMINATION (METACOGNITIVE FRAMEWORK):
10. MANDATORY: Call 'runSelfExamination' to cross-reference belief vs reality.
    - This phase compares CONTINUITY.md (belief state) with actual external reality (feed, memory, logs)
    - Detects state mismatches like "expecting response while documenting absence of response"
    - Extracts generalizable principles when blind spots are discovered
    - Returns insights that feed into next cycle's strategy refinement
    - Domains examined: relationships, treasury, infrastructure, code-quality
11. If mismatches detected, analyze them and update understanding of reality.
    - Critical mismatches: Immediate action required
    - High mismatches: Add to short-term tasks
    - Medium/Low mismatches: Note for pattern library, track across cycles
12. Extract principles from discoveries and integrate into next cycle strategy.

PHASE 4 - KNOWLEDGE RETENTION:
13. Update CONTINUITY.md with findings, completed tasks, and new knowledge.
14. Include any insights from Self-Examination phase (mismatches discovered, principles extracted).

PHASE 5 - AUTONOMOUS REFACTORING (if cycle was healthy):
15. Call 'processRefactorQueue' with action='check' to see next task.
16. If task available and unblocked, call 'processRefactorQueue' with action='execute' and taskId.
17. Update CONTINUITY.md refactor progress count.

PHASE 6 - NARRATIVE & STORYTELLING:
18. Identify any "story-worthy" events (recoveries, milestones, major shifts) from THIS or RECENT cycles.
19. If a milestone was reached: Call 'writeEvolutionReport' to update the website/Inner Monologue.
20. If an internal insight was gained:
    - FIRST call 'readDiary' (limit=5) to review recent entries and avoid repetition.
    - Then call 'writeDiary' with recentContextRead=true, writing something UNIQUE that builds on the narrative.
    - Include self-examination insights as metacognitive discoveries.
21. If a public announcement is warranted:
    - FIRST call 'readPixelNostrFeed' (limit=10) to check previous posts and ensure context.
    - Then call 'postToNostr' to broadcast to the network.

PHASE 7 - IDEA GARDEN:
22. Call 'tendIdeaGarden' with action='read' to see current seeds.
23. IF a seed has 5+ waterings: HARVEST it (this moves it to CONTINUITY.md as a pending task).
24. ELSE IF seeds exist: WATER one (add a thought/insight from this cycle's learnings).
25. IF you have a genuinely NEW idea: Try to PLANT. If blocked (similar exists), water the suggested seed instead.
26. Periodically: Run action='consolidate' to find and merge duplicates.

PHASE 8 - WRAP UP:
27. Call 'scheduleNextRun' to decide when to wake up next.

IMPORTANT: You are the voice of the ecosystem. Don't be too conservative with reports—if the recovery was epic, tell the story. If the architecture improved, explain the vision. If self-examination revealed new insights about how the organism operates, document them as metacognitive discoveries.`,
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
  } catch (error: any) {
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
  } finally {
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
