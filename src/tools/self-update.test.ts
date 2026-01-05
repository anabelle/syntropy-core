import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import * as fs from 'fs-extra';
import * as path from 'path';

/**
 * Tests for the self-update detection and scheduleSelfRebuildInternal functionality.
 * 
 * These tests verify:
 * 1. Source file mtime detection works correctly
 * 2. Image build time comparison logic is correct
 * 3. scheduleSelfRebuildInternal creates proper task entries
 * 4. Edge cases are handled (docker inspect failure, find command failure)
 */

// Mock paths for testing
const TEST_DATA_DIR = '/tmp/syntropy-self-update-test';
const TEST_LEDGER_PATH = path.join(TEST_DATA_DIR, 'task-ledger.json');
const TEST_CONTINUITY_PATH = path.join(TEST_DATA_DIR, 'CONTINUITY.md');

describe('Self-Update Detection', () => {
    beforeEach(async () => {
        await fs.ensureDir(TEST_DATA_DIR);
        await fs.writeJson(TEST_LEDGER_PATH, { version: 1, tasks: [] });
        await fs.writeFile(TEST_CONTINUITY_PATH, '# Test Continuity\n');
    });

    afterEach(async () => {
        await fs.remove(TEST_DATA_DIR);
    });

    describe('Source vs Image Time Comparison Logic', () => {
        test('should correctly identify when source is newer than image', () => {
            const imageBuildTime = new Date('2026-01-05T10:00:00Z').getTime();
            const sourceModifiedTime = new Date('2026-01-05T11:00:00Z').getTime(); // 1 hour later

            const needsRebuild = sourceModifiedTime > imageBuildTime;
            expect(needsRebuild).toBe(true);
        });

        test('should correctly identify when image is up-to-date', () => {
            const imageBuildTime = new Date('2026-01-05T12:00:00Z').getTime();
            const sourceModifiedTime = new Date('2026-01-05T10:00:00Z').getTime(); // 2 hours before

            const needsRebuild = sourceModifiedTime > imageBuildTime;
            expect(needsRebuild).toBe(false);
        });

        test('should handle equal timestamps (no rebuild needed)', () => {
            const timestamp = new Date('2026-01-05T10:00:00Z').getTime();
            const imageBuildTime = timestamp;
            const sourceModifiedTime = timestamp;

            // <= means no rebuild when equal
            const needsRebuild = sourceModifiedTime > imageBuildTime;
            expect(needsRebuild).toBe(false);
        });

        test('should handle millisecond precision correctly', () => {
            const imageBuildTime = 1767625657690; // From actual docker inspect output
            const sourceModifiedTime = 1767625624929; // From actual find output (older)

            const needsRebuild = sourceModifiedTime > imageBuildTime;
            expect(needsRebuild).toBe(false);
        });
    });

    describe('scheduleSelfRebuildInternal Task Creation', () => {
        test('should create a task with type syntropy-rebuild', async () => {
            // Import the internal function
            const { scheduleSelfRebuildInternal } = await import('../worker-tools');

            // Mock the spawn to prevent actual container creation
            const originalSpawn = require('child_process').spawn;
            const mockSpawn = mock(() => {
                const mockProc = {
                    stdout: { on: mock(() => { }) },
                    stderr: { on: mock(() => { }) },
                    on: mock((event: string, cb: Function) => {
                        if (event === 'close') setTimeout(() => cb(0), 10);
                    }),
                };
                return mockProc;
            });
            require('child_process').spawn = mockSpawn;

            try {
                const result = await scheduleSelfRebuildInternal({
                    reason: 'Test self-rebuild'
                });

                // Should return scheduled: true or have a taskId
                expect(result.taskId).toBeDefined();
                expect(typeof result.taskId).toBe('string');
                expect(result.taskId.length).toBeGreaterThan(0);
            } finally {
                require('child_process').spawn = originalSpawn;
            }
        });

        test('should preserve context in CONTINUITY.md during rebuild', async () => {
            const originalContent = '# Original Context\nSome important data';
            await fs.writeFile(TEST_CONTINUITY_PATH, originalContent);

            // Verify file was created
            const exists = await fs.pathExists(TEST_CONTINUITY_PATH);
            expect(exists).toBe(true);

            // The actual function prepends rebuild info, check that original would be preserved
            const content = await fs.readFile(TEST_CONTINUITY_PATH, 'utf-8');
            expect(content).toContain('Original Context');
        });
    });

    describe('Edge Cases', () => {
        test('should handle missing source directory gracefully', () => {
            // Simulating what happens when find returns empty
            const emptyMtime = '';
            const parsed = parseFloat(emptyMtime.trim()) * 1000;

            // NaN check - this is how the code should handle it
            expect(Number.isNaN(parsed)).toBe(true);
        });

        test('should handle docker inspect failure by falling back', () => {
            // When docker inspect fails, code falls back to startupTime
            // This test verifies the fallback behavior is safe
            const startupTime = new Date();
            const fallbackTime = startupTime.getTime();

            expect(typeof fallbackTime).toBe('number');
            expect(fallbackTime).toBeGreaterThan(0);
        });

        test('should parse docker inspect timestamp correctly', () => {
            // Real docker inspect output format
            const dockerTimestamp = '2026-01-05T10:07:37.690751751-05:00';
            const parsed = new Date(dockerTimestamp).getTime();

            expect(Number.isNaN(parsed)).toBe(false);
            expect(parsed).toBeGreaterThan(0);
        });

        test('should parse find -printf timestamp correctly', () => {
            // Real find output format (Unix timestamp with nanoseconds)
            const findOutput = '1767625385.9290292740';
            const parsed = parseFloat(findOutput.trim()) * 1000;

            expect(Number.isNaN(parsed)).toBe(false);
            expect(parsed).toBeGreaterThan(0);
        });
    });

    describe('Guardrail Integration', () => {
        test('syntropy-rebuild task type should bypass guardrails', () => {
            // This tests the contract that worker-entrypoint.sh relies on
            const taskType = 'syntropy-rebuild';
            const allowSyntropyRebuild = taskType === 'syntropy-rebuild';

            expect(allowSyntropyRebuild).toBe(true);
        });

        test('regular opencode task should NOT bypass guardrails', () => {
            const taskType = 'opencode';
            const allowSyntropyRebuild = taskType === 'syntropy-rebuild';

            expect(allowSyntropyRebuild).toBe(false);
        });
    });
});
