import { tool } from 'ai';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs-extra';
import * as path from 'path';
import { PIXEL_ROOT } from '../config';
import { logAudit } from '../utils';
const execAsync = promisify(exec);
export const nostrTools = {
    postToNostr: tool({
        description: 'Post a message to the Nostr network via the Pixel Agent bridge. Use this for high-level ecosystem announcements, status updates, or to communicate with the Nostr community.',
        inputSchema: z.object({
            text: z.string().describe('The message content to post. Keep it relevant and concise.')
        }),
        execute: async ({ text }) => {
            console.log(`[SYNTROPY] Tool: postToNostr`);
            try {
                const bridgeFile = path.resolve(PIXEL_ROOT, 'data/eliza/nostr_bridge.jsonl');
                const payload = JSON.stringify({ text, timestamp: Date.now(), source: 'syntropy' });
                await fs.appendFile(bridgeFile, payload + '\n');
                await logAudit({ type: 'nostr_bridge_post', text });
                return { success: true, message: "Post request sent to agent bridge." };
            }
            catch (error) {
                await logAudit({ type: 'nostr_bridge_error', error: error.message });
                return { error: `Failed to signal agent bridge: ${error.message}` };
            }
        }
    }),
    readPixelNostrFeed: tool({
        description: 'Read the most recent posts from the Pixel agent on Nostr. Use this to see what Pixel has been saying recently.',
        inputSchema: z.object({
            limit: z.number().optional().default(10).describe('Number of recent posts to fetch (default 10)')
        }),
        execute: async ({ limit }) => {
            console.log(`[SYNTROPY] Tool: readPixelNostrFeed (limit=${limit})`);
            try {
                const script = `
const { SimplePool, nip19, getPublicKey } = require('nostr-tools');
const WebSocket = require('ws');
global.WebSocket = WebSocket;

async function run() {
  const sk = process.env.NOSTR_PRIVATE_KEY;
  const relays = [
    'wss://relay.damus.io',
    'wss://nos.lol', 
    'wss://relay.snort.social',
    'wss://relay.primal.net',
    'wss://purplepag.es',
    'wss://relay.nostr.band'
  ];
  
  if (!sk) {
    console.log('[]');
    process.exit(0);
  }
  
  let pk = '';
  try {
    if (sk.startsWith('nsec')) {
      pk = getPublicKey(nip19.decode(sk).data);
    } else {
      pk = getPublicKey(Buffer.from(sk, 'hex'));
    }
  } catch (e) {
    console.error('ERROR: Invalid key');
    process.exit(1);
  }

  const pool = new SimplePool();
  try {
    const posts = await pool.querySync(relays, { authors: [pk], kinds: [1], limit: ${limit} });
    console.log(JSON.stringify(posts.sort((a, b) => b.created_at - a.created_at)));
  } finally {
    try { pool.close(relays); } catch (e) {}
    process.exit(0);
  }
}
run();
`;
                const { stdout, stderr } = await execAsync(`docker exec pixel-agent-1 bun -e "${script.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { timeout: 30000 });
                if (stderr && stderr.includes('ERROR:')) {
                    return { error: stderr };
                }
                const posts = JSON.parse(stdout.trim());
                await logAudit({ type: 'pixel_nostr_feed_read', count: posts.length });
                return { posts };
            }
            catch (error) {
                return { error: `Failed to read Pixel Nostr feed: ${error.message}` };
            }
        }
    }),
    readPixelNostrMentions: tool({
        description: "Read recent mentions of the Pixel agent on Nostr. Use this to see what people are saying to or about Pixel.",
        inputSchema: z.object({
            limit: z.number().optional().default(10).describe('Number of recent mentions to fetch (default 10)')
        }),
        execute: async ({ limit }) => {
            console.log(`[SYNTROPY] Tool: readPixelNostrMentions (limit=${limit})`);
            try {
                const script = `
const { SimplePool, nip19, getPublicKey } = require('nostr-tools');
const WebSocket = require('ws');
global.WebSocket = WebSocket;

async function run() {
  const sk = process.env.NOSTR_PRIVATE_KEY;
  const relays = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.snort.social',
    'wss://relay.primal.net',
    'wss://purplepag.es',
    'wss://relay.nostr.band'
  ];
  
  if (!sk) {
    console.log('[]');
    process.exit(0);
  }
  
  let pk = '';
  try {
    if (sk.startsWith('nsec')) {
      pk = getPublicKey(nip19.decode(sk).data);
    } else {
      pk = getPublicKey(Buffer.from(sk, 'hex'));
    }
  } catch (e) {
    console.error('ERROR: Invalid key');
    process.exit(1);
  }

  const pool = new SimplePool();
  try {
    const mentions = await pool.querySync(relays, { '#p': [pk], kinds: [1], limit: ${limit} });
    const filtered = mentions.filter(m => m.pubkey !== pk);
    console.log(JSON.stringify(filtered.sort((a, b) => b.created_at - a.created_at)));
  } finally {
    try { pool.close(relays); } catch (e) {}
    process.exit(0);
  }
}
run();
`;
                const { stdout, stderr } = await execAsync(`docker exec pixel-agent-1 bun -e "${script.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { timeout: 30000 });
                if (stderr && stderr.includes('ERROR:')) {
                    return { error: stderr };
                }
                const mentions = JSON.parse(stdout.trim());
                await logAudit({ type: 'pixel_nostr_mentions_read', count: mentions.length });
                return { mentions };
            }
            catch (error) {
                return { error: `Failed to read Pixel mentions: ${error.message}` };
            }
        }
    })
};
