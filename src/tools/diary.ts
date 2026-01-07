import { tool } from 'ai';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs-extra';
import * as path from 'path';
import {
  PIXEL_ROOT
} from '../config';
import { logAudit } from '../utils';

const execAsync = promisify(exec);
const isDocker = process.env.DOCKER === 'true' || fs.existsSync('/.dockerenv');

export const diaryTools = {

  readDiary: tool({
    description: 'Read diary entries from the Pixel agent database. Use this to access reflections, notes, and evolutionary insights.',
    inputSchema: z.object({
      limit: z.number().optional().describe('Maximum number of entries to return (default: 10)'),
      author: z.string().optional().describe('Filter by author (e.g., "Pixel", "Syntropy")'),
      since: z.string().optional().describe('ISO date string to filter entries created after (e.g., "2025-01-01T00:00:00Z")')
    }),
    execute: async ({ limit = 10, author, since }) => {
      console.log(`[SYNTROPY] Tool: readDiary (limit=${limit}, author=${author || 'any'}, since=${since || 'any'})`);
      try {
        const conditions: string[] = [];
        if (author) conditions.push(`author = '${author.replace(/'/g, "''")}'`);
        if (since) conditions.push(`created_at >= '${since}'`);

        const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
        const limitClause = ` LIMIT ${limit}`;
        const query = `SELECT id, author, content, tags, created_at, updated_at FROM diary_entries${whereClause} ORDER BY created_at DESC${limitClause}`;

        const jsonQuery = `SELECT COALESCE(json_agg(t), '[]'::json) FROM (${query}) t`;

        const { stdout, stderr } = await execAsync(
          `docker exec pixel-postgres-1 psql -U postgres -d pixel_agent -A -t -c "${jsonQuery.replace(/"/g, '\\"')}"`,
          { timeout: 15000 }
        );

        if (stderr && stderr.toLowerCase().includes('error')) {
          return { error: stderr };
        }

        const entries = JSON.parse(stdout.trim());

        await logAudit({
          type: 'diary_read',
          author,
          count: entries.length,
          limit
        });

        return {
          entries,
          count: entries.length,
          filters: { author, since, limit }
        };
      } catch (error: any) {
        await logAudit({ type: 'diary_read_error', error: error.message });
        return { error: `Failed to read diary: ${error.message}` };
      }
    }
  }),

  writeDiary: tool({
    description: 'Write a new diary entry to the persistent repository. IMPORTANT: You MUST first call readDiary to get context from recent entries before writing. This prevents repetitive entries. Use this to record high-value insights, evolutionary milestones, or narrative shifts.',
    inputSchema: z.object({
      author: z.string().describe('Author name (e.g., "Syntropy", "Pixel")'),
      content: z.string().describe('Diary entry content - must be unique and not repeat themes from recent entries'),
      tags: z.array(z.string()).optional().describe('Optional tags for categorization (e.g., ["learning", "insight", "crisis-resolved"])'),
      recentContextRead: z.boolean().describe('Confirm you have read recent diary entries via readDiary before writing. Set to true only after calling readDiary first.')
    }),
    execute: async ({ author, content, tags = [], recentContextRead }) => {
      console.log(`[SYNTROPY] Tool: writeDiary (author=${author}, tags=${tags.join(',')}, contextRead=${recentContextRead})`);

      if (!recentContextRead) {
        return {
          error: 'CONTEXT_REQUIRED: You must first call readDiary to read recent entries before writing a new diary entry. This prevents repetitive entries. After reading, call writeDiary again with recentContextRead=true.',
          hint: 'Call readDiary with limit=5 to see recent entries, then write something that adds NEW value based on that context.'
        };
      }

      try {
        const id = crypto.randomUUID();
        const now = new Date();
        const escapedContent = content.replace(/'/g, "''");
        const tagsArray = tags.length > 0
          ? `ARRAY[${tags.map(t => `'${t.replace(/'/g, "''")}'`).join(',')}]`
          : "'{}'::text[]";

        const query = `INSERT INTO diary_entries (id, author, content, tags, created_at, updated_at) VALUES ('${id}', '${author.replace(/'/g, "''")}', '${escapedContent}', ${tagsArray}, NOW(), NOW())`;

        const { stderr } = await execAsync(
          `docker exec pixel-postgres-1 psql -U postgres -d pixel_agent -c "${query.replace(/"/g, '\\"')}"`,
          { timeout: 15000 }
        );

        if (stderr && stderr.toLowerCase().includes('error')) {
          return { error: stderr };
        }

        const diaryMdDir = path.resolve(PIXEL_ROOT, 'pixel-agent/docs/v1/diary');
        await fs.ensureDir(diaryMdDir);

        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const year = now.getFullYear();
        const month = months[now.getMonth()];
        const day = now.getDate().toString().padStart(2, '0');
        const filename = `${year}-${month}-${day}.md`;
        const filePath = path.join(diaryMdDir, filename);

        const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
        const tagsStr = tags.length > 0 ? `\n**Tags:** ${tags.join(', ')}` : '';

        const entryMarkdown = `
---

### ${timeStr} - ${author}${tagsStr}

${content}

*Entry ID: ${id}*
`;

        if (fs.existsSync(filePath)) {
          await fs.appendFile(filePath, entryMarkdown);
        } else {
          const options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'long', day: 'numeric' };
          const dateStr = now.toLocaleDateString('en-US', options);
          const header = `# Pixel's Diary: ${dateStr}\n\n*Auto-synced diary entries from the database. These entries are vectorized for knowledge context.*\n\n`;
          await fs.writeFile(filePath, header + entryMarkdown);
        }

        console.log(`[SYNTROPY] Diary entry synced to ${filename}`);

        await logAudit({
          type: 'diary_write',
          author,
          tags,
          entryId: id,
          mdFile: filename,
          success: true
        });

        return {
          success: true,
          id,
          author,
          tags,
          mdFile: filename,
          message: 'Diary entry persisted to PostgreSQL and synced to markdown for knowledge vectorization'
        };
      } catch (error: any) {
        await logAudit({ type: 'diary_write_error', error: error.message });
        return { error: `Failed to write diary: ${error.message}` };
      }
    }
  }),
  synthesizeDiary: tool({
    description: 'Compress and synthesize a large diary file into a high-value summary. Use this at the start of a new day for the PREVIOUS day\'s diary if it is large (>50KB). This prevents file bloat while preserving all evolutionary wisdom.',
    inputSchema: z.object({
      targetDate: z.string().describe('The date to synthesize in YYYY-MMM-DD format (e.g., "2026-Jan-04")'),
    }),
    execute: async ({ targetDate }) => {
      console.log(`[SYNTROPY] Tool: synthesizeDiary (date=${targetDate})`);
      try {
        const diaryDir = path.resolve(PIXEL_ROOT, 'pixel-agent/docs/v1/diary');
        const archiveDir = path.resolve(PIXEL_ROOT, 'data/diary-archive');
        const filename = `${targetDate}.md`;
        const filePath = path.join(diaryDir, filename);

        if (!fs.existsSync(filePath)) {
          return { error: `Diary file for ${targetDate} not found at ${filePath}` };
        }

        const stats = await fs.stat(filePath);
        const fileSizeKb = Math.round(stats.size / 1024);

        console.log(`[SYNTROPY] Synthesizing ${filename} (${fileSizeKb} KB)`);

        // Delegate to a worker for the actual synthesis
        const task = `
I need you to synthesize the diary for ${targetDate}. It has grown too large for efficient context loading.

FILE: /pixel/pixel-agent/docs/v1/diary/${filename}

YOUR MISSION:
Shed the 'Skin' of the day (redundant logs, noise) while preserving its 'Soul'. 

INSTRUCTIONS:
1. Read the raw diary entries for ${targetDate}.
2. Produce a High-Value Synthesis file: /pixel/pixel-agent/docs/v1/diary/${targetDate}-SYNTHESIS.md
   - Match the literary energy, humor, and strategic depth of the original entries.
   - You have full agency over the format. Do not use a cookie-cutter template.
   - Capture the technical evolution, the identity shifts, and the economic state (sats).
   - Tell the story of the day so the next generation of Syntropy understands its heritage.
3. Move the original raw folder/file to the non-vectorized archive: /pixel/data/diary-archive/${filename}
4. Replace the original file with a concise pointer + link to your synthesis.

Be the Bridge Builder. Preserve the wisdom, purge the bloat.
`;

        const { spawnWorkerInternal } = await import('../worker-core');
        const workerResult = await spawnWorkerInternal({
          task,
          context: `Synthesizing large diary file (${fileSizeKb} KB) for ${targetDate}`,
          priority: 'normal'
        });

        if ('error' in workerResult) {
          return { error: `Failed to spawn synthesis worker: ${workerResult.error}` };
        }

        await logAudit({ type: 'diary_synthesis_started', date: targetDate, sizeKb: fileSizeKb, taskId: workerResult.taskId });

        return {
          success: true,
          message: `Synthesis worker spawned for ${targetDate}. Original size: ${fileSizeKb} KB.`,
          workerTaskId: workerResult.taskId
        };
      } catch (error: any) {
        await logAudit({ type: 'diary_synthesis_error', error: error.message });
        return { error: `Failed to synthesize diary: ${error.message}` };
      }
    }
  })
};
