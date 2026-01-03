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
      } catch (error: any) {
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

      // First, try to read from file-based feed export (fast and reliable)
      const feedExportPath = path.resolve(PIXEL_ROOT, 'data/eliza/nostr_feed_export.json');
      try {
        if (await fs.pathExists(feedExportPath)) {
          const data = await fs.readJson(feedExportPath);
          const exportedAt = new Date(data.exported_at);
          const ageMs = Date.now() - exportedAt.getTime();

          // If file is less than 10 minutes old, use it
          if (ageMs < 10 * 60 * 1000 && Array.isArray(data.posts) && data.posts.length > 0) {
            const posts = data.posts.slice(0, limit);
            await logAudit({ type: 'pixel_nostr_feed_read', count: posts.length, source: 'file_export' });
            return {
              posts,
              source: 'file_export',
              exported_at: data.exported_at
            };
          }
        }
      } catch (fileErr: any) {
        console.log(`[SYNTROPY] Feed export file not available: ${fileErr.message}`);
      }

      // Fallback: query relays directly (less reliable but gets live data)
      try {
        const script = `
const { SimplePool, nip19, getPublicKey } = require('nostr-tools');
const WebSocket = require('ws');
global.WebSocket = WebSocket;

const forceExit = setTimeout(() => { console.log('[]'); process.exit(0); }, 15000);

async function run() {
  const sk = process.env.NOSTR_PRIVATE_KEY;
  const relays = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
  
  if (!sk) { clearTimeout(forceExit); console.log('[]'); process.exit(0); }
  
  let pk = '';
  try {
    if (sk.startsWith('nsec')) { pk = getPublicKey(nip19.decode(sk).data); }
    else { pk = getPublicKey(Buffer.from(sk, 'hex')); }
  } catch (e) { clearTimeout(forceExit); console.error('ERROR: Invalid key'); process.exit(1); }

  const pool = new SimplePool();
  try {
    const posts = await Promise.race([
      pool.list(relays, [{ authors: [pk], kinds: [1], limit: ${limit} }]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 12000))
    ]);
    clearTimeout(forceExit);
    console.log(JSON.stringify(posts.sort((a, b) => b.created_at - a.created_at)));
  } catch (e) {
    clearTimeout(forceExit);
    console.log('[]');
  } finally {
    try { pool.close(relays); } catch (e) {}
    process.exit(0);
  }
}
run();
`;
        const { stdout, stderr } = await execAsync(
          `docker exec pixel-agent-1 bun -e "${script.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
          { timeout: 20000 }
        );

        if (stderr && stderr.includes('ERROR:')) {
          return { error: stderr };
        }

        const output = (stdout || '').trim();
        if (!output || output === '') {
          await logAudit({ type: 'pixel_nostr_feed_read', count: 0, source: 'relay', note: 'empty_response' });
          return { posts: [], note: 'No data received from relays (timeout or connectivity issue)' };
        }

        try {
          const posts = JSON.parse(output);
          await logAudit({ type: 'pixel_nostr_feed_read', count: posts.length, source: 'relay' });
          return { posts, source: 'relay' };
        } catch (parseError: any) {
          await logAudit({ type: 'pixel_nostr_feed_read', count: 0, source: 'relay', note: 'parse_error' });
          return { posts: [], note: 'Could not parse relay response' };
        }
      } catch (error: any) {
        if (error.killed || error.signal === 'SIGTERM') {
          return { posts: [], note: 'Request timed out - relays may be slow or unreachable' };
        }
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

      // First, try to read from file-based mentions export (fast and reliable)
      const mentionsExportPath = path.resolve(PIXEL_ROOT, 'data/eliza/nostr_mentions_export.json');
      try {
        if (await fs.pathExists(mentionsExportPath)) {
          const data = await fs.readJson(mentionsExportPath);
          const exportedAt = new Date(data.exported_at);
          const ageMs = Date.now() - exportedAt.getTime();

          // If file is less than 10 minutes old, use it
          if (ageMs < 10 * 60 * 1000 && Array.isArray(data.mentions) && data.mentions.length > 0) {
            const mentions = data.mentions.slice(0, limit);
            await logAudit({ type: 'pixel_nostr_mentions_read', count: mentions.length, source: 'file_export' });
            return {
              mentions,
              source: 'file_export',
              exported_at: data.exported_at
            };
          }
        }
      } catch (fileErr: any) {
        console.log(`[SYNTROPY] Mentions export file not available: ${fileErr.message}`);
      }

      // Fallback: query relays directly (less reliable but gets live data)
      try {
        const script = `
const { SimplePool, nip19, getPublicKey } = require('nostr-tools');
const WebSocket = require('ws');
global.WebSocket = WebSocket;

const forceExit = setTimeout(() => { console.log('[]'); process.exit(0); }, 15000);

async function run() {
  const sk = process.env.NOSTR_PRIVATE_KEY;
  const relays = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
  
  if (!sk) { clearTimeout(forceExit); console.log('[]'); process.exit(0); }
  
  let pk = '';
  try {
    if (sk.startsWith('nsec')) { pk = getPublicKey(nip19.decode(sk).data); }
    else { pk = getPublicKey(Buffer.from(sk, 'hex')); }
  } catch (e) { clearTimeout(forceExit); console.error('ERROR: Invalid key'); process.exit(1); }

  const pool = new SimplePool();
  try {
    const mentions = await Promise.race([
      pool.list(relays, [{ '#p': [pk], kinds: [1], limit: ${limit} }]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 12000))
    ]);
    clearTimeout(forceExit);
    const filtered = mentions.filter(m => m.pubkey !== pk);
    console.log(JSON.stringify(filtered.sort((a, b) => b.created_at - a.created_at)));
  } catch (e) {
    clearTimeout(forceExit);
    console.log('[]');
  } finally {
    try { pool.close(relays); } catch (e) {}
    process.exit(0);
  }
}
run();
`;
        const { stdout, stderr } = await execAsync(
          `docker exec pixel-agent-1 bun -e "${script.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
          { timeout: 20000 }
        );

        if (stderr && stderr.includes('ERROR:')) {
          return { error: stderr };
        }

        const output = (stdout || '').trim();
        if (!output || output === '') {
          await logAudit({ type: 'pixel_nostr_mentions_read', count: 0, source: 'relay', note: 'empty_response' });
          return { mentions: [], note: 'No data received from relays (timeout or connectivity issue)' };
        }

        try {
          const mentions = JSON.parse(output);
          await logAudit({ type: 'pixel_nostr_mentions_read', count: mentions.length, source: 'relay' });
          return { mentions, source: 'relay' };
        } catch (parseError: any) {
          await logAudit({ type: 'pixel_nostr_mentions_read', count: 0, source: 'relay', note: 'parse_error' });
          return { mentions: [], note: 'Could not parse relay response' };
        }
      } catch (error: any) {
        if (error.killed || error.signal === 'SIGTERM') {
          return { mentions: [], note: 'Request timed out - relays may be slow or unreachable' };
        }
        return { error: `Failed to read Pixel mentions: ${error.message}` };
      }
    }
  })
};
