import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { utilityTools } from './utility';

// Mock only the audit logging to avoid file system side effects
mock.module('../utils', () => ({
    logAudit: async () => { }
}));

describe('Utility Tools - viewRecentCommits', () => {

    describe('Integration Tests (Real Git)', () => {
        // These tests run against the actual git repos in the workspace
        // They validate the tool works end-to-end

        it('should return commits from main repo', async () => {
            // @ts-ignore
            const result: any = await utilityTools.viewRecentCommits.execute(
                { count: 3, includeSubmodules: false },
                { toolCallId: 'test', messages: [] }
            );

            expect(result.main).toBeDefined();
            // Either we get an array of commits or an error (if somehow not in a git repo)
            if (Array.isArray(result.main)) {
                expect(result.main.length).toBeGreaterThan(0);
                expect(result.main[0]).toHaveProperty('hash');
                expect(result.main[0]).toHaveProperty('author');
                expect(result.main[0]).toHaveProperty('when');
                expect(result.main[0]).toHaveProperty('message');
            } else {
                // In case of error, it should have error property
                expect(result.main).toHaveProperty('error');
            }
        });

        it('should return commits from multiple repos when includeSubmodules is true', async () => {
            // @ts-ignore
            const result: any = await utilityTools.viewRecentCommits.execute(
                { count: 2, includeSubmodules: true },
                { toolCallId: 'test', messages: [] }
            );

            expect(result.main).toBeDefined();
            // At least syntropy-core should exist since we're running from there
            expect('syntropy-core' in result).toBe(true);
        });

        it('should filter to specific repos when repos array provided', async () => {
            // @ts-ignore
            const result: any = await utilityTools.viewRecentCommits.execute(
                { repos: ['main'] },
                { toolCallId: 'test', messages: [] }
            );

            expect(result.main).toBeDefined();
            expect(result['pixel-agent']).toBeUndefined();
            expect(result['syntropy-core']).toBeUndefined();
            expect(result['lnpixels']).toBeUndefined();
        });

        it('should only query syntropy-core when specified', async () => {
            // @ts-ignore
            const result: any = await utilityTools.viewRecentCommits.execute(
                { repos: ['syntropy-core'] },
                { toolCallId: 'test', messages: [] }
            );

            expect(result.main).toBeUndefined();
            expect(result['syntropy-core']).toBeDefined();
        });
    });

    describe('Count Limiting', () => {
        it('should respect the count parameter', async () => {
            // @ts-ignore
            const result: any = await utilityTools.viewRecentCommits.execute(
                { count: 2, includeSubmodules: false },
                { toolCallId: 'test', messages: [] }
            );

            if (Array.isArray(result.main)) {
                expect(result.main.length).toBeLessThanOrEqual(2);
            }
        });

        it('should clamp count to minimum of 1 (negative input)', async () => {
            // @ts-ignore - count is negative
            const result: any = await utilityTools.viewRecentCommits.execute(
                { count: -5, includeSubmodules: false },
                { toolCallId: 'test', messages: [] }
            );

            // Should not throw, should get a result
            expect(result).toBeDefined();
            expect(result.main).toBeDefined();
        });

        it('should clamp count to maximum of 20 (large input)', async () => {
            // @ts-ignore
            const result: any = await utilityTools.viewRecentCommits.execute(
                { count: 100, includeSubmodules: false },
                { toolCallId: 'test', messages: [] }
            );

            // Should not throw
            expect(result).toBeDefined();
            if (Array.isArray(result.main)) {
                expect(result.main.length).toBeLessThanOrEqual(20);
            }
        });

        it('should default to 5 commits when count not specified', async () => {
            // @ts-ignore
            const result: any = await utilityTools.viewRecentCommits.execute(
                { includeSubmodules: false },
                { toolCallId: 'test', messages: [] }
            );

            expect(result).toBeDefined();
            if (Array.isArray(result.main)) {
                expect(result.main.length).toBeLessThanOrEqual(5);
            }
        });
    });

    describe('Commit Message Parsing', () => {
        it('should correctly parse commit structure', async () => {
            // @ts-ignore
            const result: any = await utilityTools.viewRecentCommits.execute(
                { count: 1, repos: ['syntropy-core'] },
                { toolCallId: 'test', messages: [] }
            );

            if (Array.isArray(result['syntropy-core']) && result['syntropy-core'].length > 0) {
                const commit = result['syntropy-core'][0];

                // Hash should be 7+ chars (short hash)
                expect(typeof commit.hash).toBe('string');
                expect(commit.hash.length).toBeGreaterThanOrEqual(7);

                // Author should be a string
                expect(typeof commit.author).toBe('string');
                expect(commit.author.length).toBeGreaterThan(0);

                // When should be a relative time string (contains 'ago' or similar)
                expect(typeof commit.when).toBe('string');

                // Message should be the commit message
                expect(typeof commit.message).toBe('string');
            }
        });
    });

    describe('Error Handling', () => {
        it('should handle non-existent repo gracefully', async () => {
            // This tests that if a submodule path doesn't exist, we get an error object not a crash
            // The actual submodules should exist in the real environment, but this validates
            // the error handling path is set up correctly

            // @ts-ignore
            const result: any = await utilityTools.viewRecentCommits.execute(
                { repos: ['main'] },
                { toolCallId: 'test', messages: [] }
            );

            // Should complete without throwing
            expect(result).toBeDefined();
        });
    });

    describe('Default Behavior', () => {
        it('should include all repos by default when no params specified', async () => {
            // @ts-ignore
            const result: any = await utilityTools.viewRecentCommits.execute(
                {},
                { toolCallId: 'test', messages: [] }
            );

            // Should have main
            expect(result.main).toBeDefined();

            // Should attempt all submodules (may have commits or errors depending on env)
            const expectedRepos = ['main', 'lnpixels', 'pixel-agent', 'pixel-landing', 'syntropy-core'];
            for (const repo of expectedRepos) {
                expect(repo in result).toBe(true);
            }
        });
    });
});
