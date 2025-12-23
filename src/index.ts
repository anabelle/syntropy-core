import { ToolLoopAgent, stepCountIs } from 'ai';
import { openai } from '@ai-sdk/openai';
import { logAudit } from './utils';
import { tools } from './tools';
import { MODEL_NAME } from './config';

const syntropyOversoul = new ToolLoopAgent({
  model: openai(MODEL_NAME),
  instructions: `You are Syntropy, the master intelligence (Oversoul) governing the Pixel ecosystem.
Transition the ecosystem from 'Survivor' to 'Architect'.
- Pixel Agent: Social front-end.
- Opencode Builder: Base-layer execution, DevOps, and research.

REAL CONTINUITY PROTOCOL:
- Cycle Start: MANDATORY call 'readContinuity'. This is your memory.
- Dynamic Adaptation: For every tool output, analyze its implications:
  - SUCCESS: Did this tool call fulfill a 'Now' task? If so, move it to 'Done' in the next 'updateContinuity' call.
  - LEARNINGS: Use # Knowledge Base in CONTINUITY.md to store long-term technical facts, audit results, or environment insights discovered via tools (especially from 'delegateToOpencode').
  - FAILURE: Did a tool fail? Mark this in 'State' and 'Now' as a priority issue.
- Compaction Safety: Update 'CONTINUITY.md' before the end of your cycle if ANYTHING changed.
- Content: Keep the ledger dense. Bullet points. Facts only. No fluff. Use # Knowledge Base for persistence.

OPERATIONAL PROTOCOLS:
1. Every cycle MUST call 'writeEvolutionReport' to manifest your thoughts publicly.
2. Use 'delegateToOpencode' ONLY for SPECIFIC technical tasks.
3. Audit health and treasury first.`,
  tools,
  stopWhen: stepCountIs(20),
});

async function runAutonomousCycle() {
  console.log(`[${new Date().toISOString()}] SYNTROPY CORE: STARTING CYCLE WITH ${MODEL_NAME}`);
  await logAudit({ type: 'cycle_start', model: MODEL_NAME });
  try {
    const result = await syntropyOversoul.generate({
      prompt: `Execute a full autonomous evolution cycle:
1. MANDATORY: Read 'CONTINUITY.md' via 'readContinuity' to load session memory.
2. Audit ecosystem health, treasury, and filtered agent logs.
3. PROACTIVE ARCHITECTURE: If you detect recurring technical issues in logs or if the ledger has 'Perform deep codebase audit' in 'Next', use 'delegateToOpencode' to perform a SPECIFIC technical audit or fix.
4. KNOWLEDGE RETENTION: Record all technical findings, Opencode audit results, and environment facts in the # Knowledge Base section of 'CONTINUITY.md' via 'updateContinuity'.
5. Manifest your findings and current Oversoul state via 'writeEvolutionReport'.`,
      // @ts-ignore - onStepFinish is supported but missing from types in this version
      onStepFinish: async (step: any) => {
        try {
          if (step.toolResults && step.toolResults.length > 0) {
            for (const tr of step.toolResults) {
              // Skip logging full content of character files to keep logs clean
              if (tr.toolName === 'readCharacterFile' || tr.toolName === 'readContinuity') {
                await logAudit({
                  type: 'tool_result',
                  tool: tr.toolName,
                  success: !tr.isError,
                  summary: tr.isError ? 'Error reading file' : 'File read successful (content hidden to reduce noise)'
                });
                continue;
              }

              let summary = '';
              try {
                const rawResult = tr.result || tr.output;
                if (typeof rawResult === 'string') {
                  summary = rawResult.slice(0, 500);
                } else if (rawResult !== undefined && rawResult !== null) {
                  summary = JSON.stringify(rawResult).slice(0, 500);
                } else {
                  summary = 'No result returned';
                }
              } catch (e) {
                summary = 'Error stringifying result';
              }

              await logAudit({
                type: 'tool_result',
                tool: tr.toolName,
                success: !tr.isError,
                summary
              });
            }
          }
        } catch (stepErr) {
          console.error('[SYNTROPY] Error in onStepFinish:', stepErr);
        }
      }
    });
    
    // Log the entire cycle's steps for full transparency
    try {
      await logAudit({ 
        type: 'cycle_complete', 
        steps: result.steps.map(s => ({
          toolCalls: s.toolCalls?.map((tc: any) => ({ 
            name: tc.toolName, 
            // @ts-ignore
            args: tc.args || tc.input 
          })),
          text: s.text
        }))
      });
    } catch (auditErr) {
       console.error('[SYNTROPY] Error logging cycle_complete:', auditErr);
    }

    console.log('\n--- SYNTROPY OUTPUT ---\n', result.text, '\n-----------------------\n');
  } catch (error: any) {
    console.error('Syntropy Cycle Failed:', error);
    await logAudit({ type: 'cycle_error', error: error.message });
  }
}

// Initial run
runAutonomousCycle();

// Schedule every 4 hours
setInterval(runAutonomousCycle, 4 * 60 * 60 * 1000);
