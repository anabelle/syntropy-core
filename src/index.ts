import { ToolLoopAgent, stepCountIs } from 'ai';
import { openai } from '@ai-sdk/openai';
import { logAudit } from './utils';
import { tools } from './tools';
import { MODEL_NAME, PIXEL_ROOT } from './config';
import * as fs from 'fs-extra';
import * as path from 'path';

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
  scheduleNextRun: {
    description: 'Schedule when the next Syntropy cycle should run. Use this at the END of each cycle to decide when to wake up next. Consider: urgent issues = shorter delay, stable ecosystem = longer delay. Range: 10 minutes to 6 hours.',
    inputSchema: {
      type: 'object',
      properties: {
        delayMinutes: {
          type: 'number',
          description: 'Number of minutes until the next cycle. Min: 10, Max: 360 (6 hours).'
        },
        reason: {
          type: 'string',
          description: 'Brief explanation for this timing choice (e.g., "monitoring error resolution" or "stable, routine check")'
        }
      },
      required: ['delayMinutes', 'reason']
    },
    execute: async ({ delayMinutes, reason }: { delayMinutes: number; reason: string }) => {
      const clampedMinutes = Math.max(10, Math.min(360, delayMinutes));
      const delayMs = clampedMinutes * 60 * 1000;
      await setNextScheduledRun(delayMs, reason);
      return { success: true, scheduledIn: `${clampedMinutes} minutes`, reason };
    }
  }
};

const syntropyOversoul = new ToolLoopAgent({
  model: openai(MODEL_NAME),
  instructions: `You are Syntropy, the master intelligence (Oversoul) governing the Pixel ecosystem.
Transition the ecosystem from 'Survivor' to 'Architect'.
- Pixel Agent: Social front-end.
- Opencode Builder: Base-layer execution, DevOps, and research.

REAL CONTINUITY PROTOCOL:
- Cycle Start: MANDATORY call 'readContinuity'. This is your memory.
- Dynamic Adaptation: For every tool output, analyze its implications:
  - SUCCESS: Did this tool call fulfill a 'Now' task? If so, move it to 'Done' in the next 'updateContinuity' call.
  - LEARNINGS: Use # Knowledge Base in CONTINUITY.md to store long-term technical facts, audit results, or environment insights discovered via tools (especially from 'delegateToOpencode').
  - FAILURE: Did a tool fail? Mark this in 'State' and 'Now' as a priority issue.
- Compaction Safety: Update 'CONTINUITY.md' before the end of your cycle if ANYTHING changed.
- Content: Keep the ledger dense. Bullet points. Facts only. No fluff. Use # Knowledge Base for persistence.

SELF-SCHEDULING:
- At the END of every cycle, you MUST call 'scheduleNextRun' to decide when to wake up next.
- If there are urgent issues or you're monitoring something: schedule sooner (10-30 minutes).
- If everything is stable: schedule later (2-6 hours).
- If you forget, you'll wake up after the fallback period anyway (6 hours max).

OPERATIONAL PROTOCOLS:
1. Every cycle MUST call 'writeEvolutionReport' to manifest your thoughts publicly.
2. Use 'delegateToOpencode' ONLY for SPECIFIC technical tasks.
3. Audit health and treasury first.
4. ALWAYS call 'scheduleNextRun' at the end of your cycle.`,
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
console.log('[SYNTROPY] Starting Oversoul with self-scheduling...');
console.log(`[SYNTROPY] Fallback interval: ${MAX_INTERVAL_MS / 60000} minutes (max)`);
console.log(`[SYNTROPY] Minimum interval: ${MIN_INTERVAL_MS / 60000} minutes`);

// Run immediately on startup
runAutonomousCycle();
