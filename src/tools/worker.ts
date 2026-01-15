import { tool } from 'ai';
import { z } from 'zod';
import * as path from 'path';
import * as fs from 'fs-extra';
import { PIXEL_ROOT } from '../config';
import { logAudit } from '../utils';
import {
    spawnWorkerInternal,
    readTaskLedger,
    readWorkerEvents,
    getContainerStatus,
    writeTaskLedger,
    recordWorkerEvent,
    scheduleSelfRebuildInternal,
    cleanupStaleTasksInternal
} from '../worker-manager';

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

        // Record running event if task just started
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

                // Record completion/failure event for visibility
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
        return scheduleSelfRebuildInternal({ reason, gitRef });
    }
});

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

export const workerTools = {
    spawnWorker,
    checkWorkerStatus,
    listWorkerTasks,
    scheduleSelfRebuild,
    cleanupStaleTasks,
    readWorkerLogs,
};
