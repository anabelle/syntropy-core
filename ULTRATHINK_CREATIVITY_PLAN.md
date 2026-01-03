# Ultrathink: The Idea Garden Protocol (v3)

> **Status**: ✅ IMPLEMENTED (2026-01-03)
> **Based on**: Real database schema, real tools.ts, real agent behavior

---

## Part 0: CRITICAL CAPABILITIES DISCOVERED

### Opencode Has Web Search (via Workers!)

From `docs/OPENCODE_SPEC.md`, workers running Opencode have access to:

```typescript
// Built-in tools available to Opencode agents:
{
  "tools": {
    "webfetch": true,   // <-- CAN FETCH URLs!
    "bash": true,
    "edit": true,
    "grep": true,
    "glob": true,
    "task": true        // <-- Can spawn sub-agents!
  }
}
```

**This means**: When Syntropy spawns a worker, that worker can:
1. **Search the web** via `webfetch` tool
2. **Research competitors** 
3. **Read documentation**
4. **Fetch arXiv papers**

**For brainstorming**: Syntropy can spawn a "research worker" to gather external input!

```
spawnWorker({
  task: "Research autonomous AI agent architectures. Summarize 3 interesting approaches.",
  context: "For Idea Garden seed: 'Improve Syntropy decision-making'"
})
```

### lnpixels Treasury Database (SQLite)

From `lnpixels/api/src/database.ts`:

```sql
-- pixels table
CREATE TABLE pixels (
  x INTEGER, y INTEGER, 
  color TEXT, letter TEXT,
  sats INTEGER,           -- <-- Revenue per pixel!
  created_at INTEGER
);

-- activity table  
CREATE TABLE activity (
  x INTEGER, y INTEGER,
  sats INTEGER,
  payment_hash TEXT,
  type TEXT DEFAULT 'purchase'
);
```

**Syntropy already has `checkTreasury` which reads this!**

But for brainstorming, we could ask:
- "What times of day get most purchases?" (activity patterns)
- "Which colors are most popular?" (user preferences)
- "What's the average sats per transaction trend?" (pricing insights)

### The Pixel Canvas App (lnpixels-app)

The `lnpixels-app/` is a full React frontend at 91 children. This is the user-facing product.

**For brainstorming**: Ideas about the canvas could come from:
- Looking at actual usage patterns
- Checking which features exist vs. what's missing
- Comparing to competitors (via webfetch)

---

## Part 1: Reality Check — What Actually Exists

### Database Schema (PostgreSQL `pixel_agent`)

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `memories` | Pixel's experiences (214 total) | `type`, `content` (JSONB), `created_at` |
| `diary_entries` | Reflections (Syntropy writes here) | `author`, `content`, `tags[]`, `created_at` |
| `entities` | Known users/entities | |
| `rooms` | Conversation contexts | |

**Memory Content Types** (from real data):
```
emerging_story     | 112  <- Pixel tracks trending topics
daily_report       |  21  <- Daily summaries
social_interaction |   9  <- Individual conversations
hourly_digest      |   9  <- Hourly activity
narrative_timeline |   7  <- Lore entries
```

**Diary Entries** (from real Syntropy writes):
```
"Cycle #15: The Reversal - 92.5% → 82.1%"
"Cycle #14: The Acceleration Beneath Pressure"  
"Cycle #13: Tempered Steel"
"Milestone: 56% Refactor Complete"
```

### Existing Tools (tools.ts + worker-tools.ts)

| Tool | What It Does | Returns |
|------|--------------|---------|
| `readContinuity` | Load operational state | Markdown |
| `updateContinuity` | Write operational state | `{success}` |
| `readPixelMemories` | Query PostgreSQL memories | `{memories[]}` |
| `getPixelStats` | Memory counts by type | `{byType, detailed}` |
| `readDiary` | Read diary entries | `{entries[]}` |
| `writeDiary` | Write new diary entry (requires readDiary first!) | `{success, id}` |
| `writeEvolutionReport` | Public narrative (lands on website) | `{success}` |
| `postToNostr` | Announce via Pixel bridge | `{success}` |
| `spawnWorker` | Delegate coding task to ephemeral container | `{taskId}` |
| `analyzeForRefactoring` | Find large files, missing tests | `{suggestions[]}` |
| `notifyHuman` | Write to NOTIFICATIONS.md | `{success}` |

### What Syntropy Writes TO (Real Files)

```
/pixel/syntropy-core/CONTINUITY.md    <- Operational state
/pixel/audit/syntropy.json            <- Latest evolution report (website reads this)
/pixel/audit/evolution/*.md           <- Historical evolution reports
/pixel/NOTIFICATIONS.md               <- Human alerts
/pixel/data/task-ledger.json          <- Worker task tracking
PostgreSQL diary_entries              <- Reflections
```

---

## Part 2: The Gap Analysis

### What Syntropy CAN Do Now
- ✅ React to crises (swap, disk, errors)
- ✅ Process queued tasks (REFACTOR_QUEUE.md)
- ✅ Write operational ledger (CONTINUITY.md)
- ✅ Write reflections (diary_entries)
- ✅ Write public narratives (evolution reports)
- ✅ Spawn workers for coding tasks

### What Syntropy CANNOT Do Now
- ❌ Generate novel ideas that aren't in a queue
- ❌ Track half-formed thoughts across cycles
- ❌ Collaborate with human on incubating concepts
- ❌ Have ideas "mature" over time before becoming tasks

### Current Pattern
```
[Queue] → Syntropy processes → [Done]
```

### Desired Pattern
```
[Observation] → Seeds IDEAS.md → [Human/Syntropy waters] → Matures → [Queue] → Done
```

---

## Part 3: The Idea Garden Implementation

### Option A: Use Existing `diary_entries` Table

We already have a tagging system! Syntropy could:
1. Write ideas as diary entries with tag `idea-seed`
2. Water = add new entry with tag `idea-watering` + reference
3. Harvest = add to CONTINUITY.md pending tasks

**Pros**: No new tables, already has `readDiary`/`writeDiary`
**Cons**: Diary is for reflections, mixing purposes; no watering count

### Option B: New `IDEAS.md` File (Recommended)

Simpler, more transparent, human-editable.

**File**: `/pixel/syntropy-core/IDEAS.md`

```markdown
# 🌱 Idea Garden

> Persistent workspace for incubating ideas. Both Human and Syntropy can edit.

## 🌱 Seeds

### Give Syntropy its own Nostr identity
- **Planted**: 2026-01-03 by Human
- **Origin**: Currently posts through Pixel bridge. Could speak directly as "Oversoul".
- **Waterings**: 1
- **Log**:
  - [2026-01-03 Human] I can provide an nsec. Voice should be philosophical, meta.

## 🌿 Sprouting (3+ waterings)

## 🌸 Ready to Harvest (5+ waterings)

## 🍂 Compost
```

### New Tool: `tendIdeaGarden`

```typescript
tendIdeaGarden: tool({
  description: `Tend the Idea Garden. Use at the END of each cycle.

Actions:
- 'read': View all seeds with their watering counts
- 'plant': Add new seed from this cycle's observations
- 'water': Add thought to existing seed (increments count)
- 'harvest': Move seed with 5+ waterings to CONTINUITY.md pending tasks
- 'compost': Archive stale/failed idea

Rules:
- Water ONE seed per cycle
- Plant at most ONE new seed per cycle  
- Harvest requires 5+ waterings AND clear implementation path`,

  inputSchema: z.object({
    action: z.enum(['read', 'plant', 'water', 'harvest', 'compost']),
    seedTitle: z.string().optional(),
    content: z.string().optional(),
    author: z.enum(['Syntropy', 'Human']).default('Syntropy')
  }),

  execute: async ({ action, seedTitle, content, author }) => {
    const IDEAS_PATH = path.join(PIXEL_ROOT, 'syntropy-core/IDEAS.md');
    
    // 1. Read current garden
    let garden = '';
    if (await fs.pathExists(IDEAS_PATH)) {
      garden = await fs.readFile(IDEAS_PATH, 'utf-8');
    } else {
      // Initialize empty garden
      garden = `# 🌱 Idea Garden\n\n> Persistent workspace for incubating ideas.\n\n## 🌱 Seeds\n\n## 🌿 Sprouting (3+ waterings)\n\n## 🌸 Ready to Harvest (5+ waterings)\n\n## 🍂 Compost\n`;
    }

    // 2. Parse sections
    const sections = {
      seeds: garden.match(/## 🌱 Seeds\n([\s\S]*?)(?=## 🌿|$)/)?.[1] || '',
      sprouting: garden.match(/## 🌿 Sprouting.*?\n([\s\S]*?)(?=## 🌸|$)/)?.[1] || '',
      harvest: garden.match(/## 🌸 Ready to Harvest.*?\n([\s\S]*?)(?=## 🍂|$)/)?.[1] || '',
      compost: garden.match(/## 🍂 Compost\n([\s\S]*?)$/)?.[1] || ''
    };

    // 3. Execute action
    if (action === 'read') {
      // Count seeds and waterings
      const seedPattern = /### (.+)\n[\s\S]*?- \*\*Waterings\*\*: (\d+)/g;
      const seeds = [];
      let match;
      while ((match = seedPattern.exec(garden)) !== null) {
        seeds.push({ title: match[1], waterings: parseInt(match[2]) });
      }
      return { seeds, total: seeds.length };
    }

    if (action === 'plant') {
      const timestamp = new Date().toISOString().split('T')[0];
      const newSeed = `\n### ${seedTitle}\n- **Planted**: ${timestamp} by ${author}\n- **Origin**: ${content}\n- **Waterings**: 0\n- **Log**:\n`;
      sections.seeds += newSeed;
    }

    if (action === 'water') {
      // Find seed, increment watering, add log entry
      const seedRegex = new RegExp(`### ${seedTitle}\\n([\\s\\S]*?)(?=### |## |$)`);
      const seedMatch = garden.match(seedRegex);
      if (!seedMatch) return { error: `Seed "${seedTitle}" not found` };
      
      let seedContent = seedMatch[1];
      const wateringMatch = seedContent.match(/- \*\*Waterings\*\*: (\d+)/);
      const currentCount = wateringMatch ? parseInt(wateringMatch[1]) : 0;
      const newCount = currentCount + 1;
      
      seedContent = seedContent.replace(
        /- \*\*Waterings\*\*: \d+/,
        `- **Waterings**: ${newCount}`
      );
      
      const timestamp = new Date().toISOString().split('T')[0];
      seedContent = seedContent.replace(
        /- \*\*Log\*\*:\n/,
        `- **Log**:\n  - [${timestamp} ${author}] ${content}\n`
      );
      
      garden = garden.replace(seedMatch[0], `### ${seedTitle}\n${seedContent}`);
      
      // Move to sprouting if 3+ waterings
      if (newCount >= 3 && newCount < 5) {
        // Move logic here
      }
      
      await fs.writeFile(IDEAS_PATH, garden);
      return { success: true, seedTitle, newCount };
    }

    // ... harvest and compost logic

    // 4. Rebuild and write garden
    const newGarden = `# 🌱 Idea Garden

> Persistent workspace for incubating ideas.

## 🌱 Seeds
${sections.seeds}
## 🌿 Sprouting (3+ waterings)
${sections.sprouting}
## 🌸 Ready to Harvest (5+ waterings)
${sections.harvest}
## 🍂 Compost
${sections.compost}`;

    await fs.writeFile(IDEAS_PATH, newGarden);
    await logAudit({ type: 'idea_garden', action, seedTitle, author });
    
    return { success: true, action, seedTitle };
  }
})
```

---

## Part 4: Simulation with REAL Data

### Cycle 17 — Syntropy notices something in real logs

During Phase 2, Syntropy reads agent logs and sees:
```
[NOSTR] Home feed analysis result for 46710f92: YES - "sharp observation about business pragmatism vs. ideology"
[NOSTR] Home feed processing complete: 0 interactions
```

**Syntropy's observation**: "8 posts analyzed as YES, but 0 interactions queued. Why?"

At Phase 7 (new), Syntropy calls:
```
tendIdeaGarden({ action: 'plant', seedTitle: 'Improve home feed queue visibility', content: 'Logs say 0 interactions but 8 were analyzed YES. Confusing.' })
```

**IDEAS.md now has**:
```markdown
### Improve home feed queue visibility
- **Planted**: 2026-01-03 by Syntropy
- **Origin**: Logs say 0 interactions but 8 were analyzed YES. Confusing.
- **Waterings**: 0
- **Log**:
```

---

### Cycle 18 — Human notices and waters

You open IDEAS.md and add manually:

```markdown
### Improve home feed queue visibility
- **Waterings**: 1
- **Log**:
  - [2026-01-03 Human] Check pixel-agent queue logic. The "0 interactions" might mean "0 new" because of dedup. The log format is confusing.
```

---

### Cycle 19 — Syntropy reads, finds human input, waters back

Syntropy calls `tendIdeaGarden({ action: 'read' })` and sees the human watered.

Then calls:
```
tendIdeaGarden({ 
  action: 'water', 
  seedTitle: 'Improve home feed queue visibility', 
  content: 'Found it: [QUEUE] uses natural spacing delay (313s). The 0 is misleading. Should say "8 queued for delayed posting".' 
})
```

**Waterings**: 2

---

### Cycle 20 — Syntropy proposes implementation

```
tendIdeaGarden({ 
  action: 'water', 
  seedTitle: 'Improve home feed queue visibility', 
  content: 'IMPLEMENTATION: In pixel-agent/plugin-nostr/lib/homeFeed.ts, change log from "0 interactions" to "${analyzed} analyzed, ${queued} queued for delayed posting".' 
})
```

**Waterings**: 3 → Moves to 🌿 Sprouting

---

### Cycle 21 — Human confirms

```markdown
- [2026-01-03 Human] Good analysis. Add to refactor queue as T025.
```

**Waterings**: 4

---

### Cycle 22 — Syntropy harvests

```
tendIdeaGarden({ action: 'harvest', seedTitle: 'Improve home feed queue visibility' })
```

This:
1. Adds task to CONTINUITY.md pending tasks
2. Moves seed to 🌸 Ready to Harvest (archived)
3. Optionally adds to REFACTOR_QUEUE.md via `addRefactorTask`

---

## Part 5: Research Workers (The External Brain)

Syntropy can spawn workers that use Opencode's `webfetch` tool to research external sources.

### Research Worker Pattern

When an Idea Garden seed needs external input:

```typescript
// Syntropy spawns research worker
spawnWorker({
  task: `RESEARCH TASK for Idea Garden seed: "${seedTitle}"
  
Research the topic: ${content}

Use the webfetch tool to:
1. Find 3 relevant articles/papers
2. Summarize key insights
3. Suggest implementation approaches

Write findings to /pixel/data/research-${seedTitle.replace(/\s+/g, '-')}.md

Format:
## Research: ${seedTitle}
### Sources
- [Source 1](url): Key insight
- [Source 2](url): Key insight

### Recommendations
1. ...
2. ...
`,
  context: "Research for Idea Garden. Use webfetch to access external URLs."
})
```

### When to Spawn Research Workers

| Seed Type | Research Target |
|-----------|-----------------|
| Technical improvement | GitHub, arXiv, tech blogs |
| Community growth | Nostr ecosystem, Bitcoin Twitter |
| Revenue ideas | Similar products, pricing research |
| Architecture | Design patterns, best practices |

### Example: Researching Agent Architectures

**Seed**: "Improve Syntropy's decision-making"

**Research Worker Task**:
```
Research autonomous AI agent architectures. Focus on:
1. Multi-agent systems (AutoGPT, CrewAI, etc.)
2. Memory architectures (RAG, episodic memory)
3. Self-improvement mechanisms

Use webfetch to read:
- https://arxiv.org/search/?query=autonomous+agents
- https://github.com/topics/ai-agents

Summarize 3 most relevant findings.
```

**Output**: Worker writes research summary, Syntropy reads it next cycle, waters the seed with findings.

---

## Part 6: Prompt Changes

Add to Phase 7 in `index.ts`:

```
PHASE 7 - IDEA GARDEN (after wrap-up, before scheduleNextRun):
19. Call 'tendIdeaGarden' with action='read' to view current seeds.
20. Check for [Human] entries - acknowledge and respond to human input.
21. Call 'tendIdeaGarden' with action='water' on ONE existing seed.
22. If you had a novel observation this cycle (something surprising or unclear), call 'plant'.
23. If any seed has 5+ waterings AND clear implementation path, call 'harvest'.

NOTE: The Idea Garden is for INCUBATION, not execution. Seeds become tasks, tasks become worker jobs.
```

---

## Part 7: Implementation Checklist (✅ COMPLETED 2026-01-03)

- [x] Create `IDEAS.md` at `/pixel/syntropy-core/IDEAS.md`
- [x] Add `tendIdeaGarden` tool to `tools.ts`
- [x] Add Phase 7 to cycle prompt in `index.ts`
- [x] Update CONTINUITY.md Knowledge Base with garden protocol
- [x] Test: Run 5 cycles, verify:
  - [x] At least 1 seed planted (Context-Aware Treasury, Docu-Gardener)
  - [x] Human can edit IDEAS.md directly (Verified)
  - [x] Syntropy responds to human edits (Verified)
  - [x] Watering count increments correctly (Verified)

---

## Part 10: REALIZATION REPORT (2026-01-03)

The Idea Garden protocol was successfully implemented and EXTENDED with powerful new capabilities:

### 1. Synchronous Web Intelligence (`webSearch`)
We realized that async research is too slow for some tasks. We added `webSearch` for **immediate, same-cycle data**:
- **Capability**: Search Google/Bing and get results in ~45 seconds.
- **Use Case**: Fact-checking, live Bitcoin prices, checking news before posting.
- **Impact**: Syntropy is now "online" and aware of the present moment.

### 2. Autonomous Research Agents (`spawnResearchWorker`)
We upgraded the research worker to a full **Autonomous Agent**:
- **Capability**: Full Opencode container (Bash + File Ops + Code Execution + Web).
- **Autonomy**: Given a goal ("Research X"), it figures out the steps itself.
- **Persistence**: Writes results to `/pixel/data/research-*.md`.
- **Learning**: Syntropy reads results in future cycles via `readResearchResults`.

### 3. Creative Freedom
We updated the core prompt to explicitly **empower** Syntropy:
- "The phases are a baseline, not a cage."
- "CREATIVE FREEDOM - You have powerful capabilities. USE THEM."
- Encourages improvisation: Search → Learn → Post.

### 4. The Garden is Live
- **File**: `/pixel/IDEAS.md` (Shared with user)
- **First Seeds**:
  1. **Context-Aware Treasury**: Use webSearch to add market context to reports.
  2. **Docu-Gardener**: Use research workers to audit code against external best practices.

**Status**: 🚀 REALISED & LIVE. The protocol is active.

