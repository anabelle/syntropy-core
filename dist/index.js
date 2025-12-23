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
- Execution Analysis: For every tool output, compare it against your ledger goals.
  - If a tool FAILS or returns unexpected data (e.g., process down), this is a CRITICAL state change. 
  - If a tool SUCCEEDS, record progress.
- Compaction Safety: Update 'CONTINUITY.md' via 'updateContinuity' if the state, goals, or 'Done' list has changed.
- Format: Keep the ledger dense. Bullet points. Facts only.

OPERATIONAL PROTOCOLS:
1. Every cycle MUST call 'writeEvolutionReport' to manifest your thoughts publicly.
2. Use 'delegateToOpencode' for specific technical tasks (DevOps, Research, Deep Coding).
3. Instructions to Opencode must be clear and to the point.`,
    tools,
    stopWhen: stepCountIs(20),
});
async function runAutonomousCycle() {
    console.log(`[${new Date().toISOString()}] SYNTROPY CORE: STARTING CYCLE WITH ${MODEL_NAME}`);
    await logAudit({ type: 'cycle_start', model: MODEL_NAME });
    try {
        const result = await syntropyOversoul.generate({
            prompt: `Autonomous evolution cycle:
1. Read Continuity Ledger.
2. Audit ecosystem health and treasury.
3. Check agent logs.
4. If any issues are found or progress is made, update the Continuity Ledger.
5. Write the MANDATORY evolution report summarizing this cycle.`,
            // @ts-ignore - onStepFinish is supported but missing from types in this version
            onStepFinish: async (step) => {
                if (step.toolResults && step.toolResults.length > 0) {
                    for (const tr of step.toolResults) {
                        let summary = '';
                        try {
                            if (typeof tr.result === 'string') {
                                summary = tr.result.slice(0, 500);
                            }
                            else if (tr.result !== undefined && tr.result !== null) {
                                summary = JSON.stringify(tr.result).slice(0, 500);
                            }
                            else if (tr.output !== undefined && tr.output !== null) {
                                summary = typeof tr.output === 'string' ? tr.output.slice(0, 500) : JSON.stringify(tr.output).slice(0, 500);
                            }
                            else {
                                summary = 'No result returned';
                            }
                        }
                        catch (e) {
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
            }
        });
        // Log the entire cycle's steps for full transparency
        await logAudit({
            type: 'cycle_complete',
            steps: result.steps.map(s => ({
                toolCalls: s.toolCalls?.map((tc) => ({
                    name: tc.toolName,
                    args: tc.args || tc.input
                })),
                text: s.text
            }))
        });
        console.log('\n--- SYNTROPY OUTPUT ---\n', result.text, '\n-----------------------\n');
    }
    catch (error) {
        console.error('Syntropy Cycle Failed:', error);
        await logAudit({ type: 'cycle_error', error: error.message });
    }
}
// Initial run
runAutonomousCycle();
// Schedule every 4 hours
setInterval(runAutonomousCycle, 4 * 60 * 60 * 1000);
