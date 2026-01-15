import { describe, it, expect, mock, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import * as path from 'path';
import * as fs from 'fs-extra';

// Setup local test root for isolation
const TEST_ROOT = path.resolve(process.cwd(), "test-data-diary");

// Mock dependencies MUST be defined before importing the module that uses them
mock.module('../worker-manager', () => ({
    spawnWorkerInternal: async (params: any) => ({
        success: true,
        taskId: 'test-task-id',
        containerName: 'test-worker',
        status: 'spawned',
        message: 'Worker spawned'
    })
}));

mock.module('../utils', () => ({
    logAudit: async () => { }
}));

mock.module('../config', () => ({
    PIXEL_ROOT: TEST_ROOT
}));

describe('Diary Tools - Synthesis', () => {
    const diaryDir = path.resolve(TEST_ROOT, 'pixel-agent/docs/v1/diary');
    const testDate = '2026-Jan-04';
    const filePath = path.join(diaryDir, `${testDate}.md`);

    beforeAll(async () => {
        await fs.ensureDir(diaryDir);
    });

    afterAll(async () => {
        await fs.remove(TEST_ROOT);
    });

    beforeEach(async () => {
        await fs.writeFile(filePath, '# Test Diary\n\nSome content for synthesis.');
    });

    it.skip('should spawn a synthesis worker for an existing diary file', async () => {
        process.env.PIXEL_ROOT = TEST_ROOT;
        const { diaryTools } = await import('./diary');

        // @ts-ignore
        const result: any = await diaryTools.synthesizeDiary.execute({ targetDate: testDate }, { toolCallId: 'test', messages: [] });

        expect(result).toHaveProperty('success', true);
        expect(result).toHaveProperty('workerTaskId', 'test-task-id');
    });

    it('should return an error if the diary file does not exist', async () => {
        process.env.PIXEL_ROOT = TEST_ROOT;
        const { diaryTools } = await import('./diary');
        // @ts-ignore
        const result: any = await diaryTools.synthesizeDiary.execute({ targetDate: 'non-existent-date' }, { toolCallId: 'test', messages: [] });

        expect(result).toHaveProperty('error');
        expect(result.error).toContain('not found');
    });
});
