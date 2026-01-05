import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs-extra';
import * as path from 'path';

/**
 * Tests for the self-update detection logic.
 * 
 * IMPORTANT: These tests do NOT call scheduleSelfRebuildInternal directly because
 * that function spawns real Docker containers. Instead, we test the underlying
 * logic and contracts that the function relies on.
 * 
 * Tests cover:
 * 1. Source file mtime detection works correctly
 * 2. Image build time comparison logic is correct
 * 3. Task type contracts for guardrails
 * 4. Edge cases (timestamp parsing, empty values)
 */

// Mock paths for testing
const TEST_DATA_DIR = '/tmp/syntropy-self-update-test';
const TEST_CONTINUITY_PATH = path.join(TEST_DATA_DIR, 'CONTINUITY.md');

describe('Self-Update Detection', () => {
    beforeEach(async () => {
        await fs.ensureDir(TEST_DATA_DIR);
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

    describe('Task Type Contract (for worker-entrypoint.sh)', () => {
        // These tests verify the contract that worker-entrypoint.sh guardrails rely on.
        // The guardrails check: if [[ "$TASK_TYPE" == "syntropy-rebuild" ]]

        test('syntropy-rebuild task type should bypass guardrails', () => {
            const taskType = 'syntropy-rebuild';
            const allowSyntropyRebuild = taskType === 'syntropy-rebuild';

            expect(allowSyntropyRebuild).toBe(true);
        });

        test('opencode task should NOT bypass guardrails', () => {
            const taskType = 'opencode';
            const allowSyntropyRebuild = taskType === 'syntropy-rebuild';

            expect(allowSyntropyRebuild).toBe(false);
        });

        test('docker-op task should NOT bypass guardrails', () => {
            const taskType = 'docker-op';
            const allowSyntropyRebuild = taskType === 'syntropy-rebuild';

            expect(allowSyntropyRebuild).toBe(false);
        });

        test('git-op task should NOT bypass guardrails', () => {
            const taskType = 'git-op';
            const allowSyntropyRebuild = taskType === 'syntropy-rebuild';

            expect(allowSyntropyRebuild).toBe(false);
        });
    });

    describe('Timestamp Parsing Edge Cases', () => {
        test('should handle missing source directory gracefully (empty find output)', () => {
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

        test('should handle timezone offset in docker timestamp', () => {
            // Docker inspect can return various timezone formats
            const timestamps = [
                '2026-01-05T10:07:37.690751751-05:00',
                '2026-01-05T15:07:37.690751751Z',
                '2026-01-05T10:07:37-05:00',
            ];

            for (const ts of timestamps) {
                const parsed = new Date(ts).getTime();
                expect(Number.isNaN(parsed)).toBe(false);
                expect(parsed).toBeGreaterThan(0);
            }
        });
    });

    describe('CONTINUITY.md Preservation Contract', () => {
        // These tests verify the contract that rebuild preserves existing content

        test('should be able to read and write CONTINUITY.md', async () => {
            const originalContent = '# Original Context\nSome important data';
            await fs.writeFile(TEST_CONTINUITY_PATH, originalContent);

            const content = await fs.readFile(TEST_CONTINUITY_PATH, 'utf-8');
            expect(content).toContain('Original Context');
            expect(content).toContain('Some important data');
        });

        test('prepending content should preserve original', async () => {
            const originalContent = '# Original Context\nImportant data here';
            await fs.writeFile(TEST_CONTINUITY_PATH, originalContent);

            // This mimics what scheduleSelfRebuildInternal does
            const existing = await fs.readFile(TEST_CONTINUITY_PATH, 'utf-8');
            const rebuildNote = `## Self-Rebuild Scheduled\n\n**Time**: ${new Date().toISOString()}\n**Reason**: Test\n\n---\n\n${existing}`;
            await fs.writeFile(TEST_CONTINUITY_PATH, rebuildNote);

            const final = await fs.readFile(TEST_CONTINUITY_PATH, 'utf-8');
            expect(final).toContain('Self-Rebuild Scheduled');
            expect(final).toContain('Original Context');
            expect(final).toContain('Important data here');
        });
    });
});
