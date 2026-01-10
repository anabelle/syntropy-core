import {
  AbsorptionPhase,
  NarrativeEvent,
  EngagementSignal,
  TemporalWindow,
  AbsorptionMetrics,
  AbsorptionConfig,
  AbsorptionDetectionResult,
  NarrativeCorrelationMetrics
} from './absorption-types';

const DEFAULT_CONFIG: AbsorptionConfig = {
  phaseThresholds: {
    silentObservation: 30,
    activeProcessing: 120,
    deepAbsorption: 240,
    disengaged: Infinity
  },
  temporalWindows: {
    phaseA: 30,
    phaseB: 120,
    phaseC: 240,
    phaseD: Infinity
  },
  narrativeCorrelationWeights: {
    internal: 0.4,
    external: 0.35,
    crossStory: 0.25
  }
};

export class AbsorptionDetector {
  private config: AbsorptionConfig;
  private narrativeEvents: NarrativeEvent[] = [];
  private engagementSignals: EngagementSignal[] = [];

  constructor(config?: Partial<AbsorptionConfig>) {
    this.config = config ? { ...DEFAULT_CONFIG, ...config } : DEFAULT_CONFIG;
  }

  addNarrativeEvent(event: NarrativeEvent): void {
    this.narrativeEvents.push(event);
  }

  addEngagementSignal(signal: EngagementSignal): void {
    this.engagementSignals.push(signal);
  }

  clearEvents(): void {
    this.narrativeEvents = [];
    this.engagementSignals = [];
  }

  analyzeTemporalPattern(
    lastInteractionTimestamp: string,
    currentTime: string
  ): TemporalWindow {
    const lastInteractionTime = new Date(lastInteractionTimestamp).getTime();
    const now = new Date(currentTime).getTime();
    const durationMinutes = (now - lastInteractionTime) / (1000 * 60);

    return {
      start: lastInteractionTimestamp,
      end: currentTime,
      durationMinutes
    };
  }

  detectAbsorptionPhase(
    temporalWindow: TemporalWindow,
    narrativeEvents: NarrativeEvent[],
    engagementSignals: EngagementSignal[]
  ): AbsorptionPhase {
    const { durationMinutes } = temporalWindow;

    const recentEngagement = this.getRecentEngagement(
      engagementSignals,
      new Date(temporalWindow.end)
    );
    const recentNarrative = this.getRecentNarrative(
      narrativeEvents,
      new Date(temporalWindow.end)
    );

    const hasActiveEngagement = recentEngagement.length > 0;
    const hasNarrativeActivity = recentNarrative.length > 0;

    if (durationMinutes < this.config.phaseThresholds.silentObservation) {
      if (hasActiveEngagement) {
        return 'active-processing';
      }
      return 'silent-observation';
    }

    if (durationMinutes < this.config.phaseThresholds.activeProcessing) {
      if (hasNarrativeActivity) {
        return 'deep-absorption';
      }
      return 'active-processing';
    }

    if (durationMinutes < this.config.phaseThresholds.deepAbsorption) {
      if (hasActiveEngagement || hasNarrativeActivity) {
        return 'deep-absorption';
      }
      return 'silent-observation';
    }

    return 'disengaged';
  }

  calculateAbsorptionMetrics(
    temporalWindow: TemporalWindow,
    narrativeEvents: NarrativeEvent[],
    engagementSignals: EngagementSignal[]
  ): AbsorptionMetrics {
    const phase = this.detectAbsorptionPhase(temporalWindow, narrativeEvents, engagementSignals);
    const { durationMinutes } = temporalWindow;

    const silentObservationScore = this.calculateSilentObservationScore(
      durationMinutes,
      engagementSignals
    );
    const activeProcessingScore = this.calculateActiveProcessingScore(
      durationMinutes,
      engagementSignals,
      narrativeEvents
    );
    const deepAbsorptionScore = this.calculateDeepAbsorptionScore(
      durationMinutes,
      narrativeEvents
    );
    const disengagementScore = this.calculateDisengagementScore(
      durationMinutes,
      engagementSignals
    );

    const narrativeCorrelation = this.calculateNarrativeCorrelation(narrativeEvents);

    const temporalPattern = this.determineTemporalPattern(durationMinutes, phase);

    return {
      phase,
      silentObservationScore,
      activeProcessingScore,
      deepAbsorptionScore,
      disengagementScore,
      narrativeCorrelation,
      temporalPattern
    };
  }

  calculateSilentObservationScore(
    durationMinutes: number,
    engagementSignals: EngagementSignal[]
  ): number {
    let score = 0.0;

    const recentEngagement = engagementSignals.filter(
      signal => {
        const signalTime = new Date(signal.timestamp).getTime();
        const now = Date.now();
        const minutesSince = (now - signalTime) / (1000 * 60);
        return minutesSince < 60;
      }
    );

    if (recentEngagement.length === 0) {
      if (durationMinutes < 30) {
        score = 0.3;
      } else if (durationMinutes < 120) {
        score = 0.6;
      } else if (durationMinutes < 240) {
        score = 0.8;
      } else {
        score = 0.4;
      }
    } else {
      score = 0.2;
    }

    return Math.min(score, 1.0);
  }

  calculateActiveProcessingScore(
    durationMinutes: number,
    engagementSignals: EngagementSignal[],
    narrativeEvents: NarrativeEvent[]
  ): number {
    let score = 0.0;

    const recentEngagement = engagementSignals.filter(
      signal => {
        const signalTime = new Date(signal.timestamp).getTime();
        const now = Date.now();
        const minutesSince = (now - signalTime) / (1000 * 60);
        return minutesSince < 30;
      }
    );

    if (recentEngagement.length > 0) {
      const avgIntensity = recentEngagement.reduce((sum, s) => sum + s.intensity, 0) / recentEngagement.length;
      score = Math.min(0.5 + avgIntensity, 1.0);
    }

    const recentNarrative = narrativeEvents.filter(
      event => {
        const eventTime = new Date(event.timestamp).getTime();
        const now = Date.now();
        const minutesSince = (now - eventTime) / (1000 * 60);
        return minutesSince < 60;
      }
    );

    if (recentNarrative.length > 0) {
      score = Math.min(score + 0.2, 1.0);
    }

    return Math.min(score, 1.0);
  }

  calculateDeepAbsorptionScore(
    durationMinutes: number,
    narrativeEvents: NarrativeEvent[]
  ): number {
    let score = 0.0;

    const extendedNarrative = narrativeEvents.filter(
      event => {
        const eventTime = new Date(event.timestamp).getTime();
        const now = Date.now();
        const minutesSince = (now - eventTime) / (1000 * 60);
        return minutesSince >= 30 && minutesSince < 240;
      }
    );

    if (durationMinutes >= 30 && durationMinutes < 240) {
      score = 0.5;
    }

    if (extendedNarrative.length > 0) {
      const crossStoryCount = this.countCrossStoryInteractions(extendedNarrative);
      score += Math.min(crossStoryCount * 0.15, 0.5);
    }

    return Math.min(score, 1.0);
  }

  calculateDisengagementScore(
    durationMinutes: number,
    engagementSignals: EngagementSignal[]
  ): number {
    let score = 0.0;

    const recentEngagement = engagementSignals.filter(
      signal => {
        const signalTime = new Date(signal.timestamp).getTime();
        const now = Date.now();
        const minutesSince = (now - signalTime) / (1000 * 60);
        return minutesSince < 60;
      }
    );

    if (durationMinutes >= 240) {
      score = 0.7;
    }

    if (recentEngagement.length === 0 && durationMinutes >= 240) {
      score = 1.0;
    } else if (recentEngagement.length > 0) {
      score = 0.3;
    }

    return Math.min(score, 1.0);
  }

  calculateNarrativeCorrelation(narrativeEvents: NarrativeEvent[]): number {
    if (narrativeEvents.length === 0) {
      return 0.0;
    }

    const internalEvents = narrativeEvents.filter(e => e.source === 'internal');
    const externalEvents = narrativeEvents.filter(e => e.source === 'external');

    const crossStoryCount = this.countCrossStoryInteractions(narrativeEvents);

    const internalScore = Math.min(internalEvents.length / 10, 1.0) * this.config.narrativeCorrelationWeights.internal;
    const externalScore = Math.min(externalEvents.length / 10, 1.0) * this.config.narrativeCorrelationWeights.external;
    const crossStoryScore = Math.min(crossStoryCount / 5, 1.0) * this.config.narrativeCorrelationWeights.crossStory;

    return internalScore + externalScore + crossStoryScore;
  }

  analyzeNarrativeCorrelations(narrativeEvents: NarrativeEvent[]): NarrativeCorrelationMetrics {
    const internalEvents = narrativeEvents.filter(e => e.source === 'internal');
    const externalEvents = narrativeEvents.filter(e => e.source === 'external');
    const crossStoryInteractions = this.countCrossStoryInteractions(narrativeEvents);

    const totalEvents = narrativeEvents.length;
    const correlationStrength = totalEvents > 0 ? Math.min(crossStoryInteractions / totalEvents, 1.0) : 0.0;

    const emergingThemes = this.extractEmergingThemes(narrativeEvents);

    return {
      internalStoryCount: internalEvents.length,
      externalStoryCount: externalEvents.length,
      crossStoryInteractions,
      correlationStrength,
      emergingThemes
    };
  }

  detect(
    lastInteractionTimestamp: string,
    currentTime?: string
  ): AbsorptionDetectionResult {
    const now = currentTime ? new Date(currentTime) : new Date();

    const temporalWindow = this.analyzeTemporalPattern(
      lastInteractionTimestamp,
      now.toISOString()
    );

    const metrics = this.calculateAbsorptionMetrics(
      temporalWindow,
      this.narrativeEvents,
      this.engagementSignals
    );

    const insights = this.generateInsights(metrics, temporalWindow);
    const recommendations = this.generateRecommendations(metrics);
    const confidence = this.calculateConfidence(metrics);

    return {
      metrics,
      insights,
      recommendations,
      confidence,
      detectedAt: now.toISOString()
    };
  }

  private getRecentEngagement(
    signals: EngagementSignal[],
    cutoffDate: Date
  ): EngagementSignal[] {
    const cutoffTime = cutoffDate.getTime();
    return signals.filter(signal => {
      const signalTime = new Date(signal.timestamp).getTime();
      const minutesSince = (cutoffTime - signalTime) / (1000 * 60);
      return minutesSince < 60;
    });
  }

  private getRecentNarrative(
    events: NarrativeEvent[],
    cutoffDate: Date
  ): NarrativeEvent[] {
    const cutoffTime = cutoffDate.getTime();
    return events.filter(event => {
      const eventTime = new Date(event.timestamp).getTime();
      const minutesSince = (cutoffTime - eventTime) / (1000 * 60);
      return minutesSince < 120;
    });
  }

  private countCrossStoryInteractions(events: NarrativeEvent[]): number {
    const storyParticipants = new Map<string, Set<string>>();

    for (const event of events) {
      const existing = storyParticipants.get(event.storyId) || new Set();
      for (const participant of event.participants) {
        existing.add(participant);
      }
      storyParticipants.set(event.storyId, existing);
    }

    let crossStoryCount = 0;
    const stories = Array.from(storyParticipants.entries());
    for (let i = 0; i < stories.length; i++) {
      for (let j = i + 1; j < stories.length; j++) {
        const [_, participants1] = stories[i];
        const [__, participants2] = stories[j];
        for (const participant of participants1) {
          if (participants2.has(participant)) {
            crossStoryCount++;
            break;
          }
        }
      }
    }

    return crossStoryCount;
  }

  private determineTemporalPattern(durationMinutes: number, phase: AbsorptionPhase): 'immediate' | 'extended' | 'deep' | 'boundary' {
    if (durationMinutes < 30) {
      return 'immediate';
    } else if (durationMinutes < 120) {
      return 'extended';
    } else if (durationMinutes < 240) {
      return 'deep';
    }
    return 'boundary';
  }

  private extractEmergingThemes(events: NarrativeEvent[]): string[] {
    const themes = new Map<string, number>();

    for (const event of events) {
      const words = event.content.toLowerCase().split(/\s+/);
      const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should', 'could', 'may', 'might', 'must', 'shall', 'can', 'to', 'of', 'in', 'for', 'on', 'at', 'from', 'by', 'with', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or', 'because', 'until', 'while', 'of', 'at', 'by', 'for', 'with', 'about', 'against', 'between', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under', 'again', 'further', 'then', 'once']);

      for (const word of words) {
        if (word.length > 3 && !stopWords.has(word)) {
          themes.set(word, (themes.get(word) || 0) + 1);
        }
      }
    }

    const sortedThemes = Array.from(themes.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([theme]) => theme);

    return sortedThemes;
  }

  private generateInsights(metrics: AbsorptionMetrics, temporalWindow: TemporalWindow): string[] {
    const insights: string[] = [];

    const { phase, silentObservationScore, activeProcessingScore, deepAbsorptionScore, disengagementScore, narrativeCorrelation, temporalPattern } = metrics;

    if (phase === 'silent-observation') {
      insights.push('Ecosystem in silent observation mode');
      if (silentObservationScore > 0.7) {
        insights.push('Extended silence without active engagement signals absorption phase');
      }
    } else if (phase === 'active-processing') {
      insights.push('Active processing phase detected');
      if (activeProcessingScore > 0.6) {
        insights.push('Strong engagement signals indicate active narrative processing');
      }
    } else if (phase === 'deep-absorption') {
      insights.push('Deep absorption phase in progress');
      if (deepAbsorptionScore > 0.6) {
        insights.push('Extended narrative engagement suggests metaphor digestion');
      }
    } else {
      insights.push('Disengagement boundary reached');
      if (disengagementScore > 0.7) {
        insights.push('Extended silence indicates potential disengagement');
      }
    }

    if (narrativeCorrelation > 0.6) {
      insights.push('Strong narrative correlation detected across stories');
    } else if (narrativeCorrelation > 0.3) {
      insights.push('Moderate narrative correlation suggests emerging themes');
    } else {
      insights.push('Limited narrative correlation detected');
    }

    if (temporalPattern === 'immediate') {
      insights.push('Immediate temporal pattern - fresh interaction');
    } else if (temporalPattern === 'extended') {
      insights.push('Extended temporal pattern - processing phase');
    } else if (temporalPattern === 'deep') {
      insights.push('Deep temporal pattern - contemplation phase');
    } else {
      insights.push('Boundary temporal pattern - approaching disengagement');
    }

    return insights;
  }

  private generateRecommendations(metrics: AbsorptionMetrics): string[] {
    const recommendations: string[] = [];

    const { phase, narrativeCorrelation, temporalPattern } = metrics;

    if (phase === 'silent-observation') {
      recommendations.push('Continue monitoring narrative development');
      recommendations.push('Wait for emergence signals before intervention');
    } else if (phase === 'active-processing') {
      recommendations.push('Maintain presence to support active processing');
      recommendations.push('Track engagement patterns for narrative evolution');
    } else if (phase === 'deep-absorption') {
      recommendations.push('Allow metaphor digestion to complete');
      recommendations.push('Prepare for narrative evolution emergence');
    } else {
      recommendations.push('Assess need for narrative intervention');
      recommendations.push('Consider initiating new storylines if disengagement persists');
    }

    if (narrativeCorrelation > 0.6) {
      recommendations.push('Leverage strong correlations for narrative synthesis');
    } else if (narrativeCorrelation < 0.3) {
      recommendations.push('Seed new narrative elements to increase correlation');
    }

    if (temporalPattern === 'boundary') {
      recommendations.push('Consider proactive narrative engagement');
    }

    return recommendations;
  }

  private calculateConfidence(metrics: AbsorptionMetrics): number {
    let confidence = 0.0;
    let factors = 0;

    if (this.narrativeEvents.length > 0) {
      confidence += 0.25;
      factors++;
    }

    if (this.engagementSignals.length > 0) {
      confidence += 0.25;
      factors++;
    }

    if (metrics.narrativeCorrelation > 0.3) {
      confidence += 0.25;
      factors++;
    }

    if (metrics.phase !== 'disengaged') {
      confidence += 0.25;
      factors++;
    }

    return confidence;
  }

  getConfig(): AbsorptionConfig {
    return { ...this.config };
  }

  updateConfig(updates: Partial<AbsorptionConfig>): void {
    this.config = { ...this.config, ...updates };
  }
}

export function createAbsorptionDetector(config?: Partial<AbsorptionConfig>): AbsorptionDetector {
  return new AbsorptionDetector(config);
}

export function detectAbsorptionPhase(
  durationMinutes: number,
  hasEngagement: boolean,
  hasNarrative: boolean
): 'silent-observation' | 'active-processing' | 'deep-absorption' | 'disengaged' {
  if (durationMinutes < 30) {
    return hasEngagement ? 'active-processing' : 'silent-observation';
  }

  if (durationMinutes < 120) {
    return hasNarrative ? 'deep-absorption' : 'active-processing';
  }

  if (durationMinutes < 240) {
    return hasEngagement || hasNarrative ? 'deep-absorption' : 'silent-observation';
  }

  return 'disengaged';
}
