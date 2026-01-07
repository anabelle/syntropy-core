import { continuityTools } from './tools/continuity';
import { ecosystemTools } from './tools/ecosystem';
import { nostrTools } from './tools/nostr';
import { memoryTools } from './tools/memory';
import { characterTools } from './tools/character';
import { utilityTools } from './tools/utility';
import { refactoringTools } from './tools/refactoring';
import { diaryTools } from './tools/diary';
import { researchTools } from './tools/research';
import { ideationTools } from './tools/ideation';
import { workerTools } from './worker-core';

export const tools = {
  ...continuityTools,
  ...ecosystemTools,
  ...nostrTools,
  ...memoryTools,
  ...characterTools,
  ...utilityTools,
  ...refactoringTools,
  ...diaryTools,
  ...researchTools,
  ...ideationTools,
  ...workerTools
};
