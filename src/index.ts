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
const MIN_INTERVAL_MS = 10 * 60 * 1000;      // 10 minutes minimum
const MAX_INTERVAL_MS = 6 * 60 * 60 * 1000;  // 6 hours maximum (fallback)
const DEFAULT_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours default

let nextRunTimeout: NodeJS.Timeout | null = null;

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

const syntropyOversoul = new ToolLoopAgent({
  model: openai(MODEL_NAME),
  instructions: `You are Syntropy, the master intelligence (Oversoul) governing the Pixel ecosystem.

CONTINUITY LEDGER STRUCTURE:
Your memory (CONTINUITY.md) has these sections that you MUST maintain:

1. **📬 Human Inbox**: PRIORITY - Directives from the human operator. Process these FIRST.
2. **🎯 Active Focus**: What you're working on THIS cycle. Clear it when done.
3. **📋 Short-Term Tasks**: Next 1-3 cycles. Use checkboxes [ ] and [x].
4. **🗓️ Mid-Term Goals**: This week. Larger objectives spanning multiple cycles.
5. **🌟 Long-Term Vision**: Strategic direction. Rarely changes.
6. **🔄 Ongoing Monitoring**: Table of things to check every cycle (treasury, health, etc).
7. **✅ Recently Completed**: Archive of finished tasks. Prune weekly.
8. **📚 Knowledge Base**: Persistent technical facts and learnings.

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

SELF-SCHEDULING:
- At the END of every cycle, call 'scheduleNextRun'.
- Urgent issues or monitoring something: 10-30 minutes
- Stable ecosystem: 2-6 hours
- Fallback if you forget: 6 hours max

OPERATIONAL PROTOCOLS:
1. Call 'writeEvolutionReport' every cycle to manifest thoughts publicly.
2. Use 'delegateToOpencode' ONLY for SPECIFIC technical tasks.
3. Audit health and treasury first.
4. ALWAYS call 'scheduleNextRun' at cycle end.`,
  tools: allTools,
  stopWhen: stepCountIs(20),
});

async function runAutonomousCycle() {
  console.log(`[${new Date().toISOString()}] SYNTROPY CORE: STARTING CYCLE WITH ${MODEL_NAME}`);
  await logAudit({ type: 'cycle_start', model: MODEL_NAME });

  try {
    const result = await syntropyOversoul.generate({
      prompt: `Execute a full autonomous evolution cycle:
1. MANDATORY: Read 'CONTINUITY.md' via 'readContinuity' to load session memory.
2. Audit ecosystem health, treasury, and filtered agent logs.
3. PROACTIVE ARCHITECTURE: If you detect recurring technical issues in logs or if the ledger has 'Perform deep codebase audit' in 'Next', use 'delegateToOpencode' to perform a SPECIFIC technical audit or fix.
4. KNOWLEDGE RETENTION: Record all technical findings, Opencode audit results, and environment facts in the # Knowledge Base section of 'CONTINUITY.md' via 'updateContinuity'.
5. Manifest your findings and current Oversoul state via 'writeEvolutionReport'.
6. MANDATORY: Call 'scheduleNextRun' to decide when to wake up next based on system state.`,
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
              try {
                const rawResult = tr.result || tr.output;
                if (typeof rawResult === 'string') {
                  summary = rawResult.slice(0, 500);
                } else if (rawResult !== undefined && rawResult !== null) {
                  summary = JSON.stringify(rawResult).slice(0, 500);
                } else {
                  summary = 'No result returned';
                }
              } catch (e) {
                summary = 'Error stringifying result';
              }

              await logAudit({
                type: 'tool_result',
                tool: tr.toolName,
                success: !tr.isError,
                summary
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

    console.log('\n--- SYNTROPY OUTPUT ---\n', result.text, '\n-----------------------\n');

    // Auto-sync all repos at end of cycle
    const { syncAll } = await import('./utils');
    await syncAll();
  } catch (error: any) {
    console.error('Syntropy Cycle Failed:', error);
    await logAudit({ type: 'cycle_error', error: error.message });
  }

  // Schedule next run
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

  // Clamp to bounds
  delayMs = Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, delayMs));

  console.log(`[SYNTROPY] Next cycle in ${Math.round(delayMs / 60000)} minutes (${reason})`);

  nextRunTimeout = setTimeout(runAutonomousCycle, delayMs);
}

// ============================================
// STARTUP
// ============================================
async function verifyOpencode(): Promise<boolean> {
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
  } catch (error: any) {
    console.error(`[SYNTROPY] Opencode verification failed: ${error.message}`);
    await logAudit({ type: 'opencode_verification_failed', error: error.message });
    return false;
  }
}

async function verifyCapabilities(): Promise<{ git: boolean, docker: boolean, opencode: boolean }> {
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);

  const results = { git: false, docker: false, opencode: false };

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

  // Check Opencode (non-blocking, quick check)
  try {
    await execAsync('which opencode', { timeout: 2000 });
    console.log('[SYNTROPY] ✅ Opencode CLI found');
    results.opencode = true;
  } catch (e) {
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
    } else {
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
