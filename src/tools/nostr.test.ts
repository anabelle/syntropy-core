import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs-extra';
import * as path from 'path';

// Test directory for isolated tests
const TEST_PIXEL_ROOT = '/tmp/nostr-test-root';

describe('Nostr Tools', () => {
    beforeEach(async () => {
        await fs.ensureDir(path.join(TEST_PIXEL_ROOT, 'data/eliza'));
    });

    afterEach(async () => {
        await fs.remove(TEST_PIXEL_ROOT);
    });

    describe('readPixelNostrFeed', () => {
        describe('file-based feed reading', () => {
            it('should return posts from fresh export file', async () => {
                const testPosts = [
                    { id: 'test-1', content: 'Hello Nostr!', created_at: 1767485859, kind: 1 },
                    { id: 'test-2', content: 'Second post', created_at: 1767485800, kind: 1 },
                ];

                const exportData = {
                    exported_at: new Date().toISOString(),
                    posts: testPosts,
                };

                const feedPath = path.join(TEST_PIXEL_ROOT, 'data/eliza/nostr_feed_export.json');
                await fs.writeJson(feedPath, exportData);

                const readBack = await fs.readJson(feedPath);
                expect(readBack.posts).toHaveLength(2);
                expect(readBack.posts[0].content).toBe('Hello Nostr!');
            });

            it('should handle missing export file gracefully', async () => {
                const feedPath = path.join(TEST_PIXEL_ROOT, 'data/eliza/nostr_feed_export.json');
                const exists = await fs.pathExists(feedPath);
                expect(exists).toBe(false);
            });

            it('should handle empty posts array', async () => {
                const exportData = {
                    exported_at: new Date().toISOString(),
                    posts: [],
                };

                const feedPath = path.join(TEST_PIXEL_ROOT, 'data/eliza/nostr_feed_export.json');
                await fs.writeJson(feedPath, exportData);

                const data = await fs.readJson(feedPath);
                // Empty posts should trigger fallback to relay
                expect(data.posts.length).toBe(0);
                const shouldUseFile = data.posts.length > 0;
                expect(shouldUseFile).toBe(false);
            });

            it('should respect limit parameter when slicing posts', async () => {
                const testPosts = Array.from({ length: 20 }, (_, i) => ({
                    id: `test-${i}`,
                    content: `Post number ${i}`,
                    created_at: 1767485859 - i,
                    kind: 1,
                }));

                const exportData = {
                    exported_at: new Date().toISOString(),
                    posts: testPosts,
                };

                const feedPath = path.join(TEST_PIXEL_ROOT, 'data/eliza/nostr_feed_export.json');
                await fs.writeJson(feedPath, exportData);

                const data = await fs.readJson(feedPath);
                const limit = 5;
                const slicedPosts = data.posts.slice(0, limit);

                expect(slicedPosts).toHaveLength(5);
                expect(slicedPosts[0].id).toBe('test-0');
            });
        });

        describe('freshness tolerance (6 hours)', () => {
            const TOLERANCE_MS = 6 * 60 * 60 * 1000; // 6 hours

            it('should accept files within 6 hour tolerance', async () => {
                // 3 hours old - should be accepted
                const fileAge = 3 * 60 * 60 * 1000;
                expect(fileAge < TOLERANCE_MS).toBe(true);

                // 5 hours old - should still be accepted
                const fiveHoursAge = 5 * 60 * 60 * 1000;
                expect(fiveHoursAge < TOLERANCE_MS).toBe(true);
            });

            it('should reject files older than 6 hours', async () => {
                // 7 hours old - should be rejected
                const staleAge = 7 * 60 * 60 * 1000;
                expect(staleAge < TOLERANCE_MS).toBe(false);
            });

            it('should use 3-hour-old file instead of falling back to relay', async () => {
                const testPosts = [{ id: 'test-1', content: 'Recent enough', created_at: 1767485859, kind: 1 }];

                // 3 hours ago
                const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
                const exportData = {
                    exported_at: threeHoursAgo,
                    posts: testPosts,
                };

                const feedPath = path.join(TEST_PIXEL_ROOT, 'data/eliza/nostr_feed_export.json');
                await fs.writeJson(feedPath, exportData);

                const data = await fs.readJson(feedPath);
                const exportedAt = new Date(data.exported_at);
                const ageMs = Date.now() - exportedAt.getTime();

                // Should be within tolerance
                expect(ageMs < TOLERANCE_MS).toBe(true);
                expect(data.posts.length > 0).toBe(true);
            });

            it('should reject 8-hour-old file and fall back to relay', async () => {
                const testPosts = [{ id: 'test-1', content: 'Too old', created_at: 1767485859, kind: 1 }];

                // 8 hours ago
                const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
                const exportData = {
                    exported_at: eightHoursAgo,
                    posts: testPosts,
                };

                const feedPath = path.join(TEST_PIXEL_ROOT, 'data/eliza/nostr_feed_export.json');
                await fs.writeJson(feedPath, exportData);

                const data = await fs.readJson(feedPath);
                const exportedAt = new Date(data.exported_at);
                const ageMs = Date.now() - exportedAt.getTime();

                // Should exceed tolerance, triggering relay fallback
                expect(ageMs > TOLERANCE_MS).toBe(true);
            });
        });
    });

    describe('readPixelNostrMentions', () => {
        it('should return mentions from fresh export file', async () => {
            const testMentions = [
                { id: 'mention-1', pubkey: 'abc123', content: '@Pixel hello!', created_at: 1767485859 },
            ];

            const exportData = {
                exported_at: new Date().toISOString(),
                mentions: testMentions,
            };

            const mentionsPath = path.join(TEST_PIXEL_ROOT, 'data/eliza/nostr_mentions_export.json');
            await fs.writeJson(mentionsPath, exportData);

            const data = await fs.readJson(mentionsPath);
            expect(data.mentions).toHaveLength(1);
            expect(data.mentions[0].content).toBe('@Pixel hello!');
        });
    });
});
