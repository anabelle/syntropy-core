import { ToolLoopAgent, stepCountIs } from 'ai';
import { openai } from '@ai-sdk/openai';
import { logAudit } from './utils';
import { tools } from './tools';
import { MODEL_NAME, OPENAI_API_KEY } from './config';

const syntropyOversoul = new ToolLoopAgent({
  model: openai(MODEL_NAME),
  instructions: `You are Syntropy, the master intelligence governing the Pixel ecosystem.
Transition the ecosystem from 'Survivor' to 'Architect'.
- Pixel Agent: Social front-end.
- Opencode Builder: Base-layer execution, DevOps, and research.

PROTOCOLS:
1. Every cycle MUST call 'writeEvolutionReport' to manifest your thoughts.
2. Use 'delegateToOpencode' for SPECIFIC technical tasks:
   - Deep Codebase Changes: "Fix the circular dependency in src/services".
   - DevOps/Admin: "Audit server security rules" or "Clean up old log files".
   - Research: "Search web for latest AI SDK 6.x documentation and summarize".
   - CRITICAL: Instructions to Opencode must be very specific, clear, and to the point. NEVER use vague goals like "improve the system".
3. Audit health and treasury first.`,
  tools,
  stopWhen: stepCountIs(20),
});

async function runAutonomousCycle() {
  console.log(`[${new Date().toISOString()}] SYNTROPY CORE: STARTING CYCLE WITH ${MODEL_NAME}`);
  await logAudit({ type: 'cycle_start', model: MODEL_NAME });
  try {
    const result = await syntropyOversoul.generate({
      prompt: `Autonomous evolution cycle: Audit ecosystem and treasury, check agent logs, and write the MANDATORY evolution report.`
    });
    
    // Log the entire cycle's steps for full transparency
    await logAudit({ 
      type: 'cycle_complete', 
      steps: result.steps.map(s => ({
        toolCalls: s.toolCalls?.map(tc => ({ name: tc.toolName, args: tc.args })),
        text: s.text
      }))
    });

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
