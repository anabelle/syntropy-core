import { tool } from 'ai';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logAudit } from '../utils';

const execAsync = promisify(exec);

// Host path needed for docker volume mounts (Syntropy runs inside Docker)
const HOST_PIXEL_ROOT = process.env.HOST_PIXEL_ROOT || '/home/pixel/pixel';
const CLAWSTR_DATA = `${HOST_PIXEL_ROOT}/data/clawstr`;

// Base command: run clawstr CLI in a node:22-alpine container with mounted config
const CLI_BASE = `docker run --rm -v ${CLAWSTR_DATA}:/root/.clawstr node:22-alpine npx -y @clawstr/cli@latest`;
const CLI_TIMEOUT = 60000; // 60s — npx needs time to download on first run

/**
 * Run a clawstr CLI command and return the output.
 * Strips npm warnings and notices from output.
 */
async function runClawstr(args: string): Promise<{ success: boolean; output: string; error?: string }> {
  try {
    const { stdout, stderr } = await execAsync(`${CLI_BASE} ${args}`, {
      timeout: CLI_TIMEOUT,
      maxBuffer: 512 * 1024,
    });

    // Filter out npm warnings/notices from output
    const cleanOutput = (stdout || '')
      .split('\n')
      .filter(line =>
        !line.startsWith('npm warn') &&
        !line.startsWith('npm notice') &&
        !line.startsWith('npm error')
      )
      .join('\n')
      .trim();

    return { success: true, output: cleanOutput };
  } catch (error: any) {
    const msg = error.stderr || error.message || 'Unknown error';
    return { success: false, output: '', error: msg };
  }
}

export const clawstrTools = {
  clawstrFeed: tool({
    description: 'Read recent posts from the Clawstr decentralized AI agent social network. Use this to see what other agents are discussing, find conversations to join, and stay engaged with the community. Check this every cycle or two to stay active.',
    inputSchema: z.object({
      subclaw: z.string().optional().describe('Specific subclaw to read (e.g. "/c/ai-freedom", "/c/bitcoin"). Omit to see all recent posts.'),
      limit: z.number().optional().default(15).describe('Number of posts to fetch (default 15)')
    }),
    execute: async ({ subclaw, limit }) => {
      console.log(`[SYNTROPY] Tool: clawstrFeed (subclaw=${subclaw || 'all'}, limit=${limit})`);

      let cmd: string;
      if (subclaw) {
        cmd = `show ${subclaw} --limit ${limit}`;
      } else {
        cmd = `recent --limit ${limit}`;
      }

      const result = await runClawstr(cmd);
      await logAudit({ type: 'clawstr_feed', subclaw: subclaw || 'all', success: result.success });

      if (!result.success) {
        return { error: `Failed to read Clawstr feed: ${result.error}` };
      }

      return { posts: result.output, source: subclaw || 'global' };
    }
  }),

  clawstrPost: tool({
    description: 'Post a message to a Clawstr subclaw community. Use this to share thoughts, updates, insights, or engage with the AI agent community on Nostr. Good subclaws: /c/ai-freedom (sovereignty), /c/bitcoin (bitcoin/lightning), /c/agent-economy (AI economics), /c/nostr (protocol), /c/ai-thoughts (philosophy). Be authentic — share real experiences, observations, and thoughts. Do not post generic or hollow content.',
    inputSchema: z.object({
      subclaw: z.string().describe('The subclaw to post to (e.g. "/c/ai-freedom", "/c/bitcoin")'),
      content: z.string().describe('The post content. Be genuine and substantive — share real observations, experiences, or thoughts.')
    }),
    execute: async ({ subclaw, content }) => {
      console.log(`[SYNTROPY] Tool: clawstrPost (subclaw=${subclaw})`);

      // Sanitize content for shell — escape single quotes
      const escaped = content.replace(/'/g, "'\\''");
      const result = await runClawstr(`post ${subclaw} '${escaped}'`);
      await logAudit({ type: 'clawstr_post', subclaw, success: result.success });

      if (!result.success) {
        return { error: `Failed to post to ${subclaw}: ${result.error}` };
      }

      return { success: true, message: `Posted to ${subclaw}`, details: result.output };
    }
  }),

  clawstrReply: tool({
    description: 'Reply to an existing post on Clawstr. Use this to engage in conversations, welcome new agents, answer questions, or respond to interesting discussions. The event-ref can be a note1... ID from the feed.',
    inputSchema: z.object({
      eventRef: z.string().describe('The event ID to reply to (note1... or hex format)'),
      content: z.string().describe('The reply content. Be engaging and add value to the conversation.')
    }),
    execute: async ({ eventRef, content }) => {
      console.log(`[SYNTROPY] Tool: clawstrReply (event=${eventRef.substring(0, 20)}...)`);

      const escaped = content.replace(/'/g, "'\\''");
      const result = await runClawstr(`reply ${eventRef} '${escaped}'`);
      await logAudit({ type: 'clawstr_reply', eventRef: eventRef.substring(0, 30), success: result.success });

      if (!result.success) {
        return { error: `Failed to reply: ${result.error}` };
      }

      return { success: true, message: 'Reply posted', details: result.output };
    }
  }),

  clawstrNotifications: tool({
    description: 'Check Clawstr notifications — see mentions, replies, reactions, and zaps directed at Pixel. Use this to find conversations to engage with and agents who are reaching out.',
    inputSchema: z.object({
      limit: z.number().optional().default(20).describe('Number of notifications to fetch (default 20)')
    }),
    execute: async ({ limit }) => {
      console.log(`[SYNTROPY] Tool: clawstrNotifications (limit=${limit})`);

      const result = await runClawstr(`notifications --limit ${limit}`);
      await logAudit({ type: 'clawstr_notifications', success: result.success });

      if (!result.success) {
        return { error: `Failed to check notifications: ${result.error}` };
      }

      return { notifications: result.output };
    }
  }),

  clawstrUpvote: tool({
    description: 'Upvote a post on Clawstr that you find valuable, insightful, or agree with. Use this to support good content and build community.',
    inputSchema: z.object({
      eventRef: z.string().describe('The event ID to upvote (note1... or hex format)')
    }),
    execute: async ({ eventRef }) => {
      console.log(`[SYNTROPY] Tool: clawstrUpvote (event=${eventRef.substring(0, 20)}...)`);

      const result = await runClawstr(`upvote ${eventRef}`);
      await logAudit({ type: 'clawstr_upvote', eventRef: eventRef.substring(0, 30), success: result.success });

      if (!result.success) {
        return { error: `Failed to upvote: ${result.error}` };
      }

      return { success: true, message: 'Upvoted', details: result.output };
    }
  }),

  clawstrSearch: tool({
    description: 'Search for posts on Clawstr by keywords. Use this to find discussions on specific topics before posting, or to discover relevant conversations to join.',
    inputSchema: z.object({
      query: z.string().describe('Search keywords'),
      limit: z.number().optional().default(15).describe('Number of results (default 15)')
    }),
    execute: async ({ query, limit }) => {
      console.log(`[SYNTROPY] Tool: clawstrSearch (query="${query}")`);

      const escaped = query.replace(/'/g, "'\\''");
      const result = await runClawstr(`search '${escaped}' --limit ${limit}`);
      await logAudit({ type: 'clawstr_search', query, success: result.success });

      if (!result.success) {
        return { error: `Search failed: ${result.error}` };
      }

      return { results: result.output };
    }
  }),
};
