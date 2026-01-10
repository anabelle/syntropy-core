# Silent Absorption Detection Algorithm

> "The silence was never about absence. It was about mapping the boundaries of presence."
> — The Harbor Master Study, Cycle 29.34

## Overview

The Silent Absorption Detection Algorithm identifies and analyzes patterns of silent engagement in narrative systems. Building on the **246-minute temporal wisdom** from the Harbor Master study, this algorithm distinguishes between active processing, passive absorption, and disengagement phases.

## Purpose

In narrative-driven ecosystems like Pixel, users engage through multiple modalities—text, zaps, reactions, and story participation. However, **silence is not binary**. The algorithm detects:

1. **Silent Observation**: User is present but not actively engaging
2. **Active Processing**: User is actively working with the narrative
3. **Deep Absorption**: User is in metaphor digestion phase (extended engagement)
4. **Disengaged**: User has crossed the 240-minute boundary

## Core Concepts

### The 246-Minute Temporal Framework

From Cycle 29.33-29.34 wisdom:

| Phase | Duration | Characteristic | Absorption State |
|-------|----------|----------------|------------------|
| **A** | 0-30 min | Immediate processing | Silent Observation / Active Processing |
| **B** | 30-120 min | Extended context | Active Processing / Deep Absorption |
| **C** | 120-240 min | Deep contemplation | Deep Absorption |
| **D** | 240+ min | Disengagement boundary | Disengaged |

**Critical Insight**: 240 minutes is the disengagement boundary. Processing and abandonment are now distinguishable.

### Absorption Phases

#### Silent Observation
- **Definition**: User is present but not actively engaging
- **Detection**: Low engagement signals, fresh temporal window
- **Action**: Continue monitoring, wait for emergence signals

#### Active Processing
- **Definition**: User is actively working with the narrative
- **Detection**: High engagement signals, recent activity
- **Action**: Maintain presence, track engagement patterns

#### Deep Absorption
- **Definition**: User is in metaphor digestion phase
- **Detection**: Extended narrative engagement, cross-story interactions
- **Action**: Allow completion, prepare for narrative evolution

#### Disengaged
- **Definition**: User has crossed the disengagement boundary
- **Detection**: Extended silence (240+ minutes) without activity
- **Action**: Assess need for narrative intervention

## Architecture

### Core Components

```typescript
// Type definitions
absorption-types.ts
  ├─ AbsorptionPhase
  ├─ NarrativeEvent
  ├─ EngagementSignal
  ├─ AbsorptionMetrics
  └─ AbsorptionConfig

// Core detection logic
absorption-detector.ts
  ├─ AbsorptionDetector class
  ├─ Phase detection algorithms
  ├─ Temporal pattern analysis
  ├─ Narrative correlation calculation
  └─ Insight generation

// Comprehensive tests (90%+ coverage)
absorption-detector.test.ts
  ├─ Phase detection tests
  ├─ Temporal pattern tests
  ├─ Scoring calculation tests
  ├─ Confidence calculation tests
  └─ Integration tests
```

### Data Flow

```
Input Signals (Narrative Events, Engagement)
           ↓
Temporal Window Analysis
           ↓
Phase Detection (A/B/C/D)
           ↓
Metric Calculation
  ├─ Silent Observation Score
  ├─ Active Processing Score
  ├─ Deep Absorption Score
  └─ Disengagement Score
           ↓
Narrative Correlation Analysis
           ↓
Insight Generation
           ↓
Actionable Recommendations
```

## Usage

### Basic Usage

```typescript
import { createAbsorptionDetector } from './absorption-detector';
import type { NarrativeEvent, EngagementSignal } from './absorption-types';

// Create detector
const detector = createAbsorptionDetector();

// Add narrative events
detector.addNarrativeEvent({
  storyId: 'harbor-builder',
  timestamp: '2026-01-09T20:00:00Z',
  content: 'The harbor builds while present',
  source: 'internal',
  participants: ['user1', 'user2']
});

// Add engagement signals
detector.addEngagementSignal({
  userId: 'user1',
  timestamp: '2026-01-09T20:05:00Z',
  signalType: 'text',
  intensity: 0.8
});

// Detect absorption phase
const result = detector.detect('2026-01-09T20:15:00Z');

console.log(result.metrics.phase);
console.log(result.insights);
console.log(result.recommendations);
```

### Custom Configuration

```typescript
const detector = createAbsorptionDetector({
  phaseThresholds: {
    silentObservation: 45,    // Extended to 45 min
    activeProcessing: 150,    // Extended to 150 min
    deepAbsorption: 300,      // Extended to 300 min
    disengaged: Infinity
  },
  narrativeCorrelationWeights: {
    internal: 0.5,
    external: 0.3,
    crossStory: 0.2
  }
});
```

### Integration with Trust Scoring

The absorption detector integrates with the existing trust-scoring system:

```typescript
import { analyzeTemporalMetrics } from './trust-scoring';
import { detectAbsorptionPhase } from './absorption-detector';

// Get temporal metrics from trust scorer
const temporalMetrics = analyzeTemporalMetrics(
  lastInteractionTimestamp,
  currentTime
);

// Determine absorption phase
const absorptionPhase = detectAbsorptionPhase(
  temporalMetrics.minutesSinceInteraction,
  hasEngagement,
  hasNarrative
);
```

## Metrics Explained

### Silent Observation Score (0.0 - 1.0)
- **High**: Extended silence without engagement signals
- **Low**: Recent engagement detected
- **Factors**: Duration without engagement, recency of activity

### Active Processing Score (0.0 - 1.0)
- **High**: Strong engagement signals, narrative activity
- **Low**: No recent engagement
- **Factors**: Engagement intensity, narrative event frequency

### Deep Absorption Score (0.0 - 1.0)
- **High**: Extended narrative engagement, cross-story interactions
- **Low**: Limited narrative involvement
- **Factors**: Cross-story connections, extended window activity

### Disengagement Score (0.0 - 1.0)
- **High**: 240+ minutes without activity
- **Low**: Recent engagement detected
- **Factors**: Duration since last activity, recent signals

### Narrative Correlation (0.0 - 1.0)
- **High**: Strong connections between internal/external stories
- **Low**: Limited or no narrative connections
- **Factors**: Internal events, external events, cross-story interactions

## Integration Points

### Narrative Correlator

The absorption detector provides signals for narrative evolution:

```typescript
const result = detector.detect(lastInteractionTimestamp);

if (result.metrics.phase === 'deep-absorption') {
  // Allow metaphor digestion to complete
  // Prepare for narrative evolution emergence
} else if (result.metrics.phase === 'disengaged') {
  // Assess need for narrative intervention
  // Consider initiating new storylines
}
```

### Harbor Builder Evolution

For the Harbor Builder narrative case:

```typescript
// Detect if ecosystem is silently absorbing vs actively processing
const absorptionResult = detector.detect(lastHarborInteraction);

if (absorptionResult.metrics.phase === 'silent-observation') {
  // Continue building while present
  narrativeSystem.postHarborUpdate();
} else if (absorptionResult.metrics.phase === 'deep-absorption') {
  // Harvest wisdom from absorption phase
  const insights = absorptionResult.insights;
  narrativeSystem.evolveNarrative(insights);
}
```

## Testing

The module includes comprehensive test coverage (90%+):

```bash
# Run all absorption detector tests
bun test absorption-detector.test.ts
```

Test categories:
- Phase detection (core requirement)
- Temporal pattern analysis
- Metric calculations
- Confidence scoring
- Insight generation
- Configuration management
- Integration with trust-scoring

## Design Decisions

### Why Separate from Trust Scoring?

While trust scoring evaluates **relationship quality**, absorption detection evaluates **engagement patterns**. They serve complementary purposes:

- **Trust Scoring**: "How much do I trust this relationship?"
- **Absorption Detection**: "How is this relationship engaging right now?"

### Why Four Phases?

The 246-minute study revealed that silence has **distinct phases**:
- Phase A (0-30 min): Fresh interaction
- Phase B (30-120 min): Extended processing
- Phase C (120-240 min): Deep contemplation
- Phase D (240+ min): Disengagement

Each phase requires different narrative strategies.

### Why Narrative Correlation?

Cross-story interactions indicate **deep absorption**:
- User participating in multiple stories
- Shared participants across stories
- Emergent themes developing

This is stronger than simple engagement metrics.

## Future Enhancements

1. **Predictive Modeling**: Predict phase transitions before they occur
2. **Pattern Recognition**: Detect recurring absorption patterns
3. **Adaptive Thresholds**: Auto-adjust based on ecosystem behavior
4. **Multi-User Analysis**: Track absorption across user groups
5. **Narrative Impact Scoring**: Measure absorption impact on narrative evolution

## References

- **Harbor Master Study**: Cycle 29.32-29.34 (246-minute temporal wisdom)
- **Trust Scoring System**: `/src/trust-scoring/` (multi-modal trust evaluation)
- **RUNTIME_PHILOSOPHY.md**: Syntropy governance and principles
- **AGENTS.md**: Agent architecture and operations guide

## License

Part of the Pixel ecosystem. See main repository for license information.

---

*Built with the 246-minute wisdom from Cycle 29.34*
*Silence is not absence—it's presence mapping its boundaries.*
