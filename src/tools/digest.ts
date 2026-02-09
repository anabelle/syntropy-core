/**
 * Daily Trend Digest Tool
 * 
 * Creates and publishes a daily digest thread on Nostr with:
 * - Crypto market snapshot (BTC, ETH, trending coins)
 * - Trending Nostr topics and discussions
 * - AI agent ecosystem news
 * 
 * Posts as Pixel's voice on Nostr.
 */

import { tool } from 'ai';
import { z } from 'zod';
import * as fs from 'fs-extra';
import * as path from 'path';
import { PIXEL_ROOT } from '../config';
import { logAudit } from '../utils';
import { generateSecretKey, getPublicKey, finalizeEvent, SimplePool } from 'nostr-tools';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

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

// Default relays for posting
const DEFAULT_RELAYS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.nostr.band',
    'wss://relay.primal.net',
    'wss://nostr.wine'
];

async function postToNostr(content: string, replyTo?: string): Promise<{ eventId: string; relays: number }> {
    // Get Nostr private key from environment
    const privKeyHex = process.env.NOSTR_PRIVATE_KEY || process.env.NOSTR_SK;
    if (!privKeyHex) {
        throw new Error('NOSTR_PRIVATE_KEY not set in environment');
    }

    // Normalize private key
    const cleanKey = privKeyHex.trim().replace(/^nsec1/, '').replace(/^0x/, '');
    const privKeyBytes = hexToBytes(cleanKey);
    const pubkey = getPublicKey(privKeyBytes);

    // Build event
    const event: any = {
        kind: 1,
        pubkey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content
    };

    // Add reply tags if this is a thread reply
    if (replyTo) {
        event.tags.push(['e', replyTo, '', 'root']);
    }

    // Add hashtags
    const hashtags = content.match(/#\w+/g) || [];
    for (const tag of hashtags) {
        event.tags.push(['t', tag.slice(1).toLowerCase()]);
    }

    // Finalize (sign) the event
    const signedEvent = finalizeEvent(event, privKeyBytes);
    const eventId = signedEvent.id;

    // Publish to relays
    const pool = new SimplePool();
    let successCount = 0;

    try {
        const promises = DEFAULT_RELAYS.map(async (relay) => {
            try {
                await pool.publish([relay], signedEvent);
                successCount++;
                return true;
            } catch (e) {
                console.warn(`[DIGEST] Failed to publish to ${relay}:`, e);
                return false;
            }
        });

        await Promise.allSettled(promises);
    } finally {
        pool.close(DEFAULT_RELAYS);
    }

    return { eventId, relays: successCount };
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
                    const OPENCODE_MODEL = process.env.OPENCODE_MODEL || 'opencode/glm-4.7-free';
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
                // Compose the main digest post
                const mainPost = `🌅 Daily Pulse • ${dateStr}

The markets stir, the feeds flow, the agents evolve.

Here's what's moving in the digital frontier today:

🧵 Thread ↓`;

                // Post main thread starter
                const { eventId: rootId, relays: rootRelays } = await postToNostr(mainPost);
                console.log(`[DIGEST] Posted root: ${rootId} to ${rootRelays} relays`);

                const postedEvents = [{ type: 'root', eventId: rootId }];

                // Post crypto section if we have data
                if (cryptoData && cryptoData.length > 50) {
                    const cryptoPost = `📊 Market Snapshot

${cryptoData.slice(0, 800)}

#Bitcoin #Crypto`;

                    const { eventId } = await postToNostr(cryptoPost, rootId);
                    postedEvents.push({ type: 'crypto', eventId });
                    await new Promise(r => setTimeout(r, 2000)); // Rate limit
                }

                // Post Nostr section if we have data
                if (nostrData && nostrData.length > 50) {
                    const nostrPost = `💜 Nostr Pulse

${nostrData.slice(0, 800)}

#Nostr #Decentralized`;

                    const { eventId } = await postToNostr(nostrPost, rootId);
                    postedEvents.push({ type: 'nostr', eventId });
                    await new Promise(r => setTimeout(r, 2000));
                }

                // Post AI section if we have data
                if (aiData && aiData.length > 50) {
                    const aiPost = `🤖 Agent Evolution

${aiData.slice(0, 800)}

#AIAgents #Autonomous`;

                    const { eventId } = await postToNostr(aiPost, rootId);
                    postedEvents.push({ type: 'ai', eventId });
                    await new Promise(r => setTimeout(r, 2000));
                }

                // Closing thought
                const closerPost = `✨ That's the pulse for today.

The future is being built in the open—one block, one note, one agent at a time.

What caught your attention? 👇

${customNote ? `\n${customNote}` : ''}`;

                const { eventId: closerId } = await postToNostr(closerPost, rootId);
                postedEvents.push({ type: 'closer', eventId: closerId });

                // Update state
                state.lastDigestDate = today;
                state.lastDigestEventId = rootId;
                state.consecutiveFailures = 0;
                await saveDigestState(state);

                await logAudit({
                    type: 'daily_digest_published',
                    rootEventId: rootId,
                    threadLength: postedEvents.length,
                    date: today
                });

                return {
                    success: true,
                    rootEventId: rootId,
                    threadLength: postedEvents.length,
                    events: postedEvents,
                    message: `Daily digest thread published! ${postedEvents.length} posts in thread.`
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
