import { tool } from 'ai';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs-extra';
import * as path from 'path';
import {
  PIXEL_ROOT,
  LOG_PATH
} from '../config';
import { logAudit } from '../utils';

const execAsync = promisify(exec);

export const ecosystemTools = {
  getEcosystemStatus: tool({
    description: 'Get status of all containers in the ecosystem via Docker',
    inputSchema: z.object({
      confirm: z.boolean().describe('Set to true to perform ecosystem audit')
    }),
    execute: async () => {
      console.log('[SYNTROPY] Tool: getEcosystemStatus (Docker)');
      try {
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

  readAgentLogs: tool({
    description: 'Read recent logs from the Pixel agent. Automatically filters noise for Syntropy intelligence.',
    inputSchema: z.object({
      lines: z.number().describe('Number of lines to read (e.g. 100)')
    }),
    execute: async ({ lines }) => {
      console.log(`[SYNTROPY] Tool: readAgentLogs (${lines} lines)`);
      try {
        if (fs.existsSync(LOG_PATH)) {
          const { stdout: rawLogs } = await execAsync(`tail -n ${lines * 5} ${LOG_PATH}`, { timeout: 10000 });
          const logLines = rawLogs.toString().split('\n');

          const filteredLines = logLines.filter(line => {
            const lowerLine = line.toLowerCase();

            if (line.includes('[REFLECTION]') ||
              line.includes('[LORE]') ||
              line.includes('[ZAP]') ||
              line.includes('[DM]') ||
              line.includes('[NOSTR] Replied to') ||
              line.includes('[NOSTR] Reacted to')) {
              return true;
            }

            if (lowerLine.includes('too many concurrent reqs')) return false;
            if (lowerLine.includes('drizzleadapter creatememory')) return false;
            if (lowerLine.includes('creating memory id=')) return false;
            if (lowerLine.includes('connection healthy, last event received')) return false;
            if (lowerLine.includes('stats:') && lowerLine.includes('calls saved')) return false;
            if (lowerLine.includes('invalid iv length')) return false;
            if (lowerLine.includes('skipping old mention')) return false;
            if (lowerLine.includes('event kind 1 from')) return false;

            if (lowerLine.includes('debug')) return false;
            if (lowerLine.includes('notice from')) return false;
            if (lowerLine.includes('bad req:')) return false;
            if (lowerLine.includes('discovery skipping muted user')) return false;
            if (lowerLine.includes('timeline lore processing deferred')) return false;
            if (lowerLine.includes('llm generation attempt') && lowerLine.includes('failed')) return false;
            if (lowerLine.includes('all llm generation retries failed')) return false;
            if (lowerLine.includes('round') && lowerLine.includes('metrics:')) return false;
            if (lowerLine.includes('adaptive threshold activated')) return false;
            if (lowerLine.includes('continuing to round')) return false;
            if (lowerLine.includes('discovery round')) return false;
            if (lowerLine.includes('round topics (fallback):')) return false;
            if (lowerLine.includes('expanded search params:')) return false;
            if (lowerLine.includes('discovery "') && lowerLine.includes('": relevant')) return false;
            if (lowerLine.includes('generating text with')) return false;
            if (/\b[0-9a-f]{8}\b/.test(line)) return false;

            if (line.trim().startsWith('{') || line.trim().startsWith('[')) {
              if (line.length > 500) return false;
            }

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

        const metricTime = new Date(metrics.timestamp).getTime();
        const ageSeconds = (Date.now() - metricTime) / 1000;
        const ageMinutes = ageSeconds / 60;
        const isStale = ageMinutes > 2;

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

        const t = {
          diskPercent: thresholds?.diskPercent ?? 85,
          memoryPercent: thresholds?.memoryPercent ?? 90,
          swapPercent: thresholds?.swapPercent ?? 50,
          loadPerCore: thresholds?.loadPerCore ?? 1.5
        };

        const alerts: string[] = [];
        const recommendations: string[] = [];

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

        const memPercent = metrics.memory.usagePercent;
        if (memPercent > t.memoryPercent) {
          alerts.push(`🚨 MEMORY CRITICAL: ${memPercent.toFixed(1)}% used (threshold: ${t.memoryPercent}%)`);
          recommendations.push('Check container memory with containerStats below');
          recommendations.push('Consider restarting memory-hungry containers');
          recommendations.push('Check for memory leaks in agent logs');
        } else if (memPercent > t.memoryPercent - 10) {
          alerts.push(`⚠️  MEMORY WARNING: ${memPercent.toFixed(1)}% used (approaching ${t.memoryPercent}% threshold)`);
        }

        const swapPercent = metrics.swap.usagePercent;
        if (swapPercent > t.swapPercent) {
          alerts.push(`⚠️  SWAP IN USE: ${swapPercent.toFixed(1)}% (threshold: ${t.swapPercent}%)`);
          recommendations.push('System is swapping - performance may be degraded');
          recommendations.push('Consider increasing RAM or reducing container memory limits');
        }

        const loadPerCore = metrics.cpu.loadPerCore1min;
        const load1 = metrics.cpu.loadAvg1min;
        if (loadPerCore > t.loadPerCore) {
          alerts.push(`⚠️  HIGH LOAD: ${load1.toFixed(2)} (${loadPerCore.toFixed(2)} per core, threshold: ${t.loadPerCore})`);
          recommendations.push('Check for runaway processes or container issues');
          recommendations.push('Review containerStats below for CPU hogs');
        }

        const formatBytes = (bytes: number): string => {
          if (bytes === 0) return '0 B';
          if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
          if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
          if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
          if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
          return `${bytes} B`;
        };

        const formatKb = (kb: number): string => formatBytes(kb * 1024);

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
            const aNum = parseFloat(a.memPercent) || 0;
            const bNum = parseFloat(b.memPercent) || 0;
            return bNum - aNum;
          });

        const hasCritical = alerts.some(a => a.includes('CRITICAL'));
        const hasWarning = alerts.some(a => a.includes('WARNING') || a.includes('⚠️'));
        const status = hasCritical ? 'CRITICAL' : hasWarning ? 'WARNING' : 'HEALTHY';

        const result = {
          status,
          timestamp: metrics.timestamp,
          hostname: metrics.hostname,
          stale: false,
          ageSeconds: Math.round(ageSeconds),

          summary: {
            cpu: `Load: ${load1.toFixed(2)} / ${metrics.cpu.loadAvg5min.toFixed(2)} / ${metrics.cpu.loadAvg15min.toFixed(2)} (1/5/15 min avg, ${metrics.cpu.cores} cores)`,
            memory: `${formatKb(metrics.memory.usedKb)} / ${formatKb(metrics.memory.totalKb)} (${memPercent.toFixed(1)}% used)`,
            swap: swapPercent > 0
              ? `${formatKb(metrics.swap.usedKb)} / ${formatKb(metrics.swap.totalKb)} (${swapPercent.toFixed(1)}% used)`
              : 'Not in use',
            disk: `${formatBytes(metrics.disk.usedBytes)} / ${formatBytes(metrics.disk.totalBytes)} (${diskPercent.toFixed(1)}% used, ${formatBytes(metrics.disk.availableBytes)} free)`,
            uptime: `${metrics.uptime.days}d ${metrics.uptime.hours % 24}h`
          },

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

          containerStats: containerSummary,
          containerCount: containerSummary.length,

          alerts: alerts.length > 0 ? alerts : ['✅ All systems nominal'],
          recommendations,
          actionRequired: alerts.length > 0,

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
  })
};
