/**
 * Worker Spawn Tests
 * 
 * Regression tests for the spawnWorkerInternal function.
 * These tests ensure critical code ordering issues don't regress.
 */
import { describe, it, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

describe('Worker Spawn Regression Tests', () => {
    // Regression test for the TDZ bug fixed on 2026-01-08
    // Bug: containerName was used in recordWorkerEvent before being declared
    // Error: "Cannot access 'containerName' before initialization"
    it('should declare containerName before using it in recordWorkerEvent', () => {
        const workerCorePath = path.join(__dirname, '../worker-core.ts');
        const source = fs.readFileSync(workerCorePath, 'utf-8');

        // Find the line numbers where containerName is declared and where recordWorkerEvent uses it
        const lines = source.split('\n');
        let declarationLine = -1;
        let usageInRecordLine = -1;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Look for containerName declaration in spawnWorkerInternal context
            if (line.includes('const containerName = `pixel-worker-${taskId.slice')) {
                declarationLine = i;
            }

            // Look for first usage in recordWorkerEvent - it's passed as a property
            // This checks for the pattern: await recordWorkerEvent({ ... containerName, ...
            if (line.includes('recordWorkerEvent({') ||
                (usageInRecordLine === -1 && declarationLine === -1 && line.includes('containerName,'))) {
                // Mark the usage line if containerName appears in the recordWorkerEvent call block
                for (let j = i; j < Math.min(i + 10, lines.length); j++) {
                    if (lines[j].includes('containerName,')) {
                        usageInRecordLine = j;
                        break;
                    }
                }
            }
        }

        // Verify declaration exists
        expect(declarationLine).toBeGreaterThan(-1);

        // Verify usage exists  
        expect(usageInRecordLine).toBeGreaterThan(-1);

        // THE CRITICAL ASSERTION: Declaration must come BEFORE usage
        // This prevents the TDZ (Temporal Dead Zone) error that was causing spawn failures
        expect(declarationLine).toBeLessThan(usageInRecordLine);
    });

    it('should have spawnWorkerInternal as an exported async function', async () => {
        const WorkerCore = await import('../worker-core.ts');
        expect(typeof WorkerCore.spawnWorkerInternal).toBe('function');
    });
});
