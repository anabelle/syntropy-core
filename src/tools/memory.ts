import { tool } from 'ai';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logAudit } from '../utils';

const execAsync = promisify(exec);

export const readPixelMemories = tool({
  description: `Read Pixel's memories from the PostgreSQL database.
The agent stores all narrative data in PostgreSQL with different content types:
- hourly_digest: Hourly activity summaries with topics and events
- daily_report: Daily narrative reports with themes and learnings
- emerging_story: Real-time trending topics being tracked
- narrative_timeline: Timeline lore entries with headlines and insights
- social_interaction: Individual conversation memories
Use 'narratives' to see digests/reports/timeline, 'topics' for emerging stories, 'all' for everything.`,
  inputSchema: z.object({
    category: z.enum(['narratives', 'topics', 'all']).describe('Category: narratives (hourly/daily/weekly/timeline), topics (emerging_story), or all'),
    limit: z.number().optional().describe('Maximum number of results (default: 10)'),
    contentType: z.string().optional().describe('Filter by specific content.type (e.g. hourly_digest, daily_report, narrative_timeline)')
  }),
  execute: async ({ category, limit = 10, contentType }) => {
    console.log(`[SYNTROPY] Tool: readPixelMemories (category=${category}, limit=${limit}, contentType=${contentType || 'any'})`);
    try {
      let whereClause: string;
      if (contentType) {
        whereClause = `content->>'type' = '${contentType}'`;
      } else if (category === 'narratives') {
        whereClause = `content->>'type' IN ('hourly_digest', 'daily_report', 'weekly_summary', 'narrative_timeline')`;
      } else if (category === 'topics') {
        whereClause = `content->>'type' = 'emerging_story'`;
      } else {
        whereClause = `content->>'type' IS NOT NULL`;
      }

      const query = `SELECT id, created_at, content FROM memories WHERE ${whereClause} ORDER BY created_at DESC LIMIT ${limit}`;

      const { stdout, stderr } = await execAsync(
        `docker exec pixel-postgres-1 psql -U postgres -d pixel_agent -t -c "${query.replace(/"/g, '\\"')}"`,
        { timeout: 15000 }
      );

      if (stderr && stderr.toLowerCase().includes('error')) {
        return { error: stderr };
      }

      const rows = stdout.trim().split('\n').filter(line => line.trim()).map(line => {
        try {
          const parts = line.split('|').map(p => p.trim());
          if (parts.length >= 3) {
            return {
              id: parts[0],
              createdAt: parts[1],
              content: JSON.parse(parts[2])
            };
          }
        } catch { }
        return null;
      }).filter(Boolean);

      const memories = rows.map((row: any) => {
        const content = row.content || {};
        const data = content.data || {};

        return {
          id: row.id,
          createdAt: row.createdAt,
          type: content.type,
          headline: data.headline || data.topic || null,
          summary: data.summary || data.narrative || (data.insights ? data.insights.join('; ') : null),
          topics: data.topics || data.tags || [],
          priority: data.priority || null,
          eventCount: data.eventCount || data.mentions || null
        };
      });

      await logAudit({ type: 'pixel_memories_read', category, count: memories.length });
      return { memories, count: memories.length, category };
    } catch (error: any) {
      await logAudit({ type: 'pixel_memories_error', error: error.message });
      return { error: `Failed to read Pixel memories: ${error.message}` };
    }
  }
});

export const getPixelStats = tool({
  description: "Get statistics about Pixel's memory database - total memories by type and source.",
  inputSchema: z.object({}),
  execute: async () => {
    console.log('[SYNTROPY] Tool: getPixelStats');
    try {
      const { stdout, stderr } = await execAsync(
        `docker exec pixel-postgres-1 psql -U postgres -d pixel_agent -t -c "
          SELECT 
            COALESCE(content->>'type', 'untyped') as type,
            COALESCE(content->>'source', 'unknown') as source,
            COUNT(*) as count
          FROM memories 
          GROUP BY content->>'type', content->>'source'
          ORDER BY count DESC;
        "`,
        { timeout: 15000 }
      );

      if (stderr && stderr.toLowerCase().includes('error')) {
        return { error: stderr };
      }

      const stats = stdout.trim().split('\n').filter(line => line.trim()).map(line => {
        const parts = line.split('|').map(p => p.trim());
        return {
          type: parts[0] || 'untyped',
          source: parts[1] || 'unknown',
          count: parseInt(parts[2]) || 0
        };
      });

      const totalMemories = stats.reduce((sum, s) => sum + s.count, 0);

      const byType: Record<string, number> = {};
      stats.forEach(s => {
        byType[s.type] = (byType[s.type] || 0) + s.count;
      });

      const result = {
        totalMemories,
        byType,
        detailed: stats
      };

      await logAudit({ type: 'pixel_stats', ...result });
      return result;
    } catch (error: any) {
      return { error: `Failed to get Pixel stats: ${error.message}` };
    }
  }
});

export const memoryTools = {
  readPixelMemories,
  getPixelStats
};
