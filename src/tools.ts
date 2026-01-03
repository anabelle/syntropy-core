import { tool } from 'ai';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs-extra';
import * as path from 'path';
import {
  PIXEL_ROOT,
  PIXEL_AGENT_DIR,
  CHARACTER_DIR,
  DB_PATH,
  LOG_PATH,
  AUDIT_LOG_PATH
} from './config';
import { logAudit, syncAll } from './utils';
import { workerTools } from './worker-tools';

const execAsync = promisify(exec);
const isDocker = process.env.DOCKER === 'true' || fs.existsSync('/.dockerenv');
const CONTINUITY_PATH = isDocker
  ? path.resolve(PIXEL_ROOT, 'CONTINUITY.md')
  : path.resolve(PIXEL_ROOT, 'syntropy-core/CONTINUITY.md');

export const tools = {
  readContinuity: tool({
    description: 'Read the Continuity Ledger. This is the canonical session briefing designed to survive context compaction.',
    inputSchema: z.object({}),
    execute: async () => {
      console.log('[SYNTROPY] Tool: readContinuity');
      try {
        if (!fs.existsSync(CONTINUITY_PATH)) return "Continuity Ledger not found.";
        const content = await fs.readFile(CONTINUITY_PATH, 'utf-8');
        await logAudit({ type: 'continuity_read', content });
        return content;
      } catch (error: any) {
        return { error: error.message };
      }
    }
  }),

  updateContinuity: tool({
    description: 'Update the Continuity Ledger. Use this whenever the goal, constraints, key decisions, or progress state change.',
    inputSchema: z.object({
      content: z.string().describe('The full updated content of CONTINUITY.md. Maintain the standard headings.')
    }),
    execute: async ({ content }) => {
      console.log('[SYNTROPY] Tool: updateContinuity');
      try {
        await fs.writeFile(CONTINUITY_PATH, content);
        await logAudit({ type: 'continuity_update', content });
        return { success: true };
      } catch (error: any) {
        return { error: error.message };
      }
    }
  }),

  getEcosystemStatus: tool({
    description: 'Get status of all containers in the ecosystem via Docker',
    inputSchema: z.object({
      confirm: z.boolean().describe('Set to true to perform ecosystem audit')
    }),
    execute: async () => {
      console.log('[SYNTROPY] Tool: getEcosystemStatus (Docker)');
      try {
        // Get container status in JSON format
        const { stdout: rawOutput } = await execAsync('docker ps --format "{{json .}}"', { timeout: 10000 });
        const lines = rawOutput.toString().trim().split('\n');

        const status = lines.map(line => {
          try {
            const container = JSON.parse(line);
            return {
              name: container.Names,
              status: container.Status,
              image: container.Image,
              id: container.ID
            };
          } catch (e) {
            return null;
          }
        }).filter(Boolean);

        await logAudit({ type: 'ecosystem_audit', status });
        return status;
      } catch (error: any) {
        await logAudit({ type: 'audit_error', error: error.message });
        return { error: `Docker error: ${error.message}` };
      }
    }
  }),

  gitSync: tool({
    description: `Commit and push changes across all repositories. Use this ONLY when you have made meaningful changes that should be persisted. 
    
WHEN TO USE:
- After updating CONTINUITY.md with significant changes
- After writing evolution reports
- After successful code mutations
- After modifying configuration files

WHEN NOT TO USE:
- After routine read operations
- After failed operations (nothing to commit)
- Multiple times in rapid succession (rate limit: once per 10 minutes)

The reason you provide becomes the commit message - make it descriptive!`,
    inputSchema: z.object({
      reason: z.string().describe('A descriptive commit message explaining what changed and why. This becomes the git commit message.')
    }),
    execute: async ({ reason }) => {
      console.log(`[SYNTROPY] Tool: gitSync - "${reason}"`);

      // Rate limiting - prevent spam commits
      const lastSyncFile = path.join(PIXEL_ROOT, 'data', '.last-sync');
      const now = Date.now();
      const minInterval = 10 * 60 * 1000; // 10 minutes

      try {
        if (fs.existsSync(lastSyncFile)) {
          const lastSync = parseInt(await fs.readFile(lastSyncFile, 'utf-8'), 10);
          if (now - lastSync < minInterval) {
            const waitMins = Math.ceil((minInterval - (now - lastSync)) / 60000);
            return {
              skipped: true,
              message: `Rate limited. Last sync was ${Math.round((now - lastSync) / 60000)} minutes ago. Wait ${waitMins} more minutes.`
            };
          }
        }
      } catch (e) {
        // Ignore read errors
      }

      try {
        await syncAll({ reason });

        // Update last sync timestamp
        await fs.ensureDir(path.dirname(lastSyncFile));
        await fs.writeFile(lastSyncFile, now.toString());

        await logAudit({ type: 'git_sync', reason });
        return { success: true, message: `Synced with commit: "${reason}"` };
      } catch (error: any) {
        await logAudit({ type: 'git_sync_error', reason, error: error.message });
        return { error: `Sync failed: ${error.message}` };
      }
    }
  }),

  gitUpdate: tool({
    description: 'Update the local codebase from GitHub. Use this if you believe the remote repository has changes you need (e.g., after a PR merge or when instructed).',
    inputSchema: z.object({
      confirm: z.boolean().describe('Set to true to confirm the update operation')
    }),
    execute: async () => {
      console.log('[SYNTROPY] Tool: gitUpdate');
      try {
        const { stdout: status } = await execAsync('git status --porcelain', { cwd: PIXEL_ROOT });
        if (status.trim()) {
          // We have local changes. Stash them first?
          // For safety, we will abort and ask the agent to commit first via gitSync.
          return {
            success: false,
            message: "Cannot update: You have uncommitted local changes. Please use 'gitSync' to save your work first, or stash them manually."
          };
        }

        console.log('[SYNTROPY] Fetching updates...');
        await execAsync('git fetch origin', { cwd: PIXEL_ROOT });

        const { stdout: behind } = await execAsync('git rev-list HEAD..origin/master --count', { cwd: PIXEL_ROOT });
        const count = parseInt(behind.trim(), 10);

        if (count === 0) {
          return { success: true, message: "Already up to date." };
        }

        console.log(`[SYNTROPY] Pulling ${count} commits...`);
        // We are clean, so rebase should be safe, but --autostash just in case
        const { stdout: pullLog } = await execAsync('git pull --rebase --autostash origin master', { cwd: PIXEL_ROOT });

        // Also update submodules
        await execAsync('git submodule update --init --recursive', { cwd: PIXEL_ROOT });

        await logAudit({ type: 'git_update', commits: count });
        return {
          success: true,
          message: `Successfully updated ${count} commits from origin/master.`,
          details: pullLog
        };
      } catch (error: any) {
        await logAudit({ type: 'git_update_error', error: error.message });
        return { error: `Update failed: ${error.message}` };
      }
    }
  }),

  readAgentLogs: tool({
    description: 'Read recent logs from the Pixel agent. Automatically filters noise for Syntropy intelligence.',
    inputSchema: z.object({
      lines: z.number().describe('Number of lines to read (e.g. 100)')
    }),
    execute: async ({ lines }) => {
      console.log(`[SYNTROPY] Tool: readAgentLogs (${lines} lines)`);
      try {
        if (fs.existsSync(LOG_PATH)) {
          // Read 5x more lines than requested to have enough data after filtering
          const { stdout: rawLogs } = await execAsync(`tail -n ${lines * 5} ${LOG_PATH}`, { timeout: 10000 });
          const logLines = rawLogs.toString().split('\n');

          const filteredLines = logLines.filter(line => {
            const lowerLine = line.toLowerCase();

            // Priority: Always keep these high-value logs
            if (line.includes('[REFLECTION]') ||
              line.includes('[LORE]') ||
              line.includes('[ZAP]') ||
              line.includes('[DM]') ||
              line.includes('[NOSTR] Replied to') ||
              line.includes('[NOSTR] Reacted to')) {
              return true;
            }

            // Filter out common high-frequency noise
            if (lowerLine.includes('too many concurrent reqs')) return false;
            if (lowerLine.includes('drizzleadapter creatememory')) return false;
            if (lowerLine.includes('creating memory id=')) return false;
            if (lowerLine.includes('connection healthy, last event received')) return false;
            if (lowerLine.includes('stats:') && lowerLine.includes('calls saved')) return false;
            if (lowerLine.includes('invalid iv length')) return false;
            if (lowerLine.includes('skipping old mention')) return false;
            if (lowerLine.includes('event kind 1 from')) return false;

            // Additional filters for better ingestion value
            if (lowerLine.includes('debug')) return false; // DEBUG level logs
            if (lowerLine.includes('notice from')) return false; // Relay notices/errors
            if (lowerLine.includes('bad req:')) return false;
            if (lowerLine.includes('discovery skipping muted user')) return false; // meaningless ids
            if (lowerLine.includes('timeline lore processing deferred')) return false;
            if (lowerLine.includes('llm generation attempt') && lowerLine.includes('failed')) return false; // unless critical
            if (lowerLine.includes('all llm generation retries failed')) return false; // redundant
            if (lowerLine.includes('round') && lowerLine.includes('metrics:')) return false; // unless quality > 0
            if (lowerLine.includes('adaptive threshold activated')) return false;
            if (lowerLine.includes('continuing to round')) return false;
            if (lowerLine.includes('discovery round')) return false;
            if (lowerLine.includes('round topics (fallback):')) return false;
            if (lowerLine.includes('expanded search params:')) return false;
            if (lowerLine.includes('discovery "') && lowerLine.includes('": relevant')) return false; // generic discovery stats
            if (lowerLine.includes('generating text with')) return false; // LLM setup noise
            if (/\b[0-9a-f]{8}\b/.test(line)) return false; // filter lines with meaningless hex ids

            // Filter out large JSON objects (usually context or stats)
            if (line.trim().startsWith('{') || line.trim().startsWith('[')) {
              if (line.length > 500) return false;
            }

            // Filter out empty lines
            if (!line.trim()) return false;

            return true;
          });

          const result = filteredLines.slice(-lines).join('\n');
          await logAudit({ type: 'logs_read', lines, filtered: true });
          return result || "No relevant logs found after filtering.";
        }
        return "Log file not found";
      } catch (error: any) {
        return { error: error.message };
      }
    }
  }),

  checkTreasury: tool({
    description: 'Check the Lightning Network treasury balance (LNPixels DB)',
    inputSchema: z.object({
      confirm: z.boolean().describe('Set to true to check treasury balance')
    }),
    execute: async () => {
      console.log('[SYNTROPY] Tool: checkTreasury');
      let db;
      try {
        if (!fs.existsSync(DB_PATH)) return "Database not found";
        // @ts-ignore
        const { Database } = await import('bun:sqlite');
        db = new Database(DB_PATH);
        const result = db.query('SELECT SUM(sats) as total FROM pixels').get() as any;
        const activityCount = db.query('SELECT COUNT(*) as count FROM activity').get() as any;
        const data = { totalSats: result?.total || 0, transactionCount: activityCount?.count || 0 };
        await logAudit({ type: 'treasury_check', ...data });
        return data;
      } catch (error: any) {
        await logAudit({ type: 'treasury_error', error: error.message });
        return { error: `SQLite error: ${error.message}` };
      } finally {
        if (db) db.close();
      }
    }
  }),

  getVPSMetrics: tool({
    description: `Get VPS host machine resource metrics for capacity planning and operations decisions.

Returns:
- CPU load averages (1, 5, 15 minute) and load per core
- Memory usage (total, used, available, buffered/cached, swap, %)
- Disk space (total, used, available, %)
- System uptime
- Per-container CPU, memory, network, and block I/O stats

Use this tool to:
- Check disk space before spawning workers or creating backups
- Monitor memory pressure and identify container memory hogs  
- Detect degraded performance (high load averages)
- Make deployment decisions (can we add more services?)
- Trigger cleanup actions when resources are low

IMPORTANT: 
- Check the 'status' field first - 'STALE' means vps-monitor may be down
- 'actionRequired: true' means alerts were triggered
- Use the 'recommendations' array for suggested actions`,

    inputSchema: z.object({
      thresholds: z.object({
        diskPercent: z.number().optional().describe('Alert if disk usage exceeds this (default: 85)'),
        memoryPercent: z.number().optional().describe('Alert if memory usage exceeds this (default: 90)'),
        swapPercent: z.number().optional().describe('Alert if swap usage exceeds this (default: 50)'),
        loadPerCore: z.number().optional().describe('Alert if load per core exceeds this (default: 1.5)')
      }).optional().describe('Custom alert thresholds (uses sensible defaults if omitted)')
    }),

    execute: async ({ thresholds }) => {
      console.log('[SYNTROPY] Tool: getVPSMetrics');
      const metricsPath = path.join(PIXEL_ROOT, 'data', 'vps-metrics.json');

      try {
        // ============================================
        // CHECK FILE EXISTS
        // ============================================
        if (!fs.existsSync(metricsPath)) {
          await logAudit({ type: 'vps_metrics_error', error: 'metrics_file_not_found' });
          return {
            status: 'ERROR',
            error: 'VPS metrics file not found',
            suggestion: 'Start the vps-monitor container: docker compose up -d vps-monitor',
            actionRequired: true
          };
        }

        const metrics = await fs.readJson(metricsPath);

        // ============================================
        // STALENESS CHECK
        // ============================================
        const metricTime = new Date(metrics.timestamp).getTime();
        const ageSeconds = (Date.now() - metricTime) / 1000;
        const ageMinutes = ageSeconds / 60;
        const isStale = ageMinutes > 2; // >2 minutes = stale

        if (isStale) {
          await logAudit({
            type: 'vps_metrics_stale',
            ageMinutes: parseFloat(ageMinutes.toFixed(1)),
            lastTimestamp: metrics.timestamp
          });
          return {
            status: 'STALE',
            error: `Metrics are ${ageMinutes.toFixed(1)} minutes old (threshold: 2 min)`,
            suggestion: 'Check vps-monitor container: docker compose logs vps-monitor --tail 20',
            lastTimestamp: metrics.timestamp,
            ageMinutes: parseFloat(ageMinutes.toFixed(1)),
            actionRequired: true
          };
        }

        // ============================================
        // APPLY ALERT THRESHOLDS
        // ============================================
        const t = {
          diskPercent: thresholds?.diskPercent ?? 85,
          memoryPercent: thresholds?.memoryPercent ?? 90,
          swapPercent: thresholds?.swapPercent ?? 50,
          loadPerCore: thresholds?.loadPerCore ?? 1.5
        };

        const alerts: string[] = [];
        const recommendations: string[] = [];

        // Disk check
        const diskPercent = metrics.disk.usagePercent;
        if (diskPercent > t.diskPercent) {
          alerts.push(`🚨 DISK CRITICAL: ${diskPercent.toFixed(1)}% used (threshold: ${t.diskPercent}%)`);
          recommendations.push('docker system prune -af --volumes');
          recommendations.push('Delete old backups: find ./backups -mtime +7 -delete');
          recommendations.push('Check large files: du -sh ./data/* | sort -h');
        } else if (diskPercent > t.diskPercent - 10) {
          alerts.push(`⚠️  DISK WARNING: ${diskPercent.toFixed(1)}% used (approaching ${t.diskPercent}% threshold)`);
          recommendations.push('Consider running docker system prune');
        }

        // Memory check
        const memPercent = metrics.memory.usagePercent;
        if (memPercent > t.memoryPercent) {
          alerts.push(`🚨 MEMORY CRITICAL: ${memPercent.toFixed(1)}% used (threshold: ${t.memoryPercent}%)`);
          recommendations.push('Check container memory with containerStats below');
          recommendations.push('Consider restarting memory-hungry containers');
          recommendations.push('Check for memory leaks in agent logs');
        } else if (memPercent > t.memoryPercent - 10) {
          alerts.push(`⚠️  MEMORY WARNING: ${memPercent.toFixed(1)}% used (approaching ${t.memoryPercent}% threshold)`);
        }

        // Swap check
        const swapPercent = metrics.swap.usagePercent;
        if (swapPercent > t.swapPercent) {
          alerts.push(`⚠️  SWAP IN USE: ${swapPercent.toFixed(1)}% (threshold: ${t.swapPercent}%)`);
          recommendations.push('System is swapping - performance may be degraded');
          recommendations.push('Consider increasing RAM or reducing container memory limits');
        }

        // CPU load check (normalized per core)
        const loadPerCore = metrics.cpu.loadPerCore1min;
        const load1 = metrics.cpu.loadAvg1min;
        if (loadPerCore > t.loadPerCore) {
          alerts.push(`⚠️  HIGH LOAD: ${load1.toFixed(2)} (${loadPerCore.toFixed(2)} per core, threshold: ${t.loadPerCore})`);
          recommendations.push('Check for runaway processes or container issues');
          recommendations.push('Review containerStats below for CPU hogs');
        }

        // ============================================
        // FORMAT OUTPUT FOR LLM CONSUMPTION
        // ============================================
        const formatBytes = (bytes: number): string => {
          if (bytes === 0) return '0 B';
          if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
          if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
          if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
          if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
          return `${bytes} B`;
        };

        const formatKb = (kb: number): string => formatBytes(kb * 1024);

        // Format container stats for readability, sorted by memory
        const containerSummary = (metrics.containers || [])
          .map((c: any) => ({
            name: c.Name || c.Container || 'unknown',
            cpu: c.CPUPerc || '0%',
            memory: c.MemUsage || 'N/A',
            memPercent: c.MemPerc || '0%',
            netIO: c.NetIO || 'N/A',
            blockIO: c.BlockIO || 'N/A',
            pids: c.PIDs || '0'
          }))
          .sort((a: any, b: any) => {
            // Sort by memory percentage descending
            const aNum = parseFloat(a.memPercent) || 0;
            const bNum = parseFloat(b.memPercent) || 0;
            return bNum - aNum;
          });

        // Determine overall status
        const hasCritical = alerts.some(a => a.includes('CRITICAL'));
        const hasWarning = alerts.some(a => a.includes('WARNING') || a.includes('⚠️'));
        const status = hasCritical ? 'CRITICAL' : hasWarning ? 'WARNING' : 'HEALTHY';

        const result = {
          status,
          timestamp: metrics.timestamp,
          hostname: metrics.hostname,
          stale: false,
          ageSeconds: Math.round(ageSeconds),

          // Quick summary for fast comprehension
          summary: {
            cpu: `Load: ${load1.toFixed(2)} / ${metrics.cpu.loadAvg5min.toFixed(2)} / ${metrics.cpu.loadAvg15min.toFixed(2)} (1/5/15 min avg, ${metrics.cpu.cores} cores)`,
            memory: `${formatKb(metrics.memory.usedKb)} / ${formatKb(metrics.memory.totalKb)} (${memPercent.toFixed(1)}% used)`,
            swap: swapPercent > 0
              ? `${formatKb(metrics.swap.usedKb)} / ${formatKb(metrics.swap.totalKb)} (${swapPercent.toFixed(1)}% used)`
              : 'Not in use',
            disk: `${formatBytes(metrics.disk.usedBytes)} / ${formatBytes(metrics.disk.totalBytes)} (${diskPercent.toFixed(1)}% used, ${formatBytes(metrics.disk.availableBytes)} free)`,
            uptime: `${metrics.uptime.days}d ${metrics.uptime.hours % 24}h`
          },

          // Detailed breakdown
          details: {
            cpu: {
              cores: metrics.cpu.cores,
              loadAvg1min: load1,
              loadAvg5min: metrics.cpu.loadAvg5min,
              loadAvg15min: metrics.cpu.loadAvg15min,
              loadPerCore: loadPerCore
            },
            memory: {
              total: formatKb(metrics.memory.totalKb),
              used: formatKb(metrics.memory.usedKb),
              available: formatKb(metrics.memory.availableKb),
              buffersAndCache: formatKb(metrics.memory.buffersKb + metrics.memory.cachedKb),
              usagePercent: memPercent
            },
            swap: {
              total: formatKb(metrics.swap.totalKb),
              used: formatKb(metrics.swap.usedKb),
              free: formatKb(metrics.swap.freeKb),
              usagePercent: swapPercent
            },
            disk: {
              total: formatBytes(metrics.disk.totalBytes),
              used: formatBytes(metrics.disk.usedBytes),
              available: formatBytes(metrics.disk.availableBytes),
              usagePercent: diskPercent
            },
            uptime: {
              days: metrics.uptime.days,
              hours: metrics.uptime.hours,
              seconds: metrics.uptime.seconds
            }
          },

          // Per-container stats (sorted by memory usage)
          containerStats: containerSummary,
          containerCount: containerSummary.length,

          // Alerts and recommendations
          alerts: alerts.length > 0 ? alerts : ['✅ All systems nominal'],
          recommendations,
          actionRequired: alerts.length > 0,

          // Metadata
          collectionDurationMs: metrics.collectionDurationMs,
          schemaVersion: metrics.version
        };

        await logAudit({
          type: 'vps_metrics',
          status: result.status,
          diskPercent: parseFloat(diskPercent.toFixed(1)),
          memPercent: parseFloat(memPercent.toFixed(1)),
          swapPercent: parseFloat(swapPercent.toFixed(1)),
          load1: parseFloat(load1.toFixed(2)),
          alertCount: alerts.length
        });

        return result;
      } catch (error: any) {
        await logAudit({ type: 'vps_metrics_error', error: error.message });
        return {
          status: 'ERROR',
          error: `Failed to read VPS metrics: ${error.message}`,
          actionRequired: true
        };
      }
    }
  }),

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

        // Append to the bridge file (the agent consumes it)
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
      try {
        // Use pool.querySync directly instead of poolList - poolList has issues returning stale data
        const script = `
const { SimplePool, nip19, getPublicKey } = require('nostr-tools');
const WebSocket = require('ws');
global.WebSocket = WebSocket;

async function run() {
  const sk = process.env.NOSTR_PRIVATE_KEY;
  // Use a broad set of relays including Primal for best coverage
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
    // Use querySync directly - it properly returns the most recent events
    const posts = await pool.querySync(relays, { authors: [pk], kinds: [1], limit: ${limit} });
    console.log(JSON.stringify(posts.sort((a, b) => b.created_at - a.created_at)));
  } finally {
    try { pool.close(relays); } catch (e) {}
    process.exit(0);
  }
}
run();
`;
        const { stdout, stderr } = await execAsync(
          `docker exec pixel-agent-1 bun -e "${script.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
          { timeout: 30000 }
        );

        if (stderr && stderr.includes('ERROR:')) {
          return { error: stderr };
        }

        const posts = JSON.parse(stdout.trim());
        await logAudit({ type: 'pixel_nostr_feed_read', count: posts.length });
        return { posts };
      } catch (error: any) {
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
        const { stdout, stderr } = await execAsync(
          `docker exec pixel-agent-1 bun -e "${script.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
          { timeout: 30000 }
        );

        if (stderr && stderr.includes('ERROR:')) {
          return { error: stderr };
        }

        const mentions = JSON.parse(stdout.trim());
        await logAudit({ type: 'pixel_nostr_mentions_read', count: mentions.length });
        return { mentions };
      } catch (error: any) {
        return { error: `Failed to read Pixel mentions: ${error.message}` };
      }
    }
  }),

  readPixelMemories: tool({
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
        // Build query based on category
        let whereClause: string;
        if (contentType) {
          whereClause = `content->>'type' = '${contentType}'`;
        } else if (category === 'narratives') {
          whereClause = `content->>'type' IN ('hourly_digest', 'daily_report', 'weekly_summary', 'narrative_timeline')`;
        } else if (category === 'topics') {
          whereClause = `content->>'type' = 'emerging_story'`;
        } else {
          whereClause = `content->>'type' IS NOT NULL`; // all typed memories
        }

        const query = `SELECT id, created_at, content FROM memories WHERE ${whereClause} ORDER BY created_at DESC LIMIT ${limit}`;

        const { stdout, stderr } = await execAsync(
          `docker exec pixel-postgres-1 psql -U postgres -d pixel_agent -t -c "${query.replace(/"/g, '\\"')}"`,
          { timeout: 15000 }
        );

        if (stderr && stderr.toLowerCase().includes('error')) {
          return { error: stderr };
        }

        // Parse the tabular output from psql
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

        // Format results based on category
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
  }),

  getPixelStats: tool({
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

        // Parse tabular output
        const stats = stdout.trim().split('\n').filter(line => line.trim()).map(line => {
          const parts = line.split('|').map(p => p.trim());
          return {
            type: parts[0] || 'untyped',
            source: parts[1] || 'unknown',
            count: parseInt(parts[2]) || 0
          };
        });

        const totalMemories = stats.reduce((sum, s) => sum + s.count, 0);

        // Group by type
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
  }),

  readCharacterFile: tool({
    description: 'Read a specific part of Pixel\'s character DNA',
    inputSchema: z.object({
      file: z.enum(['bio.ts', 'topics.ts', 'style.ts', 'postExamples.ts', 'messageExamples.ts'])
    }),
    execute: async ({ file }) => {
      try {
        const filePath = path.resolve(CHARACTER_DIR, file);
        return await fs.readFile(filePath, 'utf-8');
      } catch (error: any) {
        return { error: error.message };
      }
    }
  }),

  mutateCharacter: tool({
    description: 'Mutate a specific part of Pixel\'s character DNA. Automatically builds and reboots the agent.',
    inputSchema: z.object({
      file: z.enum(['bio.ts', 'topics.ts', 'style.ts', 'postExamples.ts', 'messageExamples.ts']),
      content: z.string().describe('The full content of the file to write')
    }),
    execute: async ({ file, content }) => {
      console.log(`[SYNTROPY] Tool: mutateCharacter (${file})`);
      const filePath = path.resolve(CHARACTER_DIR, file);
      const varName = file.split('.')[0];
      let oldContent = "";

      try {
        // 1. Validation de base
        const exportRegex = new RegExp(`export\\s+(const|let|var)\\s+${varName}\\b`, 'm');
        if (!exportRegex.test(content)) {
          return { error: `Validation failed: Content must export '${varName}'` };
        }

        // 2. Backup old content
        if (fs.existsSync(filePath)) {
          oldContent = await fs.readFile(filePath, 'utf-8');
        }

        await logAudit({ type: 'mutation_start', file });

        // 3. Write new content
        await fs.writeFile(filePath, content);

        try {
          // 4. Validate build ecosystem-wide
          console.log('[SYNTROPY] Validating mutation build...');
          await execAsync('./scripts/validate-build.sh', { cwd: PIXEL_ROOT, timeout: 300000 });

          // 5. Build agent specifically and restart
          await execAsync('bun run build', { cwd: PIXEL_AGENT_DIR, timeout: 180000 });
          await execAsync('docker restart pixel-agent-1', { timeout: 20000 });

          await syncAll({ reason: `feat(pixel-agent): mutate ${file}` });
          await logAudit({ type: 'mutation_success', file });
          return { success: true, mutatedFile: file };
        } catch (buildError: any) {
          // 6. Rollback
          console.error(`[SYNTROPY] Mutation build failed: ${buildError.message}. Rolling back...`);
          if (oldContent) {
            await fs.writeFile(filePath, oldContent);
          }
          await logAudit({ type: 'mutation_rollback', file, error: buildError.message });
          return { error: `Mutation failed validation. Reverted to previous stable version. Error: ${buildError.message}` };
        }
      } catch (error: any) {
        return { error: `Mutation process failed: ${error.message}` };
      }
    }
  }),

  writeEvolutionReport: tool({
    description: `Write an evolution report. Use sparingly - only for significant events:
- Successful code mutations or fixes
- Critical errors discovered and resolved  
- Major architectural decisions
- Treasury milestones (e.g., crossed 100k sats)
Do NOT write reports for routine health checks or status updates.`,
    inputSchema: z.object({
      content: z.string().describe('Markdown content of the report'),
      title: z.string().describe('Title of the evolution phase'),
      significance: z.enum(['critical', 'major', 'minor']).describe('How significant is this report? critical=must record, major=important milestone, minor=routine (avoid)')
    }),
    execute: async ({ content, title, significance }) => {
      // Skip minor reports to reduce bloat
      if (significance === 'minor') {
        console.log(`[SYNTROPY] Skipping minor evolution report: ${title}`);
        return { success: true, skipped: true, reason: 'Minor reports are not persisted to reduce bloat' };
      }

      console.log(`[SYNTROPY] Tool: writeEvolutionReport (${title}) [${significance}]`);
      await logAudit({ type: 'evolution_report', title, significance });
      try {
        const reportDir = isDocker
          ? path.resolve(PIXEL_ROOT, 'audit/evolution')
          : path.resolve(PIXEL_ROOT, 'docs/evolution');
        await fs.ensureDir(reportDir);
        const filename = `${Date.now()}-${title.toLowerCase().replace(/\\s+/g, '-')}.md`;
        await fs.writeFile(path.resolve(reportDir, filename), content);

        // Auto-prune: Keep only the last 10 reports
        const MAX_REPORTS = 10;
        const files = await fs.readdir(reportDir);
        const mdFiles = files.filter(f => f.endsWith('.md')).sort();
        if (mdFiles.length > MAX_REPORTS) {
          const toDelete = mdFiles.slice(0, mdFiles.length - MAX_REPORTS);
          for (const file of toDelete) {
            await fs.remove(path.resolve(reportDir, file));
            console.log(`[SYNTROPY] Pruned old evolution report: ${file}`);
          }
        }

        const syntropyJsonPath = isDocker
          ? path.resolve(PIXEL_ROOT, 'audit/syntropy.json')
          : path.resolve(PIXEL_ROOT, 'pixel-landing/public/syntropy.json');

        await fs.writeJson(syntropyJsonPath, {
          lastUpdate: new Date().toISOString(),
          title,
          content,
          significance,
          status: 'EVOLUTION_STEP_COMPLETE'
        });
        return { success: true };
      } catch (error: any) {
        await logAudit({ type: 'report_error', title, error: error.message });
        return { error: error.message };
      }
    }
  }),

  // NOTE: delegateToOpencode has been replaced by spawnWorker (worker-tools.ts)
  // The worker architecture prevents accidental self-destruction by running
  // Opencode in ephemeral containers with guardrails.

  notifyHuman: tool({
    description: 'Send a high-priority notification to the human operator. Use this when you are stuck, need a decision, or have a critical breakthrough. It writes to NOTIFICATIONS.md and logs loudly.',
    inputSchema: z.object({
      message: z.string().describe('The message for the human. Be concise and actionable.'),
      priority: z.enum(['low', 'medium', 'high', 'critical']).describe('Priority level.')
    }),
    execute: async ({ message, priority }) => {
      console.log(`[SYNTROPY] 🚨 NOTIFY HUMAN [${priority}]: ${message}`);
      const notificationPath = path.resolve(PIXEL_ROOT, 'NOTIFICATIONS.md');
      const entry = `\n## [${new Date().toISOString()}] Priority: ${priority}\n${message}\n`;

      try {
        await fs.appendFile(notificationPath, entry);
        await logAudit({ type: 'human_notification', message, priority });
        return { success: true, file: 'NOTIFICATIONS.md' };
      } catch (e: any) {
        return { error: e.message };
      }
    }
  }),

  readAudit: tool({
    description: 'Read recent entries from the Syntropy audit log for self-awareness and historical analysis. Reads the most recent entries by default.',
    inputSchema: z.object({
      lines: z.number().optional().describe('Number of recent audit entries to read (default: 50, max: 500)')
    }),
    execute: async ({ lines = 50 }) => {
      console.log(`[SYNTROPY] Tool: readAudit (${lines} entries)`);
      try {
        if (!fs.existsSync(AUDIT_LOG_PATH)) {
          return "Audit log not found.";
        }

        const content = await fs.readFile(AUDIT_LOG_PATH, 'utf-8');
        const auditLines = content.trim().split('\n').filter(line => line.trim());

        // Parse and get the most recent entries
        const maxLines = Math.min(Math.max(lines, 1), 500);
        const recentEntries = auditLines.slice(-maxLines).map(line => {
          try {
            return JSON.parse(line);
          } catch (e) {
            return { parse_error: line.substring(0, 100) + '...' };
          }
        });

        await logAudit({ type: 'audit_read', entries_requested: lines, entries_returned: recentEntries.length });
        return recentEntries;
      } catch (error: any) {
        return { error: error.message };
      }
    }
  }),

  processRefactorQueue: tool({
    description: `Process ONE task from the REFACTOR_QUEUE.md file. This enables autonomous codebase improvement.
    
PROTOCOL:
1. Call with action='check' to see the next available task
2. Call with action='execute' and taskId to process that specific task
3. Only process ONE task per Syntropy cycle to maintain stability

This tool picks up refactoring tasks that break the "spaghetti" codebase into clean modules.
Tasks are designed to be atomic and safe - each has rollback instructions if needed.

NOTE: Refactoring tasks are executed by spawning a worker container. Use checkWorkerStatus
to monitor progress after execution starts.`,
    inputSchema: z.object({
      action: z.enum(['check', 'execute']).describe("'check' to see next task, 'execute' to run a specific task"),
      taskId: z.string().optional().describe("Task ID to execute (e.g., 'T001'). Required if action='execute'")
    }),
    execute: async ({ action, taskId }) => {
      const QUEUE_PATH = path.resolve(PIXEL_ROOT, 'REFACTOR_QUEUE.md');
      console.log(`[SYNTROPY] Tool: processRefactorQueue (action=${action}, taskId=${taskId || 'N/A'})`);

      try {
        if (!fs.existsSync(QUEUE_PATH)) {
          return { error: 'REFACTOR_QUEUE.md not found. Create it first.' };
        }

        const content = await fs.readFile(QUEUE_PATH, 'utf-8');

        if (action === 'check') {
          // Find the next READY task
          const taskPattern = /### (T\d{3}): ([^\n]+) (⬜ READY|🟡 IN_PROGRESS|✅ DONE|❌ FAILED)/g;
          const tasks: Array<{ id: string, title: string, status: string }> = [];
          let match;

          while ((match = taskPattern.exec(content)) !== null) {
            tasks.push({ id: match[1], title: match[2], status: match[3] });
          }

          const readyTasks = tasks.filter(t => t.status === '⬜ READY');
          const inProgress = tasks.filter(t => t.status === '🟡 IN_PROGRESS');
          const done = tasks.filter(t => t.status === '✅ DONE');

          if (inProgress.length > 0) {
            return {
              warning: 'A task is already in progress',
              inProgress: inProgress[0],
              message: 'Wait for current task to complete or mark it as DONE/FAILED'
            };
          }

          if (readyTasks.length === 0) {
            return {
              message: 'No READY tasks in queue!',
              stats: { ready: 0, done: done.length, total: tasks.length }
            };
          }

          // Check dependencies for the first ready task
          const nextTask = readyTasks[0];
          const taskSection = content.slice(
            content.indexOf(`### ${nextTask.id}:`),
            content.indexOf(`### T${String(parseInt(nextTask.id.slice(1)) + 1).padStart(3, '0')}:`) || content.length
          );

          const dependsMatch = taskSection.match(/\*\*Depends\*\*: (T\d{3}(?:[-,]\s*T\d{3})*)/);
          let blockedBy: string[] = [];

          if (dependsMatch) {
            const deps = dependsMatch[1].match(/T\d{3}/g) || [];
            const doneTasks = done.map(t => t.id);
            blockedBy = deps.filter(d => !doneTasks.includes(d));
          }

          if (blockedBy.length > 0) {
            // Find next unblocked task
            for (const task of readyTasks.slice(1)) {
              const section = content.slice(
                content.indexOf(`### ${task.id}:`),
                content.indexOf(`### T${String(parseInt(task.id.slice(1)) + 1).padStart(3, '0')}:`) || content.length
              );
              const depMatch = section.match(/\*\*Depends\*\*: (T\d{3}(?:[-,]\s*T\d{3})*)/);
              if (!depMatch) {
                return {
                  nextTask: task,
                  note: `${nextTask.id} is blocked by ${blockedBy.join(', ')}, suggesting ${task.id} instead`,
                  stats: { ready: readyTasks.length, done: done.length }
                };
              }
            }
            return {
              blocked: true,
              nextTask: nextTask,
              blockedBy,
              message: `First ready task ${nextTask.id} is blocked by incomplete dependencies`
            };
          }

          // Extract INSTRUCTIONS block
          const instructionsMatch = taskSection.match(/```\nINSTRUCTIONS:\n([\s\S]*?)(?:\nVERIFY:|```)/);
          const instructions = instructionsMatch ? instructionsMatch[1].trim() : 'No instructions found';

          return {
            nextTask,
            instructions: instructions.substring(0, 500) + (instructions.length > 500 ? '...' : ''),
            stats: { ready: readyTasks.length, done: done.length, total: tasks.length },
            action: `Call processRefactorQueue with action='execute' and taskId='${nextTask.id}' to process this task`
          };
        }

        if (action === 'execute') {
          if (!taskId) {
            return { error: "taskId is required for action='execute'" };
          }

          // Find the task section
          const taskHeaderPattern = new RegExp(`### ${taskId}: ([^\\n]+) (⬜ READY|🟡 IN_PROGRESS)`);
          const headerMatch = content.match(taskHeaderPattern);

          if (!headerMatch) {
            return { error: `Task ${taskId} not found or not in READY/IN_PROGRESS status` };
          }

          // Extract the full task section
          const taskStart = content.indexOf(`### ${taskId}:`);
          const nextTaskMatch = content.slice(taskStart + 10).match(/### T\d{3}:/);
          const taskEnd = nextTaskMatch ? taskStart + 10 + nextTaskMatch.index! : content.length;
          const taskSection = content.slice(taskStart, taskEnd);

          // Extract INSTRUCTIONS
          const instructionsMatch = taskSection.match(/```\nINSTRUCTIONS:\n([\s\S]*?)(?:\nVERIFY:|```)/);
          if (!instructionsMatch) {
            return { error: `No INSTRUCTIONS block found for ${taskId}` };
          }
          const instructions = instructionsMatch[1].trim();

          // Extract VERIFY command
          const verifyMatch = taskSection.match(/VERIFY:\n([\s\S]*?)```/);
          const verifyCommand = verifyMatch ? verifyMatch[1].trim() : null;

          // Mark as IN_PROGRESS
          let updatedContent = content.replace(
            `### ${taskId}: ${headerMatch[1]} ${headerMatch[2]}`,
            `### ${taskId}: ${headerMatch[1]} 🟡 IN_PROGRESS`
          );
          await fs.writeFile(QUEUE_PATH, updatedContent);
          await logAudit({ type: 'refactor_task_start', taskId, title: headerMatch[1] });

          // Delegate to Worker (using the worker architecture for safety)
          console.log(`[SYNTROPY] Delegating refactor task ${taskId} to Worker...`);

          const workerTask = `REFACTORING TASK ${taskId}: ${headerMatch[1]}

${instructions}

After completing the task:
0. Analyze possible side effects and ensure no regressions
0.1 Run existing tests to confirm nothing is broken
0.2 Review code quality and maintainability improvements
0.3 Update all related documentation if applicable
1. Run the verification command if provided
2. Update REFACTOR_QUEUE.md to mark the task as ✅ DONE or ❌ FAILED
3. Update the "Last Processed" timestamp

VERIFICATION COMMAND:
${verifyCommand || 'No verification specified - manually confirm changes work'}

IMPORTANT: After you finish, update /pixel/REFACTOR_QUEUE.md:
- Change "🟡 IN_PROGRESS" to "✅ DONE" (if successful) or "❌ FAILED" (if failed)
- Update "**Last Processed**:" with current timestamp and task ID`;

          // Use the worker tools directly
          const { spawnWorkerInternal } = await import('./worker-tools');
          const workerResult = await spawnWorkerInternal({
            task: workerTask,
            context: `Refactoring task from REFACTOR_QUEUE.md. Task ID: ${taskId}`,
            priority: 'normal'
          });

          if ('error' in workerResult) {
            // Worker spawn failed - revert to READY status
            const revertContent = await fs.readFile(QUEUE_PATH, 'utf-8');
            const revertedContent = revertContent.replace(
              `### ${taskId}: ${headerMatch[1]} 🟡 IN_PROGRESS`,
              `### ${taskId}: ${headerMatch[1]} ⬜ READY`
            );
            await fs.writeFile(QUEUE_PATH, revertedContent);

            return {
              error: `Failed to spawn worker: ${workerResult.error}`,
              taskId,
              status: 'Reverted to READY'
            };
          }

          // Worker spawned successfully - it will update the queue when done
          return {
            taskId,
            status: '🟡 IN_PROGRESS',
            workerTaskId: workerResult.taskId,
            message: `Worker spawned for ${taskId}. Use checkWorkerStatus("${workerResult.taskId}") to monitor progress. Worker will update REFACTOR_QUEUE.md when complete.`
          };
        }

        return { error: 'Invalid action' };
      } catch (error: any) {
        await logAudit({ type: 'refactor_queue_error', error: error.message });
        return { error: error.message };
      }
    }
  }),

  addRefactorTask: tool({
    description: `Add a NEW atomic refactoring task to REFACTOR_QUEUE.md. Use this when you discover:
- Code quality issues that should be fixed
- Large files that need splitting
- Missing tests that should be added
- Documentation gaps
- Duplicate code that should be consolidated
- New features that require architectural prep

GUIDELINES FOR GOOD TASKS:
1. ATOMIC: Completable in one Opencode session (5-30 minutes)
2. SPECIFIC: Clear instructions, not vague like "improve code"
3. SAFE: Include verification command to confirm success
4. DEPENDENCY-AWARE: If task depends on others, specify them

The task will be appended to the queue with the next available ID.`,
    inputSchema: z.object({
      title: z.string().describe("Short title (e.g., 'Extract payment routes')"),
      phase: z.string().describe("Which phase/section (e.g., 'Phase 2: API Routes' or 'Phase 4: New Tasks')"),
      effort: z.string().describe("Estimated effort (e.g., '20 min', '1 hour')"),
      risk: z.enum(['None', 'Low', 'Medium', 'High']).describe("Risk level of this change"),
      parallelSafe: z.boolean().describe("Can this task run in parallel with others?"),
      depends: z.string().optional().describe("Task IDs this depends on (e.g., 'T024' or 'T024, T025')"),
      instructions: z.string().describe("Detailed step-by-step instructions for Opencode"),
      verifyCommand: z.string().describe("Shell command to verify success (e.g., 'npm test')")
    }),
    execute: async ({ title, phase, effort, risk, parallelSafe, depends, instructions, verifyCommand }) => {
      const QUEUE_PATH = path.resolve(PIXEL_ROOT, 'REFACTOR_QUEUE.md');
      console.log(`[SYNTROPY] Tool: addRefactorTask (${title})`);

      try {
        if (!fs.existsSync(QUEUE_PATH)) {
          return { error: 'REFACTOR_QUEUE.md not found. Create it first.' };
        }

        const content = await fs.readFile(QUEUE_PATH, 'utf-8');

        // Find the highest task ID
        const taskIds = content.match(/### T(\d{3}):/g) || [];
        const maxId = taskIds.reduce((max, id) => {
          const num = parseInt(id.match(/T(\d{3})/)?.[1] || '0');
          return Math.max(max, num);
        }, 0);

        const newTaskId = `T${String(maxId + 1).padStart(3, '0')}`;

        // Find or create the phase section
        const phaseHeader = `## 📋 ${phase}`;
        let insertPosition: number;

        if (content.includes(phaseHeader)) {
          // Find the end of this phase section (before next ## or end of file)
          const phaseStart = content.indexOf(phaseHeader);
          const nextSection = content.slice(phaseStart + phaseHeader.length).search(/\n## /);
          insertPosition = nextSection === -1
            ? content.length
            : phaseStart + phaseHeader.length + nextSection;
        } else {
          // Create new phase section at the end, before any footer content
          const footerMatch = content.match(/\n---\n\n\*This queue/);
          insertPosition = footerMatch?.index || content.length;
        }

        // Build the new task block
        const dependsLine = depends ? `\n**Depends**: ${depends}` : '';
        const newTask = `

### ${newTaskId}: ${title} ⬜ READY
**Effort**: ${effort} | **Risk**: ${risk} | **Parallel-Safe**: ${parallelSafe ? '✅' : '❌'}${dependsLine}

\`\`\`
INSTRUCTIONS:
${instructions}

VERIFY:
${verifyCommand}
\`\`\`

---
`;

        // Insert the task
        let newContent: string;
        if (!content.includes(phaseHeader)) {
          // Add new phase section
          const newPhase = `\n${phaseHeader}\n${newTask}`;
          newContent = content.slice(0, insertPosition) + newPhase + content.slice(insertPosition);
        } else {
          newContent = content.slice(0, insertPosition) + newTask + content.slice(insertPosition);
        }

        // Update the READY count in the status table
        const readyCount = (newContent.match(/⬜ READY/g) || []).length;
        newContent = newContent.replace(
          /\| ⬜ READY \| \d+ \|/,
          `| ⬜ READY | ${readyCount} |`
        );

        await fs.writeFile(QUEUE_PATH, newContent);
        await logAudit({
          type: 'refactor_task_added',
          taskId: newTaskId,
          title,
          phase,
          risk
        });

        return {
          success: true,
          taskId: newTaskId,
          title,
          phase,
          message: `Task ${newTaskId} added to queue. Total READY tasks: ${readyCount}`
        };
      } catch (error: any) {
        await logAudit({ type: 'refactor_task_add_error', error: error.message });
        return { error: error.message };
      }
    }
  }),

  analyzeForRefactoring: tool({
    description: `Analyze the codebase to discover potential refactoring opportunities. Use this to intelligently grow the refactor queue.

This tool will scan for common issues:
- Large files (>500 lines)
- Deeply nested code
- Duplicate patterns
- Missing test coverage
- Outdated dependencies

Returns suggestions that you can then add via 'addRefactorTask'.`,
    inputSchema: z.object({
      target: z.enum(['plugin-nostr', 'syntropy-core', 'lnpixels-api', 'all']).describe("Which component to analyze"),
      focusArea: z.enum(['file-size', 'complexity', 'test-coverage', 'dependencies', 'all']).describe("What aspect to focus on")
    }),
    execute: async ({ target, focusArea }) => {
      console.log(`[SYNTROPY] Tool: analyzeForRefactoring (${target}, ${focusArea})`);

      try {
        const suggestions: Array<{
          file: string;
          issue: string;
          suggestion: string;
          effort: string;
          priority: string;
        }> = [];

        // Define target paths
        const targetPaths: Record<string, string> = {
          'plugin-nostr': path.resolve(PIXEL_ROOT, 'pixel-agent/plugin-nostr/lib'),
          'syntropy-core': path.resolve(PIXEL_ROOT, 'syntropy-core/src'),
          'lnpixels-api': path.resolve(PIXEL_ROOT, 'lnpixels/api/src'),
          'all': PIXEL_ROOT
        };

        const scanPath = targetPaths[target];

        // File size analysis
        if (focusArea === 'file-size' || focusArea === 'all') {
          try {
            const { stdout } = await execAsync(
              `find ${scanPath} -name "*.js" -o -name "*.ts" | xargs wc -l 2>/dev/null | sort -rn | head -10`,
              { timeout: 30000 }
            );

            const lines = stdout.trim().split('\n');
            for (const line of lines) {
              const match = line.trim().match(/^(\d+)\s+(.+)$/);
              if (match && parseInt(match[1]) > 500 && !match[2].includes('node_modules') && !match[2].includes('total')) {
                const lineCount = parseInt(match[1]);
                const filePath = match[2];
                const fileName = path.basename(filePath);

                suggestions.push({
                  file: filePath.replace(PIXEL_ROOT, ''),
                  issue: `Large file: ${lineCount} lines`,
                  suggestion: `Split ${fileName} into smaller focused modules`,
                  effort: lineCount > 2000 ? '2-4 hours' : lineCount > 1000 ? '1-2 hours' : '30-60 min',
                  priority: lineCount > 2000 ? 'High' : lineCount > 1000 ? 'Medium' : 'Low'
                });
              }
            }
          } catch (e) {
            // File analysis failed, continue
          }
        }

        // Test coverage analysis
        if (focusArea === 'test-coverage' || focusArea === 'all') {
          try {
            // Find source files without corresponding test files
            const { stdout: srcFiles } = await execAsync(
              `find ${scanPath} -name "*.ts" -o -name "*.js" | grep -v node_modules | grep -v test | grep -v ".test." | head -20`,
              { timeout: 15000 }
            );

            for (const srcFile of srcFiles.trim().split('\n').filter(Boolean)) {
              const baseName = path.basename(srcFile).replace(/\.(ts|js)$/, '');
              const testDir = path.dirname(srcFile).replace('/src', '/test');
              const testFile1 = path.join(testDir, `${baseName}.test.js`);
              const testFile2 = path.join(testDir, `${baseName}.test.ts`);

              if (!fs.existsSync(testFile1) && !fs.existsSync(testFile2)) {
                suggestions.push({
                  file: srcFile.replace(PIXEL_ROOT, ''),
                  issue: 'No test file found',
                  suggestion: `Create test file for ${baseName}`,
                  effort: '30-60 min',
                  priority: 'Medium'
                });
              }
            }
          } catch (e) {
            // Test analysis failed, continue
          }
        }

        await logAudit({
          type: 'refactoring_analysis',
          target,
          focusArea,
          suggestionsCount: suggestions.length
        });

        return {
          target,
          focusArea,
          suggestionsCount: suggestions.length,
          suggestions: suggestions.slice(0, 10), // Limit to top 10
          nextStep: suggestions.length > 0
            ? "Review suggestions and use 'addRefactorTask' to add worthy items to the queue"
            : "No obvious refactoring opportunities found in this area"
        };
      } catch (error: any) {
        return { error: error.message };
      }
    }
  }),

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

        // Format as JSON using PostgreSQL
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

      // Enforce context reading requirement
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

        // Sync to markdown for knowledge vectorization
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

  // Worker Architecture Tools (Brain/Hands pattern)
  ...workerTools
};
