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
import { workerTools } from './tools/worker';
import { selfExaminationTools } from './self-examination';
import { clawstrTools } from './tools/clawstr';

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
  ...workerTools,
  ...selfExaminationTools,
  ...clawstrTools
};
