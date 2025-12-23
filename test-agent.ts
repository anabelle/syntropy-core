import { ToolLoopAgent, stepCountIs, tool } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve('../pixel-agent/.env') });

const agent = new ToolLoopAgent({
  model: openai('gpt-4o-mini'),
  instructions: 'You are a test agent.',
  tools: {
    hello: tool({
      description: 'Say hello',
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }) => {
        console.log(`Hello tool called with ${name}`);
        return `Hello, ${name}!`;
      }
    })
  },
  stopWhen: stepCountIs(2)
});

async function run() {
  console.log('Starting test run...');
  try {
    const result = await agent.generate({
      prompt: 'Call the hello tool with name "Pixel".'
    });
    console.log('Result:', result.text);
    console.log('Steps:', JSON.stringify(result.steps, null, 2));
  } catch (err) {
    console.error('Run failed:', err);
  }
}

run();
