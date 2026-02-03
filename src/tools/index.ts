export { continuityTools } from './continuity';
export { ecosystemTools } from './ecosystem';
export { nostrTools } from './nostr';
export { memoryTools } from './memory';
export { characterTools } from './character';
export { utilityTools } from './utility';
export { refactoringTools } from './refactoring';
export { diaryTools } from './diary';
export { researchTools } from './research';
export { ideationTools } from './ideation';
export { baseTools } from './base';

import { continuityTools } from './continuity';
import { ecosystemTools } from './ecosystem';
import { nostrTools } from './nostr';
import { memoryTools } from './memory';
import { characterTools } from './character';
import { utilityTools } from './utility';
import { refactoringTools } from './refactoring';
import { diaryTools } from './diary';
import { researchTools } from './research';
import { ideationTools } from './ideation';
import { baseTools } from './base';

export const allTools = {
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
  ...baseTools
};
