import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as WorkerCore from '../worker-manager';
import { PIXEL_ROOT } from '../config';

// Define the TaskLedger interface locally to match the source
interface Task {
    id: string;
    status: string;
    completedAt?: string;
    createdAt: string;
}

interface TaskLedger {
    tasks: Task[];
}

describe('Worker Cleanup Tool', () => {
    const MOCK_DATA_DIR = path.join(PIXEL_ROOT, 'data');
    const MOCK_LEDGER_PATH = path.join(MOCK_DATA_DIR, 'task-ledger.json');

    let mockFiles = new Map<string, string>();

    beforeEach(() => {
        mockFiles.clear();
        // Mock fs-extra methods
        mock.module('fs-extra', () => ({
            pathExists: async (p: string) => {
                if (p === MOCK_LEDGER_PATH) return true;
                if (p === MOCK_DATA_DIR) return true;
                return mockFiles.has(p);
            },
            readFile: async (p: string) => {
                if (p === MOCK_LEDGER_PATH) return mockFiles.get(p) || JSON.stringify({ version: 1, tasks: [] });
                return mockFiles.get(p) || '';
            },
            writeFile: async (p: string, content: string) => {
                mockFiles.set(p, content);
            },
            rename: async (from: string, to: string) => {
                if (mockFiles.has(from)) {
                    mockFiles.set(to, mockFiles.get(from)!);
                    mockFiles.delete(from);
                }
            },
            ensureDir: async () => { },
            remove: async (p: string) => {
                mockFiles.delete(p);
            },
            readdir: async (p: string) => {
                if (p === MOCK_DATA_DIR) {
                    return Array.from(mockFiles.keys())
                        .filter(f => f.startsWith(MOCK_DATA_DIR))
                        .map(f => path.basename(f));
                }
                return [];
            }
        }));

        // Reset the ledger with some tasks
        const now = Date.now();
        const ledger: TaskLedger = {
            tasks: [
                {
                    id: 'active-task',
                    status: 'running',
                    createdAt: new Date(now - 1000).toISOString()
                },
                {
                    id: 'to-remove',
                    status: 'completed',
                    completedAt: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString(), // 8 days ago
                    createdAt: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString()
                },
                {
                    id: 'to-keep',
                    status: 'completed',
                    completedAt: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(), // 1 day ago
                    createdAt: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString()
                }
            ]
        };
        mockFiles.set(MOCK_LEDGER_PATH, JSON.stringify(ledger));
        mockFiles.set(path.join(MOCK_DATA_DIR, 'worker-output-to-remove.txt'), 'some logs');
        mockFiles.set(path.join(MOCK_DATA_DIR, 'worker-output-to-keep.txt'), 'some logs');
        mockFiles.set(path.join(MOCK_DATA_DIR, 'worker-output-orphan.txt'), 'orphaned logs');
    });

    afterEach(() => {
        mock.restore();
    });

    it('should remove old completed tasks', async () => {
        // Run cleanup with 7 days retention
        const result = await WorkerCore.cleanupStaleTasksInternal(7);

        expect(result.success).toBe(true);
        expect(result.removed).toBe(1); // 'to-remove'
        expect(result.remaining).toBe(2); // 'active-task' and 'to-keep'

        const updatedLedger: TaskLedger = JSON.parse(mockFiles.get(MOCK_LEDGER_PATH)!);
        const taskIds = updatedLedger.tasks.map(t => t.id);
        expect(taskIds).toContain('active-task');
        expect(taskIds).toContain('to-keep');
        expect(taskIds).not.toContain('to-remove');

        // Check file removal
        expect(mockFiles.has(path.join(MOCK_DATA_DIR, 'worker-output-to-remove.txt'))).toBe(false);
        expect(mockFiles.has(path.join(MOCK_DATA_DIR, 'worker-output-to-keep.txt'))).toBe(true);
    });

    it('should remove orphaned output files', async () => {
        // Clear ledger to make 'worker-output-orphan.txt' orphaned
        const ledger: TaskLedger = { tasks: [] };
        mockFiles.set(MOCK_LEDGER_PATH, JSON.stringify(ledger));

        const result = await WorkerCore.cleanupStaleTasksInternal(7);

        expect(result.success).toBe(true);
        expect(result.orphaned).toBe(3); // to-remove, to-keep, and orphan (since ledger is empty)
        expect(mockFiles.has(path.join(MOCK_DATA_DIR, 'worker-output-orphan.txt'))).toBe(false);
    });

    it('should handle both removal and orphan cleanup simultaneously', async () => {
        const result = await WorkerCore.cleanupStaleTasksInternal(7);

        // 'to-remove' is removed via task cleanup (1)
        // 'worker-output-orphan.txt' is removed via orphan cleanup (1)
        expect(result.removed).toBe(1);
        expect(result.orphaned).toBe(1);
        expect(result.remaining).toBe(2);

        expect(mockFiles.has(path.join(MOCK_DATA_DIR, 'worker-output-orphan.txt'))).toBe(false);
        expect(mockFiles.has(path.join(MOCK_DATA_DIR, 'worker-output-to-remove.txt'))).toBe(false);
    });
});
