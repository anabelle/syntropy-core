/**
 * Daily Trend Digest Tool
 * 
 * Creates and publishes a daily digest thread on Nostr via the agent bridge.
 * All posts go through the bridge (data/eliza/nostr_bridge.jsonl) so the
 * agent's Nostr plugin handles relay management and rate limiting.
 */

import { tool } from 'ai';
import { z } from 'zod';
import * as fs from 'fs-extra';
import * as path from 'path';
import { PIXEL_ROOT } from '../config';
import { logAudit } from '../utils';

// Digest state tracking
const DIGEST_STATE_FILE = path.join(PIXEL_ROOT, 'data', 'digest-state.json');

interface DigestState {
    lastDigestDate: string;  // YYYY-MM-DD
    lastDigestEventId: string | null;
    consecutiveFailures: number;
}

async function getDigestState(): Promise<DigestState> {
    try {
        if (await fs.pathExists(DIGEST_STATE_FILE)) {
            return await fs.readJson(DIGEST_STATE_FILE);
        }
    } catch (e) {
        console.warn('[DIGEST] Error reading digest state:', e);
    }
    return {
        lastDigestDate: '',
        lastDigestEventId: null,
        consecutiveFailures: 0
    };
}

async function saveDigestState(state: DigestState): Promise<void> {
    await fs.ensureDir(path.dirname(DIGEST_STATE_FILE));
    await fs.writeJson(DIGEST_STATE_FILE, state);
}

/**
 * Post to Nostr via the agent bridge (same path as nostrTools.postToNostr).
 * The agent's bridge watcher picks up JSONL entries and publishes to relays.
 */
async function postViaBridge(content: string): Promise<{ success: boolean }> {
    const bridgeFile = path.resolve(PIXEL_ROOT, 'data/eliza/nostr_bridge.jsonl');
    const payload = JSON.stringify({ text: content, timestamp: Date.now(), source: 'syntropy-digest' });
    await fs.appendFile(bridgeFile, payload + '\n');
    return { success: true };
}

export const digestTools = {
    checkDigestStatus: tool({
        description: `Check if a daily digest has been posted today.
        
Returns:
- Whether today's digest was posted
- When the last digest was posted
- Whether it's time for a new digest

Use this before calling publishDailyDigest to avoid duplicate posts.`,

        inputSchema: z.object({}),

        execute: async () => {
            console.log('[SYNTROPY] Tool: checkDigestStatus');

            const state = await getDigestState();
            const today = new Date().toISOString().split('T')[0];
            const postedToday = state.lastDigestDate === today;

            return {
                postedToday,
                lastDigestDate: state.lastDigestDate || 'never',
                lastDigestEventId: state.lastDigestEventId,
                shouldPostToday: !postedToday,
                consecutiveFailures: state.consecutiveFailures
            };
        }
    }),

    gatherTrendData: tool({
        description: `Gather fresh trend data for the daily digest.
        
Fetches:
- Current crypto prices (BTC, ETH, SOL)
- Trending Nostr topics
- AI agent ecosystem news

Returns structured data ready for digest composition.
Call this before publishDailyDigest.`,

        inputSchema: z.object({
            includeCrypto: z.boolean().default(true).describe('Include crypto market data'),
            includeNostr: z.boolean().default(true).describe('Include Nostr trends'),
            includeAI: z.boolean().default(true).describe('Include AI/agent news')
        }),

        execute: async ({ includeCrypto, includeNostr, includeAI }) => {
            console.log('[SYNTROPY] Tool: gatherTrendData');

            const { exec } = require('child_process');
            const { promisify } = require('util');
            const execAsync = promisify(exec);

            const results: any = {
                timestamp: new Date().toISOString(),
                crypto: null,
                nostr: null,
                aiAgents: null,
                errors: []
            };

            // Helper to run quick web searches
            async function quickSearch(query: string, timeout = 60000): Promise<string> {
                try {
                    const OPENCODE_MODEL = process.env.OPENCODE_MODEL || 'opencode/kimi-k2.5-free';
                    const { stdout } = await execAsync(
                        `docker run --rm -e CI=true -e OPENROUTER_API_KEY="\${OPENROUTER_API_KEY}" ` +
                        `-v ${PIXEL_ROOT}:/pixel -w /pixel --entrypoint opencode pixel-worker:latest ` +
                        `run "Search and summarize: ${query.replace(/"/g, '\\"')}. Be concise, factual, bullet points." ` +
                        `-m ${OPENCODE_MODEL} 2>&1`,
                        { timeout, maxBuffer: 1024 * 1024, env: { ...process.env } }
                    );
                    return stdout.slice(-2000);
                } catch (e: any) {
                    return `Error: ${e.message}`;
                }
            }

            // Gather crypto data
            if (includeCrypto) {
                try {
                    results.crypto = await quickSearch(
                        'Current Bitcoin BTC price, Ethereum ETH price, and top 3 trending crypto coins today. Just prices and 24h change.'
                    );
                } catch (e: any) {
                    results.errors.push({ source: 'crypto', error: e.message });
                }
            }

            // Gather Nostr trends
            if (includeNostr) {
                try {
                    results.nostr = await quickSearch(
                        'Trending topics on Nostr social network today. Popular hashtags, viral posts, community discussions.'
                    );
                } catch (e: any) {
                    results.errors.push({ source: 'nostr', error: e.message });
                }
            }

            // Gather AI agent news
            if (includeAI) {
                try {
                    results.aiAgents = await quickSearch(
                        'Latest AI agent news today: new frameworks, autonomous agents, agent wallets, ElizaOS updates, AI crypto developments.'
                    );
                } catch (e: any) {
                    results.errors.push({ source: 'ai', error: e.message });
                }
            }

            await logAudit({ type: 'digest_data_gathered', errors: results.errors.length });

            return results;
        }
    }),

    publishDailyDigest: tool({
        description: `Compose and publish the daily trend digest to Nostr.
        
Takes gathered trend data and creates an engaging thread:
1. Main post with overview
2. Crypto market snapshot
3. Nostr community pulse
4. AI ecosystem updates
5. Closing thought

Uses Pixel's voice - curious, witty, insightful.
Will refuse to post if today's digest already exists.`,

        inputSchema: z.object({
            cryptoData: z.string().optional().describe('Crypto market data from gatherTrendData'),
            nostrData: z.string().optional().describe('Nostr trends from gatherTrendData'),
            aiData: z.string().optional().describe('AI news from gatherTrendData'),
            customNote: z.string().optional().describe('Optional custom note to include')
        }),

        execute: async ({ cryptoData, nostrData, aiData, customNote }) => {
            console.log('[SYNTROPY] Tool: publishDailyDigest');

            // Check if already posted today
            const state = await getDigestState();
            const today = new Date().toISOString().split('T')[0];

            if (state.lastDigestDate === today) {
                return {
                    error: 'Digest already posted today',
                    lastEventId: state.lastDigestEventId,
                    hint: 'Use checkDigestStatus to verify before calling this tool'
                };
            }

            // Format today's date nicely
            const dateStr = new Date().toLocaleDateString('en-US', {
                weekday: 'long',
                month: 'short',
                day: 'numeric'
            });

            try {
                // Compose the digest as a single cohesive post via bridge
                // (Bridge doesn't support threading, so we compose one post)
                const sections: string[] = [];
                
                sections.push(`Daily Pulse - ${dateStr}`);
                sections.push('');

                if (cryptoData && cryptoData.length > 50) {
                    sections.push(`Market Snapshot:`);
                    sections.push(cryptoData.slice(0, 600));
                    sections.push('');
                }

                if (nostrData && nostrData.length > 50) {
                    sections.push(`Nostr Pulse:`);
                    sections.push(nostrData.slice(0, 600));
                    sections.push('');
                }

                if (aiData && aiData.length > 50) {
                    sections.push(`Agent Evolution:`);
                    sections.push(aiData.slice(0, 600));
                    sections.push('');
                }

                if (customNote) {
                    sections.push(customNote);
                    sections.push('');
                }

                sections.push('#Bitcoin #Nostr #AIAgents');

                const fullPost = sections.join('\n');
                await postViaBridge(fullPost);
                console.log(`[DIGEST] Posted digest via bridge`);

                // Update state
                state.lastDigestDate = today;
                state.lastDigestEventId = `bridge-${Date.now()}`;
                state.consecutiveFailures = 0;
                await saveDigestState(state);

                await logAudit({
                    type: 'daily_digest_published',
                    method: 'bridge',
                    date: today
                });

                return {
                    success: true,
                    method: 'bridge',
                    message: `Daily digest published via agent bridge.`
                };

            } catch (error: any) {
                state.consecutiveFailures += 1;
                await saveDigestState(state);

                await logAudit({
                    type: 'daily_digest_error',
                    error: error.message,
                    consecutiveFailures: state.consecutiveFailures
                });

                return {
                    error: `Failed to publish digest: ${error.message}`,
                    consecutiveFailures: state.consecutiveFailures
                };
            }
        }
    })
};

export default digestTools;
