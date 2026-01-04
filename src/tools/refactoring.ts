import { tool } from 'ai';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs-extra';
import * as path from 'path';
import { PIXEL_ROOT } from '../config';
import { logAudit } from '../utils';

const execAsync = promisify(exec);

export const refactoringTools = {
  processRefactorQueue: tool({
    description: `Process ONE task from the REFACTOR_QUEUE.md file. This enables autonomous codebase improvement.
    
PROTOCOL:
1. Call with action='check' to see the next available task
2. Call with action='execute' and taskId to process that specific task
3. Only process ONE task per Syntropy cycle to maintain stability

This tool picks up refactoring tasks that break the "spaghetti" codebase into clean modules.
Tasks are designed to be atomic and safe - each has rollback instructions if needed.

NOTE: Refactoring tasks are executed by spawning a worker container. Use checkWorkerStatus
to monitor progress after execution starts.`,
    inputSchema: z.object({
      action: z.enum(['check', 'execute']).describe("'check' to see next task, 'execute' to run a specific task"),
      taskId: z.string().optional().describe("Task ID to execute (e.g., 'T001'). Required if action='execute'")
    }),
    execute: async ({ action, taskId }) => {
      const QUEUE_PATH = path.resolve(PIXEL_ROOT, 'REFACTOR_QUEUE.md');
      console.log(`[SYNTROPY] Tool: processRefactorQueue (action=${action}, taskId=${taskId || 'N/A'})`);

      try {
        if (!fs.existsSync(QUEUE_PATH)) {
          return { error: 'REFACTOR_QUEUE.md not found. Create it first.' };
        }

        const content = await fs.readFile(QUEUE_PATH, 'utf-8');

        // Also check archive to prevent re-processing completed tasks
        const ARCHIVE_PATH = path.resolve(PIXEL_ROOT, 'REFACTOR_ARCHIVE.md');
        let archivedTaskIds: string[] = [];
        if (fs.existsSync(ARCHIVE_PATH)) {
          const archiveContent = await fs.readFile(ARCHIVE_PATH, 'utf-8');
          const archiveMatch = archiveContent.matchAll(/\*\*(T\d{3}[ab]?)\*\* \| ✅ DONE/g);
          archivedTaskIds = [...archiveMatch].map(m => m[1]);
        }

        if (action === 'check') {
          // Find the next READY task
          const taskPattern = /### (T\d{3}[ab]?): ([^\n]+) (⬜ READY|🟡 IN_PROGRESS|✅ DONE|❌ FAILED)/g;
          const tasks: Array<{ id: string, title: string, status: string }> = [];
          let match;

          while ((match = taskPattern.exec(content)) !== null) {
            tasks.push({ id: match[1], title: match[2], status: match[3] });
          }

          // Filter out tasks that are already archived (even if marked READY in queue)
          const readyTasks = tasks.filter(t => t.status === '⬜ READY' && !archivedTaskIds.includes(t.id));
          const inProgress = tasks.filter(t => t.status === '🟡 IN_PROGRESS');
          const done = tasks.filter(t => t.status === '✅ DONE');

          // Check for sync issues
          const syncIssues = tasks.filter(t => t.status === '⬜ READY' && archivedTaskIds.includes(t.id));
          if (syncIssues.length > 0) {
            console.log(`[SYNTROPY] Warning: ${syncIssues.length} task(s) marked READY but already archived. Run verifyQueueArchiveSync to fix.`);
          }

          if (inProgress.length > 0) {
            return {
              warning: 'A task is already in progress',
              inProgress: inProgress[0],
              message: 'Wait for current task to complete or mark it as DONE/FAILED'
            };
          }

          if (readyTasks.length === 0) {
            return {
              message: 'No READY tasks in queue!',
              stats: { ready: 0, done: done.length, total: tasks.length },
              note: syncIssues.length > 0 ? `${syncIssues.length} task(s) skipped (already archived)` : undefined
            };
          }

          // Check dependencies for the first ready task
          const nextTask = readyTasks[0];
          const taskSection = content.slice(
            content.indexOf(`### ${nextTask.id}:`),
            content.indexOf(`### T${String(parseInt(nextTask.id.slice(1)) + 1).padStart(3, '0')}:`) || content.length
          );

          const dependsMatch = taskSection.match(/\*\*Depends\*\*: (T\d{3}(?:[-,]\s*T\d{3})*)/);
          let blockedBy: string[] = [];

          if (dependsMatch) {
            const deps = dependsMatch[1].match(/T\d{3}/g) || [];
            const doneTasks = done.map(t => t.id);
            blockedBy = deps.filter(d => !doneTasks.includes(d));
          }

          if (blockedBy.length > 0) {
            // Find next unblocked task
            for (const task of readyTasks.slice(1)) {
              const section = content.slice(
                content.indexOf(`### ${task.id}:`),
                content.indexOf(`### T${String(parseInt(task.id.slice(1)) + 1).padStart(3, '0')}:`) || content.length
              );
              const depMatch = section.match(/\*\*Depends\*\*: (T\d{3}(?:[-,]\s*T\d{3})*)/);
              if (!depMatch) {
                return {
                  nextTask: task,
                  note: `${nextTask.id} is blocked by ${blockedBy.join(', ')}, suggesting ${task.id} instead`,
                  stats: { ready: readyTasks.length, done: done.length }
                };
              }
            }
            return {
              blocked: true,
              nextTask: nextTask,
              blockedBy,
              message: `First ready task ${nextTask.id} is blocked by incomplete dependencies`
            };
          }

          // Extract INSTRUCTIONS block
          const instructionsMatch = taskSection.match(/```\nINSTRUCTIONS:\n([\s\S]*?)(?:\nVERIFY:|```)/);
          const instructions = instructionsMatch ? instructionsMatch[1].trim() : 'No instructions found';

          return {
            nextTask,
            instructions: instructions.substring(0, 500) + (instructions.length > 500 ? '...' : ''),
            stats: { ready: readyTasks.length, done: done.length, total: tasks.length },
            action: `Call processRefactorQueue with action='execute' and taskId='${nextTask.id}' to process this task`
          };
        }

        if (action === 'execute') {
          if (!taskId) {
            return { error: "taskId is required for action='execute'" };
          }

          // Find the task section
          const taskHeaderPattern = new RegExp(`### ${taskId}: ([^\\n]+) (⬜ READY|🟡 IN_PROGRESS)`);
          const headerMatch = content.match(taskHeaderPattern);

          if (!headerMatch) {
            return { error: `Task ${taskId} not found or not in READY/IN_PROGRESS status` };
          }

          // Extract the full task section
          const taskStart = content.indexOf(`### ${taskId}:`);
          const nextTaskMatch = content.slice(taskStart + 10).match(/### T\d{3}:/);
          const taskEnd = nextTaskMatch ? taskStart + 10 + nextTaskMatch.index! : content.length;
          const taskSection = content.slice(taskStart, taskEnd);

          // Extract INSTRUCTIONS
          const instructionsMatch = taskSection.match(/```\nINSTRUCTIONS:\n([\s\S]*?)(?:\nVERIFY:|```)/);
          if (!instructionsMatch) {
            return { error: `No INSTRUCTIONS block found for ${taskId}` };
          }
          const instructions = instructionsMatch[1].trim();

          // Extract VERIFY command
          const verifyMatch = taskSection.match(/VERIFY:\n([\s\S]*?)```/);
          const verifyCommand = verifyMatch ? verifyMatch[1].trim() : null;

          // Mark as IN_PROGRESS
          let updatedContent = content.replace(
            `### ${taskId}: ${headerMatch[1]} ${headerMatch[2]}`,
            `### ${taskId}: ${headerMatch[1]} 🟡 IN_PROGRESS`
          );
          await fs.writeFile(QUEUE_PATH, updatedContent);
          await logAudit({ type: 'refactor_task_start', taskId, title: headerMatch[1] });

          // Delegate to Worker (using the worker architecture for safety)
          console.log(`[SYNTROPY] Delegating refactor task ${taskId} to Worker...`);

          const workerTask = `REFACTORING TASK ${taskId}: ${headerMatch[1]}

${instructions}

After completing the task:
0. Analyze possible side effects and ensure no regressions
0.1 Run existing tests to confirm nothing is broken
0.2 Review code quality and maintainability improvements
0.3 Update all related documentation if applicable
1. Run the verification command if provided
2. Update REFACTOR_QUEUE.md to mark the task as ✅ DONE or ❌ FAILED
3. Update the "Last Processed" timestamp

4. Commit ALL changes (Code + Queue):
   git config --global user.email "bot@syntropy.io"
   git config --global user.name "Syntropy Bot"
   git config --global --add safe.directory /pixel
   git add .
   git commit -m "refactor(${taskId}): ${headerMatch[1]}"

VERIFICATION COMMAND:
${verifyCommand || 'No verification specified - manually confirm changes work'}

IMPORTANT: After you finish, update /pixel/REFACTOR_QUEUE.md:
- Change "🟡 IN_PROGRESS" to "✅ DONE" (if successful) or "❌ FAILED" (if failed)
- Update "**Last Processed**:" with current timestamp and task ID`;

          // Use the worker tools directly
          const { spawnWorkerInternal } = await import('../worker-tools');
          const workerResult = await spawnWorkerInternal({
            task: workerTask,
            context: `Refactoring task from REFACTOR_QUEUE.md. Task ID: ${taskId}`,
            priority: 'normal'
          });

          if ('error' in workerResult) {
            // Worker spawn failed - revert to READY status
            const revertContent = await fs.readFile(QUEUE_PATH, 'utf-8');
            const revertedContent = revertContent.replace(
              `### ${taskId}: ${headerMatch[1]} 🟡 IN_PROGRESS`,
              `### ${taskId}: ${headerMatch[1]} ⬜ READY`
            );
            await fs.writeFile(QUEUE_PATH, revertedContent);

            return {
              error: `Failed to spawn worker: ${workerResult.error}`,
              taskId,
              status: 'Reverted to READY'
            };
          }

          // Worker spawned successfully - it will update the queue when done
          return {
            taskId,
            status: '🟡 IN_PROGRESS',
            workerTaskId: workerResult.taskId,
            message: `Worker spawned for ${taskId}. Use checkWorkerStatus("${workerResult.taskId}") to monitor progress. Worker will update REFACTOR_QUEUE.md when complete.`
          };
        }

        return { error: 'Invalid action' };
      } catch (error: any) {
        await logAudit({ type: 'refactor_queue_error', error: error.message });
        return { error: error.message };
      }
    }
  }),

  addRefactorTask: tool({
    description: `Add a NEW atomic refactoring task to REFACTOR_QUEUE.md. Use this when you discover:
- Code quality issues that should be fixed
- Large files that need splitting
- Missing tests that should be added
- Documentation gaps
- Duplicate code that should be consolidated
- New features that require architectural prep

GUIDELINES FOR GOOD TASKS:
1. ATOMIC: Completable in one Opencode session (5-30 minutes)
2. SPECIFIC: Clear instructions, not vague like "improve code"
3. SAFE: Include verification command to confirm success
4. DEPENDENCY-AWARE: If task depends on others, specify them

The task will be appended to the queue with the next available ID.`,
    inputSchema: z.object({
      title: z.string().describe("Short title (e.g., 'Extract payment routes')"),
      phase: z.string().describe("Which phase/section (e.g., 'Phase 2: API Routes' or 'Phase 4: New Tasks')"),
      effort: z.string().describe("Estimated effort (e.g., '20 min', '1 hour')"),
      risk: z.enum(['None', 'Low', 'Medium', 'High']).describe("Risk level of this change"),
      parallelSafe: z.boolean().describe("Can this task run in parallel with others?"),
      depends: z.string().optional().describe("Task IDs this depends on (e.g., 'T024' or 'T024, T025')"),
      instructions: z.string().describe("Detailed step-by-step instructions for Opencode"),
      verifyCommand: z.string().describe("Shell command to verify success (e.g., 'npm test')")
    }),
    execute: async ({ title, phase, effort, risk, parallelSafe, depends, instructions, verifyCommand }) => {
      const QUEUE_PATH = path.resolve(PIXEL_ROOT, 'REFACTOR_QUEUE.md');
      console.log(`[SYNTROPY] Tool: addRefactorTask (${title})`);

      try {
        if (!fs.existsSync(QUEUE_PATH)) {
          return { error: 'REFACTOR_QUEUE.md not found. Create it first.' };
        }

        const content = await fs.readFile(QUEUE_PATH, 'utf-8');

        // Find the highest task ID
        const taskIds = content.match(/### T(\d{3}):/g) || [];
        const maxId = taskIds.reduce((max, id) => {
          const num = parseInt(id.match(/T(\d{3})/)?.[1] || '0');
          return Math.max(max, num);
        }, 0);

        const newTaskId = `T${String(maxId + 1).padStart(3, '0')}`;

        // Find or create the phase section
        const phaseHeader = `## 📋 ${phase}`;
        let insertPosition: number;

        if (content.includes(phaseHeader)) {
          // Find the end of this phase section (before next ## or end of file)
          const phaseStart = content.indexOf(phaseHeader);
          const nextSection = content.slice(phaseStart + phaseHeader.length).search(/\n## /);
          insertPosition = nextSection === -1
            ? content.length
            : phaseStart + phaseHeader.length + nextSection;
        } else {
          // Create new phase section at the end, before any footer content
          const footerMatch = content.match(/\n---\n\n\*This queue/);
          insertPosition = footerMatch?.index || content.length;
        }

        // Build the new task block
        const dependsLine = depends ? `\n**Depends**: ${depends}` : '';
        const newTask = `

### ${newTaskId}: ${title} ⬜ READY
**Effort**: ${effort} | **Risk**: ${risk} | **Parallel-Safe**: ${parallelSafe ? '✅' : '❌'}${dependsLine}

\`\`\`
INSTRUCTIONS:
${instructions}

VERIFY:
${verifyCommand}
\`\`\`

---
`;

        // Insert the task
        let newContent: string;
        if (!content.includes(phaseHeader)) {
          // Add new phase section
          const newPhase = `\n${phaseHeader}\n${newTask}`;
          newContent = content.slice(0, insertPosition) + newPhase + content.slice(insertPosition);
        } else {
          newContent = content.slice(0, insertPosition) + newTask + content.slice(insertPosition);
        }

        // Update the READY count in the status table
        const readyCount = (newContent.match(/⬜ READY/g) || []).length;
        newContent = newContent.replace(
          /\| ⬜ READY \| \d+ \|/,
          `| ⬜ READY | ${readyCount} |`
        );

        await fs.writeFile(QUEUE_PATH, newContent);
        await logAudit({
          type: 'refactor_task_added',
          taskId: newTaskId,
          title,
          phase,
          risk
        });

        return {
          success: true,
          taskId: newTaskId,
          title,
          phase,
          message: `Task ${newTaskId} added to queue. Total READY tasks: ${readyCount}`
        };
      } catch (error: any) {
        await logAudit({ type: 'refactor_task_add_error', error: error.message });
        return { error: error.message };
      }
    }
  }),

  analyzeForRefactoring: tool({
    description: `Analyze the codebase to discover potential refactoring opportunities. Use this to intelligently grow the refactor queue.

This tool will scan for common issues:
- Large files (>500 lines)
- Deeply nested code
- Duplicate patterns
- Missing test coverage
- Outdated dependencies

Returns suggestions that you can then add via 'addRefactorTask'.`,
    inputSchema: z.object({
      target: z.enum(['plugin-nostr', 'syntropy-core', 'lnpixels-api', 'all']).describe("Which component to analyze"),
      focusArea: z.enum(['file-size', 'complexity', 'test-coverage', 'dependencies', 'all']).describe("What aspect to focus on")
    }),
    execute: async ({ target, focusArea }) => {
      console.log(`[SYNTROPY] Tool: analyzeForRefactoring (${target}, ${focusArea})`);

      try {
        const suggestions: Array<{
          file: string;
          issue: string;
          suggestion: string;
          effort: string;
          priority: string;
        }> = [];

        // Check existing tasks to avoid duplicates - ONLY check active queue
        const queuePath = path.resolve(PIXEL_ROOT, 'REFACTOR_QUEUE.md');
        const queueContent = fs.existsSync(queuePath) ? await fs.readFile(queuePath, 'utf-8') : '';

        // Helper to check if file processing is currently queued
        const isAlreadyTracked = (filePath: string) => {
          // Check if the filename appears in the active queue
          const relativePath = filePath.replace(PIXEL_ROOT, '');
          return queueContent.includes(relativePath) || queueContent.includes(path.basename(filePath));
        };

        // Define target paths
        const targetPaths: Record<string, string> = {
          'plugin-nostr': path.resolve(PIXEL_ROOT, 'pixel-agent/plugin-nostr/lib'),
          'syntropy-core': path.resolve(PIXEL_ROOT, 'syntropy-core/src'),
          'lnpixels-api': path.resolve(PIXEL_ROOT, 'lnpixels/api/src'),
          'all': PIXEL_ROOT
        };

        const scanPath = targetPaths[target];

        // File size analysis
        if (focusArea === 'file-size' || focusArea === 'all') {
          try {
            const { stdout } = await execAsync(
              `find ${scanPath} -name "*.js" -o -name "*.ts" | xargs wc -l 2>/dev/null | sort -rn | head -10`,
              { timeout: 30000 }
            );

            const lines = stdout.trim().split('\n');
            for (const line of lines) {
              const match = line.trim().match(/^(\d+)\s+(.+)$/);
              if (match && parseInt(match[1]) > 500 && !match[2].includes('node_modules') && !match[2].includes('total')) {
                const lineCount = parseInt(match[1]);
                const filePath = match[2];
                const fileName = path.basename(filePath);

                if (!isAlreadyTracked(filePath)) {
                  suggestions.push({
                    file: filePath.replace(PIXEL_ROOT, ''),
                    issue: `Large file: ${lineCount} lines`,
                    suggestion: `Split ${fileName} into smaller focused modules`,
                    effort: lineCount > 2000 ? '2-4 hours' : lineCount > 1000 ? '1-2 hours' : '30-60 min',
                    priority: lineCount > 2000 ? 'High' : lineCount > 1000 ? 'Medium' : 'Low'
                  });
                }
              }
            }
          } catch (e) {
            // File analysis failed, continue
          }
        }

        // Test coverage analysis
        if (focusArea === 'test-coverage' || focusArea === 'all') {
          try {
            // Find source files without corresponding test files
            const { stdout: srcFiles } = await execAsync(
              `find ${scanPath} -name "*.ts" -o -name "*.js" | grep -v node_modules | grep -v test | grep -v ".test." | head -20`,
              { timeout: 15000 }
            );

            for (const srcFile of srcFiles.trim().split('\n').filter(Boolean)) {
              const baseName = path.basename(srcFile).replace(/\.(ts|js)$/, '');
              const testDir = path.dirname(srcFile).replace('/src', '/test');
              const testFile1 = path.join(testDir, `${baseName}.test.js`);
              const testFile2 = path.join(testDir, `${baseName}.test.ts`);

              if (!fs.existsSync(testFile1) && !fs.existsSync(testFile2)) {
                if (!isAlreadyTracked(srcFile)) {
                  suggestions.push({
                    file: srcFile.replace(PIXEL_ROOT, ''),
                    issue: 'No test file found',
                    suggestion: `Create test file for ${baseName}`,
                    effort: '30-60 min',
                    priority: 'Medium'
                  });
                }
              }
            }
          } catch (e) {
            // Test analysis failed, continue
          }
        }

        await logAudit({
          type: 'refactoring_analysis',
          target,
          focusArea,
          suggestionsCount: suggestions.length
        });

        return {
          target,
          focusArea,
          suggestionsCount: suggestions.length,
          suggestions: suggestions.slice(0, 10), // Limit to top 10
          nextStep: suggestions.length > 0
            ? "Review suggestions and use 'addRefactorTask' to add worthy items to the queue"
            : "No obvious refactoring opportunities found in this area"
        };
      } catch (error: any) {
        return { error: error.message };
      }
    }
  }),

  verifyQueueArchiveSync: tool({
    description: `Verify that REFACTOR_QUEUE.md and REFACTOR_ARCHIVE.md are in sync.
    
Checks for:
1. Tasks marked READY in queue but DONE in archive (should not be retried)
2. Tasks marked DONE in queue but not in archive (should be archived)
3. Tasks marked IN_PROGRESS for too long (might be stuck)

Use action='check' to see issues, action='fix' to auto-repair inconsistencies.`,
    inputSchema: z.object({
      action: z.enum(['check', 'fix']).describe("'check' to see issues, 'fix' to auto-repair"),
    }),
    execute: async ({ action }) => {
      const QUEUE_PATH = path.resolve(PIXEL_ROOT, 'REFACTOR_QUEUE.md');
      const ARCHIVE_PATH = path.resolve(PIXEL_ROOT, 'REFACTOR_ARCHIVE.md');
      console.log(`[SYNTROPY] Tool: verifyQueueArchiveSync (action=${action})`);

      try {
        if (!fs.existsSync(QUEUE_PATH)) {
          return { error: 'REFACTOR_QUEUE.md not found.' };
        }
        if (!fs.existsSync(ARCHIVE_PATH)) {
          return { error: 'REFACTOR_ARCHIVE.md not found.' };
        }

        const queueContent = await fs.readFile(QUEUE_PATH, 'utf-8');
        const archiveContent = await fs.readFile(ARCHIVE_PATH, 'utf-8');

        // Parse tasks from queue
        const queueTaskPattern = /### (T\d{3}[ab]?): ([^\n]+) (⬜ READY|🟡 IN_PROGRESS|✅ DONE|❌ FAILED)/g;
        const queueTasks: Array<{ id: string; title: string; status: string }> = [];
        let queueMatch;
        while ((queueMatch = queueTaskPattern.exec(queueContent)) !== null) {
          queueTasks.push({ id: queueMatch[1], title: queueMatch[2], status: queueMatch[3] });
        }

        // Parse tasks from archive (format: | **T001** | ✅ DONE | Title | Date |)
        const archiveTaskPattern = /\*\*(T\d{3}[ab]?)\*\* \| ✅ DONE/g;
        const archivedTaskIds: string[] = [];
        let archiveMatch;
        while ((archiveMatch = archiveTaskPattern.exec(archiveContent)) !== null) {
          archivedTaskIds.push(archiveMatch[1]);
        }

        const issues: Array<{ type: string; taskId: string; title?: string; message: string }> = [];

        // Check 1: Tasks READY in queue but DONE in archive
        const readyTasks = queueTasks.filter(t => t.status === '⬜ READY');
        for (const task of readyTasks) {
          if (archivedTaskIds.includes(task.id)) {
            issues.push({
              type: 'ready_but_archived',
              taskId: task.id,
              title: task.title,
              message: `${task.id} is READY in queue but already DONE in archive - will cause duplicate processing!`
            });
          }
        }

        // Check 2: Tasks DONE in queue but not in archive
        const doneTasks = queueTasks.filter(t => t.status === '✅ DONE');
        for (const task of doneTasks) {
          if (!archivedTaskIds.includes(task.id)) {
            issues.push({
              type: 'done_not_archived',
              taskId: task.id,
              title: task.title,
              message: `${task.id} is DONE in queue but not in archive - should be archived for history`
            });
          }
        }

        // Check 3: Tasks IN_PROGRESS (might be stuck)
        const inProgressTasks = queueTasks.filter(t => t.status === '🟡 IN_PROGRESS');
        for (const task of inProgressTasks) {
          issues.push({
            type: 'in_progress',
            taskId: task.id,
            title: task.title,
            message: `${task.id} is IN_PROGRESS - verify worker is running or mark as DONE/FAILED`
          });
        }

        if (action === 'check') {
          return {
            healthy: issues.length === 0,
            issueCount: issues.length,
            issues,
            queueStats: {
              ready: readyTasks.length,
              inProgress: inProgressTasks.length,
              done: doneTasks.length,
              total: queueTasks.length
            },
            archiveStats: {
              total: archivedTaskIds.length
            },
            message: issues.length === 0
              ? 'Queue and archive are in sync!'
              : `Found ${issues.length} issue(s) that may cause problems. Use action='fix' to auto-repair.`
          };
        }

        if (action === 'fix') {
          let updatedQueue = queueContent;
          let fixedCount = 0;

          // Fix issues type 'ready_but_archived' - mark as DONE in queue
          for (const issue of issues.filter(i => i.type === 'ready_but_archived')) {
            const pattern = new RegExp(
              `### ${issue.taskId}: ${issue.title?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ⬜ READY`
            );
            if (pattern.test(updatedQueue)) {
              updatedQueue = updatedQueue.replace(
                pattern,
                `### ${issue.taskId}: ${issue.title} ✅ DONE`
              );
              fixedCount++;
            }
          }

          // Update status counts
          const newReadyCount = (updatedQueue.match(/### T\d{3}[ab]?: [^\n]+ ⬜ READY/g) || []).length;
          const newDoneCount = (updatedQueue.match(/### T\d{3}[ab]?: [^\n]+ ✅ DONE/g) || []).length;

          updatedQueue = updatedQueue.replace(
            /\| ⬜ READY \| \d+ \|/,
            `| ⬜ READY | ${newReadyCount} |`
          );
          updatedQueue = updatedQueue.replace(
            /\| ✅ DONE \| \d+ \|/,
            `| ✅ DONE | ${newDoneCount} |`
          );

          await fs.writeFile(QUEUE_PATH, updatedQueue);
          await logAudit({
            type: 'queue_archive_sync_fix',
            fixedCount,
            issues: issues.map(i => ({ type: i.type, taskId: i.taskId }))
          });

          return {
            success: true,
            fixedCount,
            remaining: issues.length - fixedCount,
            message: fixedCount > 0
              ? `Fixed ${fixedCount} issue(s). Queue is now synced with archive.`
              : 'No auto-fixable issues found. Manual review may be needed for remaining issues.'
          };
        }

        return { error: 'Invalid action' };
      } catch (error: any) {
        await logAudit({ type: 'queue_archive_sync_error', error: error.message });
        return { error: error.message };
      }
    }
  })
};
