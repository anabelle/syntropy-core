import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { diaryTools } from './diary';
import * as fs from 'fs-extra';
import * as path from 'path';
import { PIXEL_ROOT } from '../config';

// Mock dependencies
mock.module('../worker-tools', () => ({
    spawnWorkerInternal: async (params: any) => ({
        taskId: 'test-task-id',
        containerName: 'test-worker',
        status: 'spawned',
        message: 'Worker spawned'
    })
}));

mock.module('../utils', () => ({
    logAudit: async () => { }
}));

describe('Diary Tools - Synthesis', () => {
    const testDate = '2026-Jan-04';
    const diaryDir = path.resolve(PIXEL_ROOT, 'pixel-agent/docs/v1/diary');
    const filePath = path.join(diaryDir, `${testDate}.md`);

    beforeEach(async () => {
        await fs.ensureDir(diaryDir);
        await fs.writeFile(filePath, '# Test Diary\n\nSome content for synthesis.');
    });

    afterEach(async () => {
        // We don't necessarily want to delete real files if PIXEL_ROOT is real
        // But in tests it should be a sandbox
    });

    it('should spawn a synthesis worker for an existing diary file', async () => {
        // @ts-ignore
        const result: any = await diaryTools.synthesizeDiary.execute({ targetDate: testDate }, { toolCallId: 'test', messages: [] });

        expect(result).toHaveProperty('success', true);
        expect(result).toHaveProperty('workerTaskId', 'test-task-id');
    });

    it('should return an error if the diary file does not exist', async () => {
        // @ts-ignore
        const result: any = await diaryTools.synthesizeDiary.execute({ targetDate: 'non-existent-date' }, { toolCallId: 'test', messages: [] });

        expect(result).toHaveProperty('error');
        expect(result.error).toContain('not found');
    });
});
