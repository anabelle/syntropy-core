
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as WorkerCore from '../worker-core.ts';
const { cleanupStaleTasksInternal } = WorkerCore;
import { PIXEL_ROOT } from '../config';

// Define the TaskLedger interface locally to match the source
interface Task {
    id: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'aborted';
    createdAt: string;
    completedAt?: string;
    type: 'opencode' | 'docker-op' | 'git-op' | 'syntropy-rebuild';
    payload: { task: string; context?: string; };
    attempts: number;
    maxAttempts: number;
    workerId?: string;
    exitCode?: number;
    output?: string;
    summary?: string;
    error?: string;
}

interface TaskLedger {
    version: number;
    tasks: Task[];
}

// Mock data paths
const MOCK_DATA_DIR = path.join(PIXEL_ROOT, 'data');
const MOCK_LEDGER_PATH = path.join(MOCK_DATA_DIR, 'task-ledger.json');

describe('Worker Cleanup Tool', () => {
    // We need to preserve the original fs methods
    const originalReadFile = fs.readFile;
    const originalWriteFile = fs.writeFile;
    const originalPathExists = fs.pathExists;
    const originalReaddir = fs.readdir;
    const originalRemove = fs.remove;
    const originalRename = fs.rename;
    const originalEnsureDir = fs.ensureDir;

    // Mock state
    let mockLedger: TaskLedger;
    let mockFiles: Set<string>;

    beforeEach(() => {
        mockLedger = { version: 1, tasks: [] };
        mockFiles = new Set();

        // Setup mocks
        spyOn(fs, 'pathExists').mockImplementation(async (p: string) => {
            if (p === MOCK_LEDGER_PATH) return true;
            if (p === MOCK_DATA_DIR) return true;
            if (mockFiles.has(p)) return true;
            return false;
        });

        spyOn(fs, 'readFile').mockImplementation(async (p: string) => {
            if (p === MOCK_LEDGER_PATH) {
                return JSON.stringify(mockLedger);
            }
            return '';
        });

        spyOn(fs, 'writeFile').mockImplementation(async (p: string, data: string) => {
            if (p.includes('task-ledger.json')) {
                // It writes to a tmp file first usually, but let's assume it updates our mock ledger
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.tasks) mockLedger = parsed;
                } catch (e) { }
            }
            return undefined;
        });

        spyOn(fs, 'rename').mockImplementation(async () => undefined);
        spyOn(fs, 'ensureDir').mockImplementation(async () => undefined);

        spyOn(fs, 'readdir').mockImplementation(async (p: string) => {
            if (p === MOCK_DATA_DIR) {
                // Return only filenames, not full paths
                return Array.from(mockFiles).map(f => path.basename(f));
            }
            return [];
        });

        spyOn(fs, 'remove').mockImplementation(async (p: string) => {
            mockFiles.delete(p);
            return undefined;
        });
    });

    afterEach(() => {
        // Restore original methods
        fs.pathExists.mockRestore();
        fs.readFile.mockRestore();
        fs.writeFile.mockRestore();
        fs.readdir.mockRestore();
        fs.remove.mockRestore();
        fs.rename.mockRestore();
        fs.ensureDir.mockRestore();
    });

    it('should remove old completed tasks', async () => {
        const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(); // 8 days ago

        mockLedger.tasks = [
            {
                id: 'old-task-1',
                status: 'completed',
                createdAt: oldDate,
                completedAt: oldDate,
                type: 'opencode',
                payload: { task: 'test' },
                attempts: 0,
                maxAttempts: 3
            },
            {
                id: 'new-task-1',
                status: 'completed',
                createdAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
                type: 'opencode',
                payload: { task: 'test' },
                attempts: 0,
                maxAttempts: 3
            }
        ];

        // Add output files for both
        const oldFile = path.join(MOCK_DATA_DIR, 'worker-output-old-task-1.txt');
        const newFile = path.join(MOCK_DATA_DIR, 'worker-output-new-task-1.txt');
        mockFiles.add(oldFile);
        mockFiles.add(newFile);

        const result = await cleanupStaleTasksInternal(7); // 7 days retention

        expect(result.removed).toBe(1);
        expect(result.remaining).toBe(1);

        // Ledger should only have the new task
        expect(mockLedger.tasks.find(t => t.id === 'old-task-1')).toBeUndefined();
        expect(mockLedger.tasks.find(t => t.id === 'new-task-1')).toBeDefined();

        // Output file for old task should be removed
        expect(mockFiles.has(oldFile)).toBe(false);
        expect(mockFiles.has(newFile)).toBe(true);
    });

    it('should remove orphaned output files', async () => {
        mockLedger.tasks = [
            {
                id: 'active-task',
                status: 'completed',
                createdAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
                type: 'opencode',
                payload: { task: 'test' },
                attempts: 0,
                maxAttempts: 3
            }
        ];

        // Create orphaned file (no task in ledger)
        const orphanFile = path.join(MOCK_DATA_DIR, 'worker-output-orphan-task.txt');
        // Create active file
        const activeFile = path.join(MOCK_DATA_DIR, 'worker-output-active-task.txt');

        mockFiles.add(orphanFile);
        mockFiles.add(activeFile);

        const result = await cleanupStaleTasksInternal(7);

        expect(result.orphaned).toBe(1);
        expect(mockFiles.has(orphanFile)).toBe(false);
        expect(mockFiles.has(activeFile)).toBe(true);
    });

    it('should handle both removal and orphan cleanup simultaneously', async () => {
        const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

        mockLedger.tasks = [
            {
                id: 'to-remove',
                status: 'completed',
                createdAt: oldDate,
                completedAt: oldDate,
                type: 'opencode',
                payload: { task: 'test' },
                attempts: 0,
                maxAttempts: 3
            }
        ];

        const removeFile = path.join(MOCK_DATA_DIR, 'worker-output-to-remove.txt');
        const orphanFile = path.join(MOCK_DATA_DIR, 'worker-output-orphan.txt');

        mockFiles.add(removeFile);
        mockFiles.add(orphanFile);

        const result = await cleanupStaleTasksInternal(7);

        // Should remove 'to-remove' (expired) AND 'orphan' (orphaned)
        expect(result.removed).toBe(1);
        expect(result.orphaned).toBe(1);
        expect(result.remaining).toBe(0);

        expect(mockFiles.has(removeFile)).toBe(false);
        expect(mockFiles.has(orphanFile)).toBe(false);
    });
});
