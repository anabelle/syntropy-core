import { expect, test, describe, beforeEach } from 'bun:test';
import {
  AbsorptionDetector,
  createAbsorptionDetector,
  detectAbsorptionPhase
} from './absorption-detector';
import {
  AbsorptionPhase,
  NarrativeEvent,
  EngagementSignal,
  AbsorptionConfig
} from './absorption-types';

describe('AbsorptionDetector - Core Detection', () => {
  let detector: AbsorptionDetector;
  let baseTime: string;

  beforeEach(() => {
    detector = createAbsorptionDetector();
    baseTime = new Date().toISOString();
    detector.clearEvents();
  });

  describe('Phase Detection (Core Requirement)', () => {
    test('should detect silent-observation for fresh interactions without engagement', () => {
      const testTime = new Date(new Date(baseTime).getTime() - 15 * 60 * 1000).toISOString();
      const result = detector.detect(testTime);

      expect(result.metrics.phase).toBe('silent-observation');
      expect(result.metrics.temporalPattern).toBe('immediate');
    });

    test('should detect active-processing for fresh interactions with engagement', () => {
      detector.addEngagementSignal({
        userId: 'user1',
        timestamp: new Date(new Date(baseTime).getTime() - 5 * 60 * 1000).toISOString(),
        signalType: 'text',
        intensity: 0.8
      });

      const testTime = new Date(new Date(baseTime).getTime() - 15 * 60 * 1000).toISOString();
      const result = detector.detect(testTime);

      expect(result.metrics.phase).toBe('active-processing');
    });

    test('should detect deep-absorption in extended window with narrative activity', () => {
      detector.addNarrativeEvent({
        storyId: 'story1',
        timestamp: new Date(new Date(baseTime).getTime() - 90 * 60 * 1000).toISOString(),
        content: 'The harbor builds',
        source: 'internal',
        participants: ['user1', 'user2']
      });

      const testTime = new Date(new Date(baseTime).getTime() - 90 * 60 * 1000).toISOString();
      const result = detector.detect(testTime);

      expect(result.metrics.phase).toBe('deep-absorption');
      expect(result.metrics.temporalPattern).toBe('extended');
    });

    test('should detect disengaged after 240 minutes without activity', () => {
      const testTime = new Date(new Date(baseTime).getTime() - 250 * 60 * 1000).toISOString();
      const result = detector.detect(testTime);

      expect(result.metrics.phase).toBe('disengaged');
      expect(result.metrics.temporalPattern).toBe('boundary');
    });

    test('should maintain active-processing with continued engagement in extended window', () => {
      detector.addEngagementSignal({
        userId: 'user1',
        timestamp: new Date(new Date(baseTime).getTime() - 90 * 60 * 1000).toISOString(),
        signalType: 'zap',
        intensity: 0.9
      });

      const testTime = new Date(new Date(baseTime).getTime() - 90 * 60 * 1000).toISOString();
      const result = detector.detect(testTime);

      expect(result.metrics.phase).toBe('active-processing');
    });
  });

  describe('Temporal Pattern Analysis', () => {
    test('should identify immediate pattern for interactions < 30 minutes', () => {
      const testTime = new Date(new Date(baseTime).getTime() - 15 * 60 * 1000).toISOString();
      const result = detector.detect(testTime);

      expect(result.metrics.temporalPattern).toBe('immediate');
      expect(result.insights).toContain('Immediate temporal pattern - fresh interaction');
    });

    test('should identify extended pattern for interactions 30-120 minutes', () => {
      const testTime = new Date(new Date(baseTime).getTime() - 75 * 60 * 1000).toISOString();
      const result = detector.detect(testTime);

      expect(result.metrics.temporalPattern).toBe('extended');
    });

    test('should identify deep pattern for interactions 120-240 minutes', () => {
      const testTime = new Date(new Date(baseTime).getTime() - 180 * 60 * 1000).toISOString();
      const result = detector.detect(testTime);

      expect(result.metrics.temporalPattern).toBe('deep');
    });

    test('should identify boundary pattern for interactions 240+ minutes', () => {
      const testTime = new Date(new Date(baseTime).getTime() - 300 * 60 * 1000).toISOString();
      const result = detector.detect(testTime);

      expect(result.metrics.temporalPattern).toBe('boundary');
    });
  });

  describe('Silent Observation Score Calculation', () => {
    test('should calculate high silent observation score for extended silence', () => {
      const testTime = new Date(new Date(baseTime).getTime() - 180 * 60 * 1000).toISOString();
      const result = detector.detect(testTime);

      expect(result.metrics.silentObservationScore).toBeGreaterThan(0.5);
    });

    test('should reduce silent observation score with recent engagement', () => {
      detector.addEngagementSignal({
        userId: 'user1',
        timestamp: new Date(new Date(baseTime).getTime() - 10 * 60 * 1000).toISOString(),
        signalType: 'text',
        intensity: 0.7
      });

      const testTime = new Date(new Date(baseTime).getTime() - 180 * 60 * 1000).toISOString();
      const result = detector.detect(testTime);

      expect(result.metrics.silentObservationScore).toBeLessThan(0.5);
    });

    test('should reduce silent observation score at disengagement boundary', () => {
      const testTime = new Date(new Date(baseTime).getTime() - 300 * 60 * 1000).toISOString();
      const result = detector.detect(testTime);

      expect(result.metrics.silentObservationScore).toBeLessThan(0.6);
    });
  });

  describe('Active Processing Score Calculation', () => {
    test('should calculate high active processing score with recent engagement', () => {
      detector.addEngagementSignal({
        userId: 'user1',
        timestamp: new Date(new Date(baseTime).getTime() - 10 * 60 * 1000).toISOString(),
        signalType: 'text',
        intensity: 0.9
      });

      const testTime = new Date(new Date(baseTime).getTime() - 15 * 60 * 1000).toISOString();
      const result = detector.detect(testTime);

      expect(result.metrics.activeProcessingScore).toBeGreaterThan(0.7);
    });

    test('should boost active processing with narrative events', () => {
      detector.addNarrativeEvent({
        storyId: 'story1',
        timestamp: new Date(new Date(baseTime).getTime() - 20 * 60 * 1000).toISOString(),
        content: 'Building the harbor',
        source: 'internal',
        participants: ['user1']
      });

      detector.addEngagementSignal({
        userId: 'user1',
        timestamp: new Date(new Date(baseTime).getTime() - 10 * 60 * 1000).toISOString(),
        signalType: 'reaction',
        intensity: 0.6
      });

      const testTime = new Date(new Date(baseTime).getTime() - 15 * 60 * 1000).toISOString();
      const result = detector.detect(testTime);

      expect(result.metrics.activeProcessingScore).toBeGreaterThan(0.5);
    });

    test('should calculate low active processing score without engagement', () => {
      const testTime = new Date(new Date(baseTime).getTime() - 180 * 60 * 1000).toISOString();
      const result = detector.detect(testTime);

      expect(result.metrics.activeProcessingScore).toBeLessThan(0.3);
    });
  });

  describe('Deep Absorption Score Calculation', () => {
    test('should calculate high deep absorption score with cross-story interactions', () => {
      detector.addNarrativeEvent({
        storyId: 'story1',
        timestamp: new Date(new Date(baseTime).getTime() - 180 * 60 * 1000).toISOString(),
        content: 'The harbor builds',
        source: 'internal',
        participants: ['user1', 'user2']
      });

      detector.addNarrativeEvent({
        storyId: 'story2',
        timestamp: new Date(new Date(baseTime).getTime() - 150 * 60 * 1000).toISOString(),
        content: 'Love emerges',
        source: 'external',
        participants: ['user1', 'user3']
      });

      const testTime = new Date(new Date(baseTime).getTime() - 180 * 60 * 1000).toISOString();
      const result = detector.detect(testTime);

      expect(result.metrics.deepAbsorptionScore).toBeGreaterThan(0.5);
    });

    test('should calculate moderate deep absorption in extended window', () => {
      const testTime = new Date(new Date(baseTime).getTime() - 180 * 60 * 1000).toISOString();
      const result = detector.detect(testTime);

      expect(result.metrics.deepAbsorptionScore).toBeGreaterThanOrEqual(0.5);
    });

    test('should calculate low deep absorption in immediate window', () => {
      const testTime = new Date(new Date(baseTime).getTime() - 15 * 60 * 1000).toISOString();
      const result = detector.detect(testTime);

      expect(result.metrics.deepAbsorptionScore).toBeLessThan(0.5);
    });
  });

  describe('Disengagement Score Calculation', () => {
    test('should calculate high disengagement score at boundary without activity', () => {
      const testTime = new Date(new Date(baseTime).getTime() - 300 * 60 * 1000).toISOString();
      const result = detector.detect(testTime);

      expect(result.metrics.disengagementScore).toBeGreaterThan(0.7);
    });

    test('should reduce disengagement score with recent engagement', () => {
      detector.addEngagementSignal({
        userId: 'user1',
        timestamp: new Date(new Date(baseTime).getTime() - 30 * 60 * 1000).toISOString(),
        signalType: 'text',
        intensity: 0.8
      });

      const testTime = new Date(new Date(baseTime).getTime() - 300 * 60 * 1000).toISOString();
      const result = detector.detect(testTime);

      expect(result.metrics.disengagementScore).toBeLessThan(0.5);
    });

    test('should calculate moderate disengagement in deep window', () => {
      const testTime = new Date(new Date(baseTime).getTime() - 180 * 60 * 1000).toISOString();
      const result = detector.detect(testTime);

      expect(result.metrics.disengagementScore).toBeLessThan(0.5);
    });
  });

  describe('Narrative Correlation Calculation', () => {
    test('should calculate correlation with internal and external events', () => {
      detector.addNarrativeEvent({
        storyId: 'story1',
        timestamp: new Date(new Date(baseTime).getTime() - 60 * 60 * 1000).toISOString(),
        content: 'Harbor Master builds',
        source: 'internal',
        participants: ['user1']
      });

      detector.addNarrativeEvent({
        storyId: 'story2',
        timestamp: new Date(new Date(baseTime).getTime() - 50 * 60 * 1000).toISOString(),
        content: 'External love story',
        source: 'external',
        participants: ['user2']
      });

      const result = detector.detect(baseTime);
      expect(result.metrics.narrativeCorrelation).toBeGreaterThan(0.0);
    });

    test('should boost correlation with cross-story interactions', () => {
      detector.addNarrativeEvent({
        storyId: 'story1',
        timestamp: new Date(new Date(baseTime).getTime() - 120 * 60 * 1000).toISOString(),
        content: 'Harbor builds',
        source: 'internal',
        participants: ['user1', 'user2']
      });

      detector.addNarrativeEvent({
        storyId: 'story2',
        timestamp: new Date(new Date(baseTime).getTime() - 90 * 60 * 1000).toISOString(),
        content: 'Love emerges',
        source: 'external',
        participants: ['user1', 'user3']
      });

      const result = detector.detect(baseTime);
      expect(result.metrics.narrativeCorrelation).toBeGreaterThan(0.1);
    });

    test('should return zero correlation with no events', () => {
      const result = detector.detect(baseTime);
      expect(result.metrics.narrativeCorrelation).toBe(0.0);
    });
  });

  describe('Narrative Correlation Metrics', () => {
    test('should analyze narrative correlation metrics', () => {
      detector.addNarrativeEvent({
        storyId: 'story1',
        timestamp: new Date(new Date(baseTime).getTime() - 60 * 60 * 1000).toISOString(),
        content: 'Harbor Master builds the harbor',
        source: 'internal',
        participants: ['user1', 'user2']
      });

      detector.addNarrativeEvent({
        storyId: 'story2',
        timestamp: new Date(new Date(baseTime).getTime() - 50 * 60 * 1000).toISOString(),
        content: 'External love story emerges',
        source: 'external',
        participants: ['user2', 'user3']
      });

      const result = detector.detect(baseTime);
      expect(result.insights.length).toBeGreaterThan(0);
    });
  });

  describe('Confidence Calculation', () => {
    test('should calculate confidence based on available data', () => {
      detector.addNarrativeEvent({
        storyId: 'story1',
        timestamp: new Date(new Date(baseTime).getTime() - 30 * 60 * 1000).toISOString(),
        content: 'Harbor builds',
        source: 'internal',
        participants: ['user1']
      });

      detector.addEngagementSignal({
        userId: 'user1',
        timestamp: new Date(new Date(baseTime).getTime() - 10 * 60 * 1000).toISOString(),
        signalType: 'text',
        intensity: 0.8
      });

      const result = detector.detect(baseTime);
      expect(result.confidence).toBeGreaterThan(0.0);
      expect(result.confidence).toBeLessThanOrEqual(1.0);
    });

    test('should calculate low confidence with minimal data', () => {
      const testTime = new Date(new Date(baseTime).getTime() - 300 * 60 * 1000).toISOString();
      const result = detector.detect(testTime);

      expect(result.confidence).toBeLessThan(0.5);
    });

    test('should calculate high confidence with rich data', () => {
      for (let i = 0; i < 5; i++) {
        detector.addNarrativeEvent({
          storyId: `story${i}`,
          timestamp: new Date(new Date(baseTime).getTime() - (i * 30 + 10) * 60 * 1000).toISOString(),
          content: `Narrative event ${i}`,
          source: i % 2 === 0 ? 'internal' : 'external',
          participants: [`user${i}`, `user${i + 1}`]
        });
      }

      for (let i = 0; i < 5; i++) {
        detector.addEngagementSignal({
          userId: `user${i}`,
          timestamp: new Date(new Date(baseTime).getTime() - (i * 15 + 5) * 60 * 1000).toISOString(),
          signalType: 'text',
          intensity: 0.7
        });
      }

      const result = detector.detect(baseTime);
      expect(result.confidence).toBeGreaterThan(0.5);
    });
  });

  describe('Insights Generation', () => {
    test('should generate phase-specific insights', () => {
      detector.addEngagementSignal({
        userId: 'user1',
        timestamp: new Date(new Date(baseTime).getTime() - 10 * 60 * 1000).toISOString(),
        signalType: 'text',
        intensity: 0.9
      });

      const result = detector.detect(baseTime);
      expect(result.insights.length).toBeGreaterThan(0);
    });

    test('should include narrative correlation insights', () => {
      detector.addNarrativeEvent({
        storyId: 'story1',
        timestamp: new Date(new Date(baseTime).getTime() - 60 * 60 * 1000).toISOString(),
        content: 'Harbor builds',
        source: 'internal',
        participants: ['user1']
      });

      const result = detector.detect(baseTime);
      const hasCorrelationInsight = result.insights.some(insight =>
        insight.toLowerCase().includes('narrative correlation')
      );
      expect(hasCorrelationInsight).toBe(true);
    });

    test('should include temporal pattern insights', () => {
      const result = detector.detect(baseTime);
      const hasTemporalInsight = result.insights.some(insight =>
        insight.toLowerCase().includes('temporal pattern')
      );
      expect(hasTemporalInsight).toBe(true);
    });
  });

  describe('Recommendations Generation', () => {
    test('should generate phase-specific recommendations', () => {
      const result = detector.detect(baseTime);
      expect(result.recommendations.length).toBeGreaterThan(0);
    });

    test('should provide continuation recommendations for silent-observation', () => {
      const testTime = new Date(new Date(baseTime).getTime() - 15 * 60 * 1000).toISOString();
      const result = detector.detect(testTime);

      expect(result.recommendations.length).toBeGreaterThan(0);
    });

    test('should provide engagement recommendations for active-processing', () => {
      detector.addEngagementSignal({
        userId: 'user1',
        timestamp: new Date(new Date(baseTime).getTime() - 10 * 60 * 1000).toISOString(),
        signalType: 'text',
        intensity: 0.8
      });

      const result = detector.detect(baseTime);
      expect(result.recommendations.length).toBeGreaterThan(0);
    });

    test('should provide intervention recommendations for disengaged', () => {
      const testTime = new Date(new Date(baseTime).getTime() - 300 * 60 * 1000).toISOString();
      const result = detector.detect(testTime);

      const hasInterventionRec = result.recommendations.some(rec =>
        rec.toLowerCase().includes('intervention') || rec.toLowerCase().includes('narrative')
      );
      expect(hasInterventionRec).toBe(true);
    });
  });

  describe('Configuration Management', () => {
    test('should allow custom configuration', () => {
      const customConfig: Partial<AbsorptionConfig> = {
        phaseThresholds: {
          silentObservation: 45,
          activeProcessing: 150,
          deepAbsorption: 300,
          disengaged: Infinity
        }
      };

      const customDetector = createAbsorptionDetector(customConfig);
      const config = customDetector.getConfig();

      expect(config.phaseThresholds.silentObservation).toBe(45);
      expect(config.phaseThresholds.activeProcessing).toBe(150);
    });

    test('should allow configuration updates', () => {
      detector.updateConfig({
        phaseThresholds: {
          silentObservation: 60,
          activeProcessing: 180,
          deepAbsorption: 360,
          disengaged: Infinity
        }
      });

      const config = detector.getConfig();
      expect(config.phaseThresholds.silentObservation).toBe(60);
    });
  });

  describe('Event Management', () => {
    test('should add narrative events correctly', () => {
      const event: NarrativeEvent = {
        storyId: 'story1',
        timestamp: baseTime,
        content: 'Harbor builds',
        source: 'internal',
        participants: ['user1']
      };

      detector.addNarrativeEvent(event);
      const result = detector.detect(baseTime);

      expect(result.confidence).toBeGreaterThan(0.0);
    });

    test('should add engagement signals correctly', () => {
      const signal: EngagementSignal = {
        userId: 'user1',
        timestamp: baseTime,
        signalType: 'text',
        intensity: 0.8
      };

      detector.addEngagementSignal(signal);
      const result = detector.detect(baseTime);

      expect(result.confidence).toBeGreaterThan(0.0);
    });

    test('should clear events correctly', () => {
      detector.addNarrativeEvent({
        storyId: 'story1',
        timestamp: baseTime,
        content: 'Harbor builds',
        source: 'internal',
        participants: ['user1']
      });

      detector.addEngagementSignal({
        userId: 'user1',
        timestamp: baseTime,
        signalType: 'text',
        intensity: 0.8
      });

      detector.clearEvents();
      const result = detector.detect(baseTime);

      expect(result.confidence).toBeLessThan(0.5);
    });
  });

  describe('Utility Functions', () => {
    test('detectAbsorptionPhase should identify silent-observation for fresh interactions', () => {
      const phase = detectAbsorptionPhase(15, false, false);
      expect(phase).toBe('silent-observation');
    });

    test('detectAbsorptionPhase should identify active-processing for fresh interactions with engagement', () => {
      const phase = detectAbsorptionPhase(15, true, false);
      expect(phase).toBe('active-processing');
    });

    test('detectAbsorptionPhase should identify deep-absorption in extended window with narrative', () => {
      const phase = detectAbsorptionPhase(90, false, true);
      expect(phase).toBe('deep-absorption');
    });

    test('detectAbsorptionPhase should identify disengaged at boundary', () => {
      const phase = detectAbsorptionPhase(300, false, false);
      expect(phase).toBe('disengaged');
    });
  });
});

describe('AbsorptionDetector - Integration with Trust Scoring', () => {
  test('should integrate with 246-minute temporal boundaries', () => {
    const detector = createAbsorptionDetector();
    const baseTime = new Date().toISOString();

    const testTime = new Date(new Date(baseTime).getTime() - 246 * 60 * 1000).toISOString();
    const result = detector.detect(testTime);

    expect(result.metrics.phase).toBe('disengaged');
    expect(result.metrics.temporalPattern).toBe('boundary');
  });

  test('should respect Phase A (0-30min) boundary', () => {
    const detector = createAbsorptionDetector();
    const baseTime = new Date().toISOString();

    const testTime = new Date(new Date(baseTime).getTime() - 29 * 60 * 1000).toISOString();
    const result = detector.detect(testTime);

    expect(result.metrics.temporalPattern).toBe('immediate');
  });

  test('should respect Phase B (30-120min) boundary', () => {
    const detector = createAbsorptionDetector();
    const baseTime = new Date().toISOString();

    const testTime = new Date(new Date(baseTime).getTime() - 119 * 60 * 1000).toISOString();
    const result = detector.detect(testTime);

    expect(result.metrics.temporalPattern).toBe('extended');
  });

  test('should respect Phase C (120-240min) boundary', () => {
    const detector = createAbsorptionDetector();
    const baseTime = new Date().toISOString();

    const testTime = new Date(new Date(baseTime).getTime() - 239 * 60 * 1000).toISOString();
    const result = detector.detect(testTime);

    expect(result.metrics.temporalPattern).toBe('deep');
  });
});
