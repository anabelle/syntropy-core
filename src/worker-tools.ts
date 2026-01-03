/**
 * Worker Architecture Tools for Syntropy
 * 
 * These tools implement the Brain/Hands separation pattern:
 * - Syntropy (Brain) spawns ephemeral Worker containers
 * - Workers execute tasks autonomously via Opencode
 * - Tasks are tracked in a persistent ledger
 * - Guardrails prevent accidental self-destruction
 */

import { tool } from 'ai';
import { z } from 'zod';
import { spawn } from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import { PIXEL_ROOT } from './config';
import { logAudit } from './utils';

// ============================================
// TASK LEDGER TYPES
// ============================================

export interface Task {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'aborted';
  createdAt: string;
  startedAt?: string;
  completedAt?: string;

  type: 'opencode' | 'docker-op' | 'git-op' | 'syntropy-rebuild';
  payload: {
    task: string;
    context?: string;
  };

  workerId?: string;
  workerPid?: number;

  exitCode?: number;
  output?: string;
  summary?: string;
  error?: string;

  attempts: number;
  maxAttempts: number;
  lastAttemptError?: string;
}

export interface TaskLedger {
  version: number;
  tasks: Task[];
}

// ============================================
// LEDGER OPERATIONS
// ============================================

const LEDGER_PATH = path.join(PIXEL_ROOT, 'data', 'task-ledger.json');
const CONTINUITY_PATH = path.join(PIXEL_ROOT, 'CONTINUITY.md');
const WORKER_LOCK_PATH = path.join(PIXEL_ROOT, 'data', 'worker-lock.json');

async function getRunningWorkerContainers(): Promise<string[]> {
  return new Promise((resolve) => {
    const proc = spawn('docker', ['ps', '--filter', 'name=pixel-worker-', '--format', '{{.Names}}']);
    let output = '';
    proc.stdout.on('data', (d) => { output += d.toString(); });
    proc.on('close', () => {
      const names = output
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      resolve(names);
    });
    proc.on('error', () => resolve([]));
  });
}

async function cleanupExitedWorkerContainers(): Promise<{ removed: number; attempted: number }> {
  return new Promise((resolve) => {
    const listProc = spawn('docker', [
      'ps', '-a',
      '--filter', 'name=pixel-worker-',
      '--filter', 'status=exited',
      '--format', '{{.Names}}'
    ]);

    let output = '';
    listProc.stdout.on('data', (d) => { output += d.toString(); });

    listProc.on('close', () => {
      const names = output
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);

      if (names.length === 0) {
        resolve({ removed: 0, attempted: 0 });
        return;
      }

      const rmProc = spawn('docker', ['rm', '-f', ...names]);
      rmProc.on('close', (code) => {
        resolve({ removed: code === 0 ? names.length : 0, attempted: names.length });
      });
      rmProc.on('error', () => resolve({ removed: 0, attempted: names.length }));
    });

    listProc.on('error', () => resolve({ removed: 0, attempted: 0 }));
  });
}

async function acquireWorkerLock(taskId: string): Promise<{ acquired: true } | { acquired: false; reason: string }> {
  await fs.ensureDir(path.dirname(WORKER_LOCK_PATH));

  // If lock exists but no workers are running, treat as stale.
  if (await fs.pathExists(WORKER_LOCK_PATH)) {
    const running = await getRunningWorkerContainers();
    if (running.length === 0) {
      await fs.remove(WORKER_LOCK_PATH);
    }
  }

  try {
    const handle = await fs.open(WORKER_LOCK_PATH, 'wx');
    await fs.writeFile(handle, JSON.stringify({ taskId, createdAt: new Date().toISOString() }, null, 2));
    await fs.close(handle);
    return { acquired: true };
  } catch {
    const running = await getRunningWorkerContainers();
    return { acquired: false, reason: running.length ? `Worker already running: ${running.join(', ')}` : 'Worker lock already held' };
  }
}

async function readTaskLedger(): Promise<TaskLedger> {
  try {
    if (await fs.pathExists(LEDGER_PATH)) {
      const content = await fs.readFile(LEDGER_PATH, 'utf-8');
      return JSON.parse(content);
    }
  } catch (e) {
    console.error('[SYNTROPY] Error reading task ledger:', e);
  }
  return { version: 1, tasks: [] };
}

async function writeTaskLedger(ledger: TaskLedger): Promise<void> {
  await fs.ensureDir(path.dirname(LEDGER_PATH));
  // Atomic write: temp file + rename
  const tempPath = `${LEDGER_PATH}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(ledger, null, 2));
  await fs.rename(tempPath, LEDGER_PATH);
}

async function getContainerStatus(containerName: string): Promise<{ exists: boolean; exited: boolean; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn('docker', ['inspect', '--format', '{{.State.Status}}:{{.State.ExitCode}}', containerName]);
    let output = '';
    proc.stdout.on('data', (d) => { output += d.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) {
        resolve({ exists: false, exited: true, exitCode: -1 });
        return;
      }
      const [status, exitCodeStr] = output.trim().split(':');
      resolve({
        exists: true,
        exited: status === 'exited',
        exitCode: parseInt(exitCodeStr, 10) || 0
      });
    });
    proc.on('error', () => {
      resolve({ exists: false, exited: true, exitCode: -1 });
    });
  });
}

// ============================================
// INTERNAL SPAWN FUNCTION (for direct calls)
// ============================================

interface SpawnWorkerParams {
  task: string;
  context?: string;
  priority?: 'low' | 'normal' | 'high';
}

interface SpawnWorkerResult {
  taskId: string;
  containerName: string;
  status: string;
  message: string;
}

interface SpawnWorkerError {
  error: string;
  runningTaskId?: string;
  runningTaskStatus?: string;
}

/**
 * Internal function to spawn a worker. Can be called directly from other tools.
 */
export async function spawnWorkerInternal(params: SpawnWorkerParams): Promise<SpawnWorkerResult | SpawnWorkerError> {
  const { task, context, priority = 'normal' } = params;

  console.log(`[SYNTROPY] spawnWorkerInternal (priority=${priority})`);
  console.log(`[SYNTROPY] Task: ${task.substring(0, 200)}...`);

  // Keep the system tidy: remove exited worker containers from prior runs.
  // (Workers persist logs to /pixel/data + /pixel/logs, so keeping containers is unnecessary.)
  const cleanup = await cleanupExitedWorkerContainers();
  if (cleanup.attempted > 0) {
    console.log(`[SYNTROPY] Cleaned up exited worker containers: removed=${cleanup.removed}/${cleanup.attempted}`);
  }

  // 0. Spawn cooldown: Prevent rapid respawn cascades after failures
  //    Check if last task completed within SPAWN_COOLDOWN_MS
  const SPAWN_COOLDOWN_MS = 60_000; // 60 seconds between spawns
  const ledger = await readTaskLedger();
  const recentTasks = ledger.tasks
    .filter(t => t.completedAt)
    .sort((a, b) => new Date(b.completedAt!).getTime() - new Date(a.completedAt!).getTime());
  
  if (recentTasks.length > 0) {
    const lastCompleted = new Date(recentTasks[0].completedAt!).getTime();
    const elapsed = Date.now() - lastCompleted;
    if (elapsed < SPAWN_COOLDOWN_MS) {
      const waitSec = Math.ceil((SPAWN_COOLDOWN_MS - elapsed) / 1000);
      await logAudit({ type: 'worker_spawn_rejected', reason: 'cooldown', waitSeconds: waitSec, lastTaskId: recentTasks[0].id });
      return {
        error: `Spawn cooldown active. Last task completed ${Math.floor(elapsed / 1000)}s ago. Wait ${waitSec}s before spawning another worker.`,
        runningTaskId: recentTasks[0].id,
        runningTaskStatus: recentTasks[0].status,
      };
    }
  }

  // 1. Enforce single-worker-at-a-time
  const lockTaskId = crypto.randomUUID();
  const lock = await acquireWorkerLock(lockTaskId);
  if (!lock.acquired) {
    const runningTasks = ledger.tasks.filter(t => t.status === 'running');
    await logAudit({ type: 'worker_spawn_rejected', reason: 'worker_busy', detail: lock.reason, runningTaskId: runningTasks[0]?.id });
    return {
      error: `Another worker is currently running (single-flight enforced). ${lock.reason}`,
      runningTaskId: runningTasks[0]?.id,
      runningTaskStatus: runningTasks[0]?.status,
    };
  }

  // 2. Generate task ID and create ledger entry
  const taskId = crypto.randomUUID();
  const newTask: Task = {
    id: taskId,
    status: 'pending',
    createdAt: new Date().toISOString(),
    type: 'opencode',
    payload: { task, context },
    attempts: 0,
    maxAttempts: 3,
  };

  ledger.tasks.push(newTask);
  await writeTaskLedger(ledger);
  await logAudit({ type: 'worker_task_created', taskId, task: task.substring(0, 500) });

  // Update lock to track the real taskId (worker will clear this lock when it exits)
  await fs.writeFile(WORKER_LOCK_PATH, JSON.stringify({ taskId, createdAt: new Date().toISOString() }, null, 2));

  // 3. Spawn worker container
  const containerName = `pixel-worker-${taskId.slice(0, 8)}`;

  console.log(`[SYNTROPY] Spawning worker container: ${containerName}`);

  // HOST_PIXEL_ROOT is the absolute host path where /pixel is mounted.
  // Docker compose needs this because relative paths (.) resolve to the
  // container's PWD when running via docker socket, not the host's real path.
  const hostPixelRoot = process.env.HOST_PIXEL_ROOT || PIXEL_ROOT;

  const proc = spawn('docker', [
    'compose', '--profile', 'worker',
    'run', '-d',
    '--name', containerName,
    // NOTE: containers are intentionally retained while running; exited ones are cleaned up automatically.
    '-e', `TASK_ID=${taskId}`,
    '-e', `HOST_PIXEL_ROOT=${hostPixelRoot}`,
    'worker'
  ], { cwd: PIXEL_ROOT });

  let spawnOutput = '';
  let spawnError = '';

  proc.stdout.on('data', (d) => { spawnOutput += d.toString(); });
  proc.stderr.on('data', (d) => { spawnError += d.toString(); });

  try {
    await new Promise<void>((resolve, reject) => {
      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Failed to spawn worker: ${spawnError}`));
        }
      });
      proc.on('error', reject);
    });
  } catch (err: any) {
    return { error: err.message };
  }

  console.log(`[SYNTROPY] Worker spawned successfully: ${containerName}`);
  await logAudit({ type: 'worker_spawned', taskId, containerName });

  return {
    taskId,
    containerName,
    status: 'spawned',
    message: `Worker spawned. Task ID: ${taskId.slice(0, 8)}. Use checkWorkerStatus("${taskId}") to monitor progress.`,
  };
}

// ============================================
// WORKER TOOLS
// ============================================

export const spawnWorker = tool({
  description: `Spawn an ephemeral worker container to execute a coding task.
  
The worker runs Opencode and has full access to the codebase and Docker.
It can rebuild services (api, web, landing, agent) and make code changes.
CRITICAL: Workers CANNOT rebuild syntropy - this is enforced by guardrails.

WHEN TO USE:
- Complex code changes requiring multiple file edits
- Tasks that need shell access (npm install, tests, etc.)
- Docker operations on other services
- Tasks that might take several minutes

The worker is ephemeral and will auto-terminate after completion.
Monitor progress using checkWorkerStatus.`,

  inputSchema: z.object({
    task: z.string().describe('Detailed technical instruction for the worker. Be specific about what files to modify, what commands to run, and expected outcomes.'),
    context: z.string().optional().describe('Additional context like error messages, relevant file paths, or background information.'),
    priority: z.enum(['low', 'normal', 'high']).default('normal').describe('Task priority. High priority tasks run first.'),
  }),

  execute: async ({ task, context, priority }) => {
    return spawnWorkerInternal({ task, context, priority });
  }
});

export const checkWorkerStatus = tool({
  description: `Check the status of a worker task.
  
Returns the current status, untruncated summary (if available), output tail (if completed), and any errors.
Use this to monitor workers spawned with spawnWorker.`,

  inputSchema: z.object({
    taskId: z.string().describe('The task ID returned by spawnWorker'),
  }),

  execute: async ({ taskId }) => {
    console.log(`[SYNTROPY] Tool: checkWorkerStatus (${taskId})`);

    const ledger = await readTaskLedger();
    const task = ledger.tasks.find(t => t.id === taskId);

    if (!task) {
      return { error: `Task ${taskId} not found in ledger` };
    }

    // If running, check if container still exists
    if (task.status === 'running' && task.workerId) {
      const containerName = `pixel-worker-${taskId.slice(0, 8)}`;
      const containerStatus = await getContainerStatus(containerName);

      if (!containerStatus.exists || containerStatus.exited) {
        // Container died - update ledger
        task.status = containerStatus.exitCode === 0 ? 'completed' : 'failed';
        task.exitCode = containerStatus.exitCode;
        task.completedAt = new Date().toISOString();

        // Try to read output file
        const outputPath = path.join(PIXEL_ROOT, 'data', `worker-output-${taskId}.txt`);
        if (await fs.pathExists(outputPath)) {
          const output = await fs.readFile(outputPath, 'utf-8');
          task.output = output.slice(-2000); // Last 2KB (full output in file)

          // Also extract full Summary section for Syntropy (untruncated)
          const match = output.match(/^[\t ]*##\s+summary.*$/im);
          if (match?.index !== undefined) {
            task.summary = output.slice(match.index);
          }
        }

        await writeTaskLedger(ledger);
        await logAudit({ type: 'worker_status_updated', taskId, status: task.status, exitCode: task.exitCode });
      }
    }

    return {
      taskId: task.id,
      status: task.status,
      type: task.type,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      attempts: task.attempts,
      exitCode: task.exitCode,
      summary: task.summary,
      output: task.output?.slice(-3000), // Last 3KB for response
      error: task.error,
      workerId: task.workerId,
    };
  }
});

export const listWorkerTasks = tool({
  description: `List all worker tasks in the ledger.
  
Shows recent tasks with their status, useful for monitoring and debugging.`,

  inputSchema: z.object({
    status: z.enum(['all', 'pending', 'running', 'completed', 'failed']).default('all').describe('Filter by status'),
    limit: z.number().default(10).describe('Maximum number of tasks to return'),
  }),

  execute: async ({ status, limit }) => {
    console.log(`[SYNTROPY] Tool: listWorkerTasks (status=${status}, limit=${limit})`);

    const ledger = await readTaskLedger();
    let tasks = ledger.tasks;

    if (status !== 'all') {
      tasks = tasks.filter(t => t.status === status);
    }

    // Sort by createdAt descending
    tasks.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    // Limit
    tasks = tasks.slice(0, limit);

    return {
      total: ledger.tasks.length,
      filtered: tasks.length,
      tasks: tasks.map(t => ({
        id: t.id,
        status: t.status,
        type: t.type,
        createdAt: t.createdAt,
        completedAt: t.completedAt,
        exitCode: t.exitCode,
        taskPreview: t.payload.task.substring(0, 100),
      })),
    };
  }
});

export const scheduleSelfRebuild = tool({
  description: `Schedule Syntropy to rebuild itself safely.
  
This is the ONLY safe way to update Syntropy's code. The process:
1. Current state is saved to CONTINUITY.md
2. A special 'syntropy-rebuild' task is created (bypasses guardrails)
3. Worker pulls latest code, rebuilds syntropy, monitors health
4. New Syntropy instance reads saved state and resumes

Use this when syntropy-core code has changed and needs deployment.
WARNING: Current Syntropy process will be replaced during this operation.`,

  inputSchema: z.object({
    reason: z.string().describe('Why the rebuild is needed (e.g., "new tool added", "bug fix in tools.ts")'),
    gitRef: z.string().optional().describe('Git ref to checkout (default: current branch, pulls latest)'),
  }),

  execute: async ({ reason, gitRef }) => {
    console.log(`[SYNTROPY] Tool: scheduleSelfRebuild (reason=${reason})`);

    // 1. Save current state to CONTINUITY.md
    const existingContinuity = await fs.pathExists(CONTINUITY_PATH)
      ? await fs.readFile(CONTINUITY_PATH, 'utf-8')
      : '';

    const rebuildNote = `
## Self-Rebuild Scheduled

**Time**: ${new Date().toISOString()}
**Reason**: ${reason}
${gitRef ? `**Git Ref**: ${gitRef}` : ''}

Previous context preserved below.

---

${existingContinuity}
`;

    await fs.writeFile(CONTINUITY_PATH, rebuildNote);
    await logAudit({ type: 'syntropy_rebuild_scheduled', reason, gitRef });

    // 2. Create rebuild task
    const taskId = crypto.randomUUID();
    const ledger = await readTaskLedger();

    const rebuildTask: Task = {
      id: taskId,
      status: 'pending',
      createdAt: new Date().toISOString(),
      type: 'syntropy-rebuild',  // Special type - bypasses guardrails
      payload: {
        task: `
SYNTROPY SELF-REBUILD PROTOCOL
==============================
Reason: ${reason}

Steps:
1. cd /pixel && git fetch origin
2. ${gitRef ? `git checkout ${gitRef}` : 'git pull origin main'}
3. docker compose build syntropy
4. docker compose up -d syntropy
5. Wait up to 5 minutes for health check:
   while ! curl -sf http://syntropy:3000/health; do sleep 10; done
6. If healthy within 5 min: exit 0 (success)
7. If NOT healthy:
   - docker compose logs syntropy --tail=100
   - Notify: The rebuild failed. Manual intervention may be needed.
   - exit 1 (failure)

The new Syntropy will read CONTINUITY.md to restore context.
        `,
        context: `Self-rebuild triggered at ${new Date().toISOString()}. Reason: ${reason}`
      },
      attempts: 0,
      maxAttempts: 1, // Self-rebuild should not auto-retry
    };

    ledger.tasks.push(rebuildTask);
    await writeTaskLedger(ledger);

    // 3. Spawn the rebuild worker
    const containerName = `pixel-worker-rebuild-${taskId.slice(0, 8)}`;

    console.log(`[SYNTROPY] Spawning self-rebuild worker: ${containerName}`);

    const cleanup = await cleanupExitedWorkerContainers();
    if (cleanup.attempted > 0) {
      console.log(`[SYNTROPY] Cleaned up exited worker containers: removed=${cleanup.removed}/${cleanup.attempted}`);
    }

    const hostPixelRoot = process.env.HOST_PIXEL_ROOT || PIXEL_ROOT;

    const proc = spawn('docker', [
      'compose', '--profile', 'worker',
      'run', '-d',
      '--name', containerName,
      // NOTE: containers are intentionally retained while running; exited ones are cleaned up automatically.
      '-e', `TASK_ID=${taskId}`,
      '-e', `HOST_PIXEL_ROOT=${hostPixelRoot}`,
      'worker'
    ], { cwd: PIXEL_ROOT });

    let spawnError = '';
    proc.stderr.on('data', (d) => { spawnError += d.toString(); });

    const spawnResult = await new Promise<{ success: boolean; error?: string }>((resolve) => {
      proc.on('close', (code) => {
        if (code === 0) {
          resolve({ success: true });
        } else {
          resolve({ success: false, error: spawnError });
        }
      });
      proc.on('error', (e) => {
        resolve({ success: false, error: e.message });
      });
    });

    if (!spawnResult.success) {
      return {
        error: `Failed to spawn rebuild worker: ${spawnResult.error}`,
        taskId,
      };
    }

    return {
      scheduled: true,
      taskId,
      containerName,
      message: `Self-rebuild scheduled (task ${taskId.slice(0, 8)}). Syntropy will be restarted when the worker executes. State has been saved to CONTINUITY.md.`,
      warning: 'Current Syntropy process will be replaced. This is expected behavior.',
    };
  }
});

/**
 * Internal function to cleanup stale tasks (callable directly without tool wrapper)
 */
export async function cleanupStaleTasksInternal(retentionDays: number = 7): Promise<{ success: boolean; aborted: number; removed: number; remaining: number }> {
  console.log(`[SYNTROPY] cleanupStaleTasksInternal (retention=${retentionDays} days)`);

  const ledger = await readTaskLedger();
  const now = Date.now();
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;

  let aborted = 0;
  let removed = 0;

  // Check running tasks for missing containers
  for (const task of ledger.tasks) {
    if (task.status === 'running') {
      const containerName = `pixel-worker-${task.id.slice(0, 8)}`;
      const status = await getContainerStatus(containerName);

      if (!status.exists) {
        task.status = 'aborted';
        task.error = 'Worker container disappeared (possible crash/restart)';
        task.completedAt = new Date().toISOString();
        aborted++;

        await logAudit({ type: 'worker_task_aborted', taskId: task.id, reason: 'container_missing' });
      } else if (status.exited) {
        task.status = 'aborted';
        task.exitCode = status.exitCode;
        task.error = `Worker container exited unexpectedly (exitCode=${status.exitCode})`;
        task.completedAt = new Date().toISOString();
        aborted++;

        await logAudit({ type: 'worker_task_aborted', taskId: task.id, reason: 'container_exited', exitCode: status.exitCode });
      }
    }
  }

  // Remove old completed/failed tasks and their output files
  const removedTaskIds: string[] = [];
  const tasksToKeep = ledger.tasks.filter(task => {
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'aborted') {
      const taskAge = now - new Date(task.completedAt || task.createdAt).getTime();
      if (taskAge > retentionMs) {
        removed++;
        removedTaskIds.push(task.id);
        return false;
      }
    }
    return true;
  });

  // Delete output files for removed tasks
  for (const taskId of removedTaskIds) {
    const outputPath = path.join(PIXEL_ROOT, 'data', `worker-output-${taskId}.txt`);
    try {
      if (await fs.pathExists(outputPath)) {
        await fs.remove(outputPath);
      }
    } catch (e) {
      // Ignore file deletion errors
    }
  }

  ledger.tasks = tasksToKeep;
  await writeTaskLedger(ledger);

  await logAudit({ type: 'worker_cleanup', aborted, removed });

  return {
    success: true,
    aborted,
    removed,
    remaining: ledger.tasks.length,
  };
}

export const cleanupStaleTasks = tool({
  description: `Clean up stale or abandoned worker tasks.
  
Marks stuck 'running' tasks as 'aborted' if their container no longer exists.
Removes old completed/failed tasks older than the retention period.
Run this periodically to keep the ledger clean.`,

  inputSchema: z.object({
    retentionDays: z.number().default(7).describe('Remove completed/failed tasks older than this many days'),
  }),

  execute: async ({ retentionDays }) => {
    return cleanupStaleTasksInternal(retentionDays);
  }
});

export const readWorkerLogs = tool({
  description: `Read logs from a worker task or the shared opencode log.
  
USAGE:
- Pass a taskId to read logs from a specific worker task
- Pass 'live' to read the shared opencode_live.log (all worker runs)
- Logs are also available via: docker logs pixel-worker-{taskId first 8 chars}

This is useful for debugging worker tasks and seeing what opencode did.`,

  inputSchema: z.object({
    taskId: z.string().describe("Task ID to read logs for, or 'live' for shared log"),
    lines: z.number().default(200).describe('Number of lines to read (from end)'),
  }),

  execute: async ({ taskId, lines }) => {
    console.log(`[SYNTROPY] Tool: readWorkerLogs (taskId=${taskId}, lines=${lines})`);

    const LOGS_DIR = path.join(PIXEL_ROOT, 'logs');
    let logPath: string;

    if (taskId === 'live') {
      logPath = path.join(LOGS_DIR, 'opencode_live.log');
    } else {
      // Try task-specific log first
      const shortId = taskId.slice(0, 8);
      logPath = path.join(LOGS_DIR, `worker-${shortId}.log`);

      // Fall back to data output file if task-specific log doesn't exist
      if (!await fs.pathExists(logPath)) {
        logPath = path.join(PIXEL_ROOT, 'data', `worker-output-${taskId}.txt`);
      }
    }

    if (!await fs.pathExists(logPath)) {
      return {
        error: `Log file not found: ${logPath}`,
        hint: taskId === 'live'
          ? 'No workers have run yet'
          : `Worker ${taskId} may not have started or logs were cleaned up`
      };
    }

    try {
      const content = await fs.readFile(logPath, 'utf-8');
      const allLines = content.split('\n');
      const requestedLines = allLines.slice(-lines);

      return {
        logPath,
        totalLines: allLines.length,
        returnedLines: requestedLines.length,
        content: requestedLines.join('\n'),
      };
    } catch (error: any) {
      return { error: `Failed to read log: ${error.message}` };
    }
  }
});

// Export all worker tools as an object
export const workerTools = {
  spawnWorker,
  checkWorkerStatus,
  listWorkerTasks,
  scheduleSelfRebuild,
  cleanupStaleTasks,
  readWorkerLogs,
};
