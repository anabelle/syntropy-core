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
// WORKER EVENT STORE TYPES
// ============================================

export interface WorkerEvent {
  id: string;
  taskId: string;
  containerName: string;
  eventType: 'spawn' | 'complete' | 'failed' | 'aborted';
  timestamp: string;
  status?: 'pending' | 'running' | 'completed' | 'failed' | 'aborted';
  spawnTime?: string;
  completionTime?: string;
  buildDurationMs?: number;
  error?: string;
  exitCode?: number;
}

export interface WorkerEventStore {
  version: number;
  events: WorkerEvent[];
}

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
const WORKER_EVENTS_PATH = path.join(PIXEL_ROOT, 'data', 'worker-events.json');

export async function readWorkerEvents(): Promise<WorkerEventStore> {
  try {
    if (await fs.pathExists(WORKER_EVENTS_PATH)) {
      const content = await fs.readFile(WORKER_EVENTS_PATH, 'utf-8');
      return JSON.parse(content);
    }
  } catch (e) {
    console.error('[WORKER EVENTS] Error reading worker events:', e);
  }
  return { version: 1, events: [] };
}

export async function writeWorkerEvents(store: WorkerEventStore): Promise<void> {
  await fs.ensureDir(path.dirname(WORKER_EVENTS_PATH));
  const tempPath = `${WORKER_EVENTS_PATH}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(store, null, 2));
  await fs.rename(tempPath, WORKER_EVENTS_PATH);
}

export async function recordWorkerEvent(event: Omit<WorkerEvent, 'id' | 'timestamp'>): Promise<WorkerEvent> {
  const store = await readWorkerEvents();
  const fullEvent: WorkerEvent = {
    ...event,
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    timestamp: new Date().toISOString()
  };
  store.events.push(fullEvent);
  await writeWorkerEvents(store);
  console.log(`[WORKER EVENTS] Recorded: ${fullEvent.eventType} for task ${fullEvent.taskId}`);
  return fullEvent;
}

export async function detectHealingWorkers(): Promise<{ healing: WorkerEvent[]; active: WorkerEvent[] }> {
  const store = await readWorkerEvents();
  const HEALING_THRESHOLD_MS = 20 * 60 * 1000; // 20 minutes

  const now = Date.now();
  const active: WorkerEvent[] = [];
  const healing: WorkerEvent[] = [];

  for (const event of store.events) {
    if (event.eventType === 'spawn' && event.status === 'running') {
      const eventTime = new Date(event.timestamp).getTime();
      const elapsed = now - eventTime;

      active.push(event);

      if (elapsed > HEALING_THRESHOLD_MS) {
        healing.push({
          ...event,
          buildDurationMs: elapsed
        });
      }
    }
  }

  return { healing, active };
}

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

export async function readTaskLedger(): Promise<TaskLedger> {
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

export async function writeTaskLedger(ledger: TaskLedger): Promise<void> {
  await fs.ensureDir(path.dirname(LEDGER_PATH));
  // Atomic write: temp file + rename
  const tempPath = `${LEDGER_PATH}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(ledger, null, 2));
  await fs.rename(tempPath, LEDGER_PATH);
}

export async function getContainerStatus(containerName: string): Promise<{ exists: boolean; exited: boolean; exitCode: number }> {
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
  success: boolean;
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
  const cleanup = await cleanupExitedWorkerContainers();
  if (cleanup.attempted > 0) {
    console.log(`[SYNTROPY] Cleaned up exited worker containers: removed=${cleanup.removed}/${cleanup.attempted}`);
  }

  // 0. Spawn cooldown: Prevent rapid respawn cascades after FAILURES
  const SPAWN_COOLDOWN_MS = 60_000; // 60 seconds cooldown after failures
  const ledger = await readTaskLedger();
  const recentTasks = ledger.tasks
    .filter(t => t.completedAt)
    .sort((a, b) => new Date(b.completedAt!).getTime() - new Date(a.completedAt!).getTime());

  if (recentTasks.length > 0) {
    const lastTask = recentTasks[0];
    const lastCompleted = new Date(lastTask.completedAt!).getTime();
    const elapsed = Date.now() - lastCompleted;

    const lastTaskFailed = lastTask.status === 'failed' || (lastTask.exitCode !== undefined && lastTask.exitCode !== 0);

    if (lastTaskFailed && elapsed < SPAWN_COOLDOWN_MS) {
      const waitSec = Math.ceil((SPAWN_COOLDOWN_MS - elapsed) / 1000);
      await logAudit({ type: 'worker_spawn_rejected', reason: 'cooldown_after_failure', waitSeconds: waitSec, lastTaskId: lastTask.id });
      return {
        error: `Spawn cooldown active (last task failed). Wait ${waitSec}s before retrying. Last task: ${lastTask.id}`,
        runningTaskId: lastTask.id,
        runningTaskStatus: lastTask.status,
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

  // Update lock to track the real taskId
  await fs.writeFile(WORKER_LOCK_PATH, JSON.stringify({ taskId, createdAt: new Date().toISOString() }, null, 2));

  // 3. Generate container name and spawn worker container
  const containerName = `pixel-worker-${taskId.slice(0, 8)}`;

  // Record spawn event
  await recordWorkerEvent({
    taskId,
    containerName,
    eventType: 'spawn',
    status: 'pending',
    spawnTime: new Date().toISOString()
  });


  console.log(`[SYNTROPY] Spawning worker container: ${containerName}`);
  const hostPixelRoot = process.env.HOST_PIXEL_ROOT || PIXEL_ROOT;

  const proc = spawn('docker', [
    'compose', '--profile', 'worker',
    'run', '-d',
    '--name', containerName,
    '-e', `TASK_ID=${taskId}`,
    '-e', `HOST_PIXEL_ROOT=${hostPixelRoot}`,
    'worker'
  ], { cwd: PIXEL_ROOT });

  let spawnError = '';
  proc.stderr.on('data', (d) => { spawnError += d.toString(); });

  try {
    await new Promise<void>((resolve, reject) => {
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Failed to spawn worker: ${spawnError}`));
      });
      proc.on('error', reject);
    });
  } catch (err: any) {
    return { error: err.message };
  }

  console.log(`[SYNTROPY] Worker spawned successfully: ${containerName}`);
  await logAudit({ type: 'worker_spawned', taskId, containerName });

  return {
    success: true,
    taskId,
    containerName,
    status: 'spawned',
    message: `Worker spawned. Task ID: ${taskId.slice(0, 8)}. Use checkWorkerStatus("${taskId}") to monitor progress.`,
  };
}

// Core functions exported above. Tools have been moved to src/tools/worker.ts to prevent circular dependencies.

/**
 * Internal function to check the status of a worker task.
 */
export async function checkWorkerStatusInternal(taskId: string): Promise<any> {
  const ledger = await readTaskLedger();
  const task = ledger.tasks.find(t => t.id === taskId);

  if (!task) {
    return { error: `Task ${taskId} not found in ledger` };
  }

  if (task.status === 'running') {
    const store = await readWorkerEvents();
    const hasRunningEvent = store.events.some(e => e.taskId === taskId && e.eventType === 'spawn' && e.status === 'running');

    if (!hasRunningEvent) {
      const containerName = `pixel-worker-${taskId.slice(0, 8)}`;
      const spawnEvent = store.events.find(e => e.taskId === taskId && e.eventType === 'spawn');

      await recordWorkerEvent({
        taskId,
        containerName,
        eventType: 'spawn',
        status: 'running',
        spawnTime: spawnEvent?.spawnTime || task.startedAt
      });
    }
  }

  if (task.status === 'running' && task.workerId) {
    const containerName = `pixel-worker-${taskId.slice(0, 8)}`;
    const containerStatus = await getContainerStatus(containerName);

    if (!containerStatus.exists || containerStatus.exited) {
      task.status = containerStatus.exitCode === 0 ? 'completed' : 'failed';
      task.exitCode = containerStatus.exitCode;
      task.completedAt = new Date().toISOString();

      const outputPath = path.join(PIXEL_ROOT, 'data', `worker-output-${taskId}.txt`);
      if (await fs.pathExists(outputPath)) {
        const output = await fs.readFile(outputPath, 'utf-8');
        task.output = output.slice(-2000);
        const match = output.match(/^[\t ]*##\s+summary.*$/im);
        if (match?.index !== undefined) task.summary = output.slice(match.index);
      }

      await writeTaskLedger(ledger);
      await logAudit({ type: 'worker_status_updated', taskId, status: task.status, exitCode: task.exitCode });

      const finalEventType: 'complete' | 'failed' = task.status === 'completed' ? 'complete' : 'failed';
      const store = await readWorkerEvents();
      const spawnEvent = store.events.find(e => e.taskId === taskId && e.eventType === 'spawn');

      await recordWorkerEvent({
        taskId,
        containerName,
        eventType: finalEventType,
        status: task.status,
        spawnTime: spawnEvent?.spawnTime,
        completionTime: task.completedAt,
        buildDurationMs: spawnEvent?.spawnTime
          ? new Date(task.completedAt!).getTime() - new Date(spawnEvent.spawnTime).getTime()
          : undefined,
        exitCode: task.exitCode
      });
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
    output: task.output?.slice(-3000),
    error: task.error,
    workerId: task.workerId,
  };
}

/**
 * Internal function to list worker tasks.
 */
export async function listWorkerTasksInternal(status: 'all' | 'pending' | 'running' | 'completed' | 'failed' = 'all', limit: number = 10): Promise<any> {
  const ledger = await readTaskLedger();
  let tasks = ledger.tasks;
  if (status !== 'all') tasks = tasks.filter(t => t.status === status);
  tasks.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
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

/**
 * Internal function to schedule self-rebuild.
 */
export async function scheduleSelfRebuildInternal(params: { reason: string; gitRef?: string }): Promise<any> {
  const { reason, gitRef } = params;
  await logAudit({ type: 'syntropy_rebuild_scheduled', reason, gitRef });
  const taskId = crypto.randomUUID();
  const ledger = await readTaskLedger();
  const hostPixelRoot = process.env.HOST_PIXEL_ROOT || PIXEL_ROOT;

  const rebuildTask: Task = {
    id: taskId,
    status: 'pending',
    createdAt: new Date().toISOString(),
    type: 'syntropy-rebuild',
    payload: {
      task: `Self-rebuild`,
      context: `Reason: ${reason}`
    },
    attempts: 0,
    maxAttempts: 1,
  };

  ledger.tasks.push(rebuildTask);
  await writeTaskLedger(ledger);

  const containerName = `pixel-worker-rebuild-${taskId.slice(0, 8)}`;
  await cleanupExitedWorkerContainers();

  const proc = spawn('docker', [
    'compose', '--profile', 'worker',
    'run', '-d',
    '--name', containerName,
    '-e', `TASK_ID=${taskId}`,
    '-e', `HOST_PIXEL_ROOT=${hostPixelRoot}`,
    'worker'
  ], { cwd: PIXEL_ROOT });

  return { scheduled: true, taskId, containerName };
}

/**
 * Internal function to cleanup stale tasks.
 */
export async function cleanupStaleTasksInternal(retentionDays: number = 7): Promise<any> {
  const ledger = await readTaskLedger();
  const now = Date.now();
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  let aborted = 0;
  let removed = 0;

  for (const task of ledger.tasks) {
    if (task.status === 'running') {
      const containerName = `pixel-worker-${task.id.slice(0, 8)}`;
      const status = await getContainerStatus(containerName);
      if (!status.exists || status.exited) {
        task.status = 'aborted';
        task.completedAt = new Date().toISOString();
        aborted++;
      }
    }
  }

  const removedTaskIds: string[] = [];
  const tasksToKeep = ledger.tasks.filter(task => {
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'aborted') {
      const completionTime = task.completedAt || task.createdAt;
      if (now - new Date(completionTime).getTime() > retentionMs) {
        removed++;
        removedTaskIds.push(task.id);
        return false;
      }
    }
    return true;
  });

  for (const taskId of removedTaskIds) {
    const outputPath = path.join(PIXEL_ROOT, 'data', `worker-output-${taskId}.txt`);
    if (await fs.pathExists(outputPath)) await fs.remove(outputPath);
  }

  ledger.tasks = tasksToKeep;
  await writeTaskLedger(ledger);

  let orphaned = 0;
  const dataDir = path.join(PIXEL_ROOT, 'data');
  if (await fs.pathExists(dataDir)) {
    const files = await fs.readdir(dataDir);
    const workerFiles = files.filter(f => f.startsWith('worker-output-') && f.endsWith('.txt'));
    const activeTaskIds = new Set(ledger.tasks.map(t => t.id));
    for (const file of workerFiles) {
      const taskId = file.replace('worker-output-', '').replace('.txt', '');
      if (!activeTaskIds.has(taskId)) {
        await fs.remove(path.join(dataDir, file));
        orphaned++;
      }
    }
  }

  await logAudit({ type: 'worker_cleanup', aborted, removed, orphaned });
  return { success: true, aborted, removed, orphaned, remaining: ledger.tasks.length };
}

/**
 * Internal function to read worker logs.
 */
export async function readWorkerLogsInternal(taskId: string, lines: number = 200): Promise<any> {
  const LOGS_DIR = path.join(PIXEL_ROOT, 'logs');
  let logPath = taskId === 'live'
    ? path.join(LOGS_DIR, 'opencode_live.log')
    : path.join(LOGS_DIR, `worker-${taskId.slice(0, 8)}.log`);

  if (!await fs.pathExists(logPath)) {
    logPath = path.join(PIXEL_ROOT, 'data', `worker-output-${taskId}.txt`);
  }

  if (!await fs.pathExists(logPath)) return { error: 'Log not found' };

  const content = await fs.readFile(logPath, 'utf-8');
  const allLines = content.split('\n');
  return {
    logPath,
    totalLines: allLines.length,
    content: allLines.slice(-lines).join('\n'),
  };
}
