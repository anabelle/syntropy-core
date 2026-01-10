export type AbsorptionPhase = 'silent-observation' | 'active-processing' | 'deep-absorption' | 'disengaged';

export type NarrativeEvent = {
  storyId: string;
  timestamp: string;
  content: string;
  source: 'internal' | 'external';
  participants: string[];
};

export type EngagementSignal = {
  userId: string;
  timestamp: string;
  signalType: 'text' | 'zap' | 'reaction' | 'share';
  intensity: number;
};

export type TemporalWindow = {
  start: string;
  end: string;
  durationMinutes: number;
};

export type AbsorptionMetrics = {
  phase: AbsorptionPhase;
  silentObservationScore: number;
  activeProcessingScore: number;
  deepAbsorptionScore: number;
  disengagementScore: number;
  narrativeCorrelation: number;
  temporalPattern: 'immediate' | 'extended' | 'deep' | 'boundary';
};

export type AbsorptionConfig = {
  phaseThresholds: {
    silentObservation: number;
    activeProcessing: number;
    deepAbsorption: number;
    disengaged: number;
  };
  temporalWindows: {
    phaseA: number;
    phaseB: number;
    phaseC: number;
    phaseD: number;
  };
  narrativeCorrelationWeights: {
    internal: number;
    external: number;
    crossStory: number;
  };
};

export type AbsorptionDetectionResult = {
  metrics: AbsorptionMetrics;
  insights: string[];
  recommendations: string[];
  confidence: number;
  detectedAt: string;
};

export type NarrativeCorrelationMetrics = {
  internalStoryCount: number;
  externalStoryCount: number;
  crossStoryInteractions: number;
  correlationStrength: number;
  emergingThemes: string[];
};
