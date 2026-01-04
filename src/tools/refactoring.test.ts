import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs-extra';
import * as path from 'path';

// Test directory for isolated tests
const TEST_PIXEL_ROOT = '/tmp/refactoring-test-root';

// Sample queue content for testing
const SAMPLE_QUEUE_HEADER = `# 🔄 Syntropy Refactor Queue

## 📊 Queue Status

| Status | Count | Description |
|--------|-------|-------------|
| ⬜ READY | 2 | Available for processing |
| 🟡 IN_PROGRESS | 0 | Currently being worked on |
| ✅ DONE | 1 | Completed successfully |
| ❌ FAILED | 0 | Failed, needs human review |

**Last Processed**: 2026-01-04T12:00Z (T001)

---

## 📋 Phase 0: Quick Wins

### T001: Test Task One ✅ DONE
**Effort**: 5 min | **Risk**: None | **Parallel-Safe**: ✅

\`\`\`
INSTRUCTIONS:
Echo hello world

VERIFY:
echo "OK"
\`\`\`

---

### T002: Test Task Two ⬜ READY
**Effort**: 5 min | **Risk**: None | **Parallel-Safe**: ✅

\`\`\`
INSTRUCTIONS:
Create a test file

VERIFY:
test -f /tmp/test.txt && echo "OK"
\`\`\`

---

### T003: Test Task Three ⬜ READY
**Effort**: 5 min | **Risk**: Low | **Parallel-Safe**: ❌
**Depends**: T002

\`\`\`
INSTRUCTIONS:
Delete the test file

VERIFY:
test ! -f /tmp/test.txt && echo "OK"
\`\`\`

---
`;

const SAMPLE_ARCHIVE = `# 🗄️ Syntropy Refactor Archive

**Purpose**: Historic log of completed autonomous refactoring tasks.

---

## 📜 Completed Tasks Log

### Phase 0: Quick Wins
| ID | Status | Title | Date |
|----|--------|-------|------|
| **T001** | ✅ DONE | Test Task One | 2026-01-04 |
`;

describe('Refactoring Tools', () => {
    beforeEach(async () => {
        await fs.ensureDir(TEST_PIXEL_ROOT);
    });

    afterEach(async () => {
        await fs.remove(TEST_PIXEL_ROOT);
    });

    describe('Queue Parsing', () => {
        it('should correctly parse task statuses from queue', async () => {
            const queuePath = path.join(TEST_PIXEL_ROOT, 'REFACTOR_QUEUE.md');
            await fs.writeFile(queuePath, SAMPLE_QUEUE_HEADER);

            const content = await fs.readFile(queuePath, 'utf-8');

            // Parse tasks using the same regex pattern as the tool
            const taskPattern = /### (T\d{3}): ([^\n]+) (⬜ READY|🟡 IN_PROGRESS|✅ DONE|❌ FAILED)/g;
            const tasks: Array<{ id: string, title: string, status: string }> = [];
            let match;

            while ((match = taskPattern.exec(content)) !== null) {
                tasks.push({ id: match[1], title: match[2], status: match[3] });
            }

            expect(tasks).toHaveLength(3);
            expect(tasks[0]).toEqual({ id: 'T001', title: 'Test Task One', status: '✅ DONE' });
            expect(tasks[1]).toEqual({ id: 'T002', title: 'Test Task Two', status: '⬜ READY' });
            expect(tasks[2]).toEqual({ id: 'T003', title: 'Test Task Three', status: '⬜ READY' });
        });

        it('should identify next READY task', async () => {
            const queuePath = path.join(TEST_PIXEL_ROOT, 'REFACTOR_QUEUE.md');
            await fs.writeFile(queuePath, SAMPLE_QUEUE_HEADER);

            const content = await fs.readFile(queuePath, 'utf-8');

            const taskPattern = /### (T\d{3}): ([^\n]+) (⬜ READY|🟡 IN_PROGRESS|✅ DONE|❌ FAILED)/g;
            const tasks: Array<{ id: string, title: string, status: string }> = [];
            let match;

            while ((match = taskPattern.exec(content)) !== null) {
                tasks.push({ id: match[1], title: match[2], status: match[3] });
            }

            const readyTasks = tasks.filter(t => t.status === '⬜ READY');
            expect(readyTasks).toHaveLength(2);
            expect(readyTasks[0].id).toBe('T002');
        });

        it('should detect IN_PROGRESS task', async () => {
            const queueWithInProgress = SAMPLE_QUEUE_HEADER.replace(
                'Test Task Two ⬜ READY',
                'Test Task Two 🟡 IN_PROGRESS'
            );
            const queuePath = path.join(TEST_PIXEL_ROOT, 'REFACTOR_QUEUE.md');
            await fs.writeFile(queuePath, queueWithInProgress);

            const content = await fs.readFile(queuePath, 'utf-8');

            const taskPattern = /### (T\d{3}): ([^\n]+) (⬜ READY|🟡 IN_PROGRESS|✅ DONE|❌ FAILED)/g;
            const tasks: Array<{ id: string, title: string, status: string }> = [];
            let match;

            while ((match = taskPattern.exec(content)) !== null) {
                tasks.push({ id: match[1], title: match[2], status: match[3] });
            }

            const inProgress = tasks.filter(t => t.status === '🟡 IN_PROGRESS');
            expect(inProgress).toHaveLength(1);
            expect(inProgress[0].id).toBe('T002');
        });
    });

    describe('Dependency Detection', () => {
        it('should detect task dependencies', async () => {
            const queuePath = path.join(TEST_PIXEL_ROOT, 'REFACTOR_QUEUE.md');
            await fs.writeFile(queuePath, SAMPLE_QUEUE_HEADER);

            const content = await fs.readFile(queuePath, 'utf-8');

            // Find T003 section and check for dependencies
            const t003Start = content.indexOf('### T003:');
            const t003Section = content.slice(t003Start, content.indexOf('---', t003Start + 10));

            const dependsMatch = t003Section.match(/\*\*Depends\*\*: (T\d{3}(?:[-,]\s*T\d{3})*)/);

            expect(dependsMatch).not.toBeNull();
            expect(dependsMatch![1]).toBe('T002');
        });

        it('should identify blocked tasks', async () => {
            const queuePath = path.join(TEST_PIXEL_ROOT, 'REFACTOR_QUEUE.md');
            await fs.writeFile(queuePath, SAMPLE_QUEUE_HEADER);

            const content = await fs.readFile(queuePath, 'utf-8');

            // Parse all tasks
            const taskPattern = /### (T\d{3}): ([^\n]+) (⬜ READY|🟡 IN_PROGRESS|✅ DONE|❌ FAILED)/g;
            const tasks: Array<{ id: string, title: string, status: string }> = [];
            let match;

            while ((match = taskPattern.exec(content)) !== null) {
                tasks.push({ id: match[1], title: match[2], status: match[3] });
            }

            const doneTasks = tasks.filter(t => t.status === '✅ DONE').map(t => t.id);

            // T003 depends on T002, which is not done
            expect(doneTasks).not.toContain('T002');

            // Therefore T003 should be considered blocked
            const t003Start = content.indexOf('### T003:');
            const t003Section = content.slice(t003Start, content.indexOf('---', t003Start + 10));
            const dependsMatch = t003Section.match(/\*\*Depends\*\*: (T\d{3}(?:[-,]\s*T\d{3})*)/);

            if (dependsMatch) {
                const deps = dependsMatch[1].match(/T\d{3}/g) || [];
                const blockedBy = deps.filter(d => !doneTasks.includes(d));
                expect(blockedBy).toContain('T002');
            }
        });
    });

    describe('Queue/Archive Synchronization', () => {
        it('should detect inconsistency between queue and archive', async () => {
            const queuePath = path.join(TEST_PIXEL_ROOT, 'REFACTOR_QUEUE.md');
            const archivePath = path.join(TEST_PIXEL_ROOT, 'REFACTOR_ARCHIVE.md');

            // Queue shows T001 as DONE and T002 as READY
            await fs.writeFile(queuePath, SAMPLE_QUEUE_HEADER);

            // Archive shows T001 as done
            await fs.writeFile(archivePath, SAMPLE_ARCHIVE);

            const queueContent = await fs.readFile(queuePath, 'utf-8');
            const archiveContent = await fs.readFile(archivePath, 'utf-8');

            // Find tasks marked DONE in archive
            const archiveTaskPattern = /\*\*(T\d{3})\*\* \| ✅ DONE/g;
            const archivedTasks: string[] = [];
            let archiveMatch;
            while ((archiveMatch = archiveTaskPattern.exec(archiveContent)) !== null) {
                archivedTasks.push(archiveMatch[1]);
            }

            // Find tasks marked READY in queue
            const queueTaskPattern = /### (T\d{3}): [^\n]+ ⬜ READY/g;
            const readyTasks: string[] = [];
            let queueMatch;
            while ((queueMatch = queueTaskPattern.exec(queueContent)) !== null) {
                readyTasks.push(queueMatch[1]);
            }

            // Check for inconsistency: task in archive but still READY in queue
            const inconsistent = readyTasks.filter(t => archivedTasks.includes(t));

            // T001 is done in queue, T002 and T003 are READY
            // Archive only has T001
            expect(archivedTasks).toContain('T001');
            expect(readyTasks).toContain('T002');
            expect(readyTasks).toContain('T003');
            expect(inconsistent).toHaveLength(0); // No inconsistency in this case
        });

        it('should flag tasks that are DONE in archive but READY in queue', async () => {
            const queuePath = path.join(TEST_PIXEL_ROOT, 'REFACTOR_QUEUE.md');
            const archivePath = path.join(TEST_PIXEL_ROOT, 'REFACTOR_ARCHIVE.md');

            // Simulate the bug: T002 is READY in queue but DONE in archive
            const buggyQueue = SAMPLE_QUEUE_HEADER;
            const buggyArchive = SAMPLE_ARCHIVE + `| **T002** | ✅ DONE | Test Task Two | 2026-01-04 |
`;

            await fs.writeFile(queuePath, buggyQueue);
            await fs.writeFile(archivePath, buggyArchive);

            const queueContent = await fs.readFile(queuePath, 'utf-8');
            const archiveContent = await fs.readFile(archivePath, 'utf-8');

            // Find tasks marked DONE in archive
            const archiveTaskPattern = /\*\*(T\d{3})\*\* \| ✅ DONE/g;
            const archivedTasks: string[] = [];
            let archiveMatch;
            while ((archiveMatch = archiveTaskPattern.exec(archiveContent)) !== null) {
                archivedTasks.push(archiveMatch[1]);
            }

            // Find tasks marked READY in queue
            const queueTaskPattern = /### (T\d{3}): [^\n]+ ⬜ READY/g;
            const readyTasks: string[] = [];
            let queueMatch;
            while ((queueMatch = queueTaskPattern.exec(queueContent)) !== null) {
                readyTasks.push(queueMatch[1]);
            }

            // This should detect the inconsistency
            const inconsistent = readyTasks.filter(t => archivedTasks.includes(t));

            expect(archivedTasks).toContain('T002');
            expect(readyTasks).toContain('T002');
            expect(inconsistent).toContain('T002');
            expect(inconsistent).toHaveLength(1);
        });
    });

    describe('Instructions Extraction', () => {
        it('should extract INSTRUCTIONS block from task', async () => {
            const queuePath = path.join(TEST_PIXEL_ROOT, 'REFACTOR_QUEUE.md');
            await fs.writeFile(queuePath, SAMPLE_QUEUE_HEADER);

            const content = await fs.readFile(queuePath, 'utf-8');

            // Find T002 section
            const t002Start = content.indexOf('### T002:');
            const nextTaskIndex = content.indexOf('### T003:', t002Start);
            const t002Section = content.slice(t002Start, nextTaskIndex);

            const instructionsMatch = t002Section.match(/```\nINSTRUCTIONS:\n([\s\S]*?)(?:\nVERIFY:|```)/);

            expect(instructionsMatch).not.toBeNull();
            expect(instructionsMatch![1].trim()).toBe('Create a test file');
        });

        it('should extract VERIFY command from task', async () => {
            const queuePath = path.join(TEST_PIXEL_ROOT, 'REFACTOR_QUEUE.md');
            await fs.writeFile(queuePath, SAMPLE_QUEUE_HEADER);

            const content = await fs.readFile(queuePath, 'utf-8');

            // Find T002 section
            const t002Start = content.indexOf('### T002:');
            const nextTaskIndex = content.indexOf('### T003:', t002Start);
            const t002Section = content.slice(t002Start, nextTaskIndex);

            const verifyMatch = t002Section.match(/VERIFY:\n([\s\S]*?)```/);

            expect(verifyMatch).not.toBeNull();
            expect(verifyMatch![1].trim()).toBe('test -f /tmp/test.txt && echo "OK"');
        });
    });

    describe('Status Updates', () => {
        it('should update task status from READY to IN_PROGRESS', async () => {
            const queuePath = path.join(TEST_PIXEL_ROOT, 'REFACTOR_QUEUE.md');
            await fs.writeFile(queuePath, SAMPLE_QUEUE_HEADER);

            let content = await fs.readFile(queuePath, 'utf-8');

            // Simulate status update
            content = content.replace(
                '### T002: Test Task Two ⬜ READY',
                '### T002: Test Task Two 🟡 IN_PROGRESS'
            );

            await fs.writeFile(queuePath, content);

            const updatedContent = await fs.readFile(queuePath, 'utf-8');
            expect(updatedContent).toContain('### T002: Test Task Two 🟡 IN_PROGRESS');
            expect(updatedContent).not.toContain('### T002: Test Task Two ⬜ READY');
        });

        it('should update task status from IN_PROGRESS to DONE', async () => {
            const queueWithInProgress = SAMPLE_QUEUE_HEADER.replace(
                'Test Task Two ⬜ READY',
                'Test Task Two 🟡 IN_PROGRESS'
            );
            const queuePath = path.join(TEST_PIXEL_ROOT, 'REFACTOR_QUEUE.md');
            await fs.writeFile(queuePath, queueWithInProgress);

            let content = await fs.readFile(queuePath, 'utf-8');

            // Simulate status update
            content = content.replace(
                '### T002: Test Task Two 🟡 IN_PROGRESS',
                '### T002: Test Task Two ✅ DONE'
            );

            await fs.writeFile(queuePath, content);

            const updatedContent = await fs.readFile(queuePath, 'utf-8');
            expect(updatedContent).toContain('### T002: Test Task Two ✅ DONE');
        });

        it('should update queue status counts after completion', async () => {
            const queuePath = path.join(TEST_PIXEL_ROOT, 'REFACTOR_QUEUE.md');
            await fs.writeFile(queuePath, SAMPLE_QUEUE_HEADER);

            let content = await fs.readFile(queuePath, 'utf-8');

            // Mark T002 as DONE
            content = content.replace(
                '### T002: Test Task Two ⬜ READY',
                '### T002: Test Task Two ✅ DONE'
            );

            // Update counts
            const readyCount = (content.match(/⬜ READY/g) || []).length - 1; // Subtract table header
            const doneCount = (content.match(/✅ DONE/g) || []).length - 1;

            content = content.replace(
                /\| ⬜ READY \| \d+ \|/,
                `| ⬜ READY | ${readyCount} |`
            );
            content = content.replace(
                /\| ✅ DONE \| \d+ \|/,
                `| ✅ DONE | ${doneCount} |`
            );

            await fs.writeFile(queuePath, content);

            const updatedContent = await fs.readFile(queuePath, 'utf-8');
            // Should now have 1 READY (T003) and 2 DONE (T001, T002)
            expect(updatedContent).toContain('| ⬜ READY | 1 |');
            expect(updatedContent).toContain('| ✅ DONE | 2 |');
        });
    });

    describe('Task ID Sequence', () => {
        it('should find the highest task ID', async () => {
            const queuePath = path.join(TEST_PIXEL_ROOT, 'REFACTOR_QUEUE.md');
            await fs.writeFile(queuePath, SAMPLE_QUEUE_HEADER);

            const content = await fs.readFile(queuePath, 'utf-8');

            const taskIds = content.match(/### T(\d{3}):/g) || [];
            const maxId = taskIds.reduce((max, id) => {
                const num = parseInt(id.match(/T(\d{3})/)?.[1] || '0');
                return Math.max(max, num);
            }, 0);

            expect(maxId).toBe(3);
        });

        it('should generate next task ID correctly', async () => {
            const queuePath = path.join(TEST_PIXEL_ROOT, 'REFACTOR_QUEUE.md');
            await fs.writeFile(queuePath, SAMPLE_QUEUE_HEADER);

            const content = await fs.readFile(queuePath, 'utf-8');

            const taskIds = content.match(/### T(\d{3}):/g) || [];
            const maxId = taskIds.reduce((max, id) => {
                const num = parseInt(id.match(/T(\d{3})/)?.[1] || '0');
                return Math.max(max, num);
            }, 0);

            const newTaskId = `T${String(maxId + 1).padStart(3, '0')}`;

            expect(newTaskId).toBe('T004');
        });
    });

    describe('Archive Consistency Check', () => {
        it('should verify archive has correct format', async () => {
            const archivePath = path.join(TEST_PIXEL_ROOT, 'REFACTOR_ARCHIVE.md');
            await fs.writeFile(archivePath, SAMPLE_ARCHIVE);

            const content = await fs.readFile(archivePath, 'utf-8');

            expect(content).toContain('# 🗄️ Syntropy Refactor Archive');
            expect(content).toContain('## 📜 Completed Tasks Log');
            expect(content).toContain('| ID | Status | Title | Date |');
        });

        it('should parse archived tasks correctly', async () => {
            const archivePath = path.join(TEST_PIXEL_ROOT, 'REFACTOR_ARCHIVE.md');
            await fs.writeFile(archivePath, SAMPLE_ARCHIVE);

            const content = await fs.readFile(archivePath, 'utf-8');

            const archiveTaskPattern = /\*\*(T\d{3})\*\* \| ✅ DONE \| ([^|]+) \| (\d{4}-\d{2}-\d{2})/g;
            const archivedTasks: Array<{ id: string, title: string, date: string }> = [];
            let match;

            while ((match = archiveTaskPattern.exec(content)) !== null) {
                archivedTasks.push({
                    id: match[1],
                    title: match[2].trim(),
                    date: match[3]
                });
            }

            expect(archivedTasks).toHaveLength(1);
            expect(archivedTasks[0]).toEqual({
                id: 'T001',
                title: 'Test Task One',
                date: '2026-01-04'
            });
        });
    });
});
