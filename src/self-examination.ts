import { tool } from 'ai';
import { z } from 'zod';
import * as fs from 'fs-extra';
import * as path from 'path';
import { PIXEL_ROOT } from './config';
import { logAudit } from './utils';

/**
 * METACOGNITIVE SELF-DISCOVERY FRAMEWORK
 * 
 * This module implements the "Self-Examination" phase (Phase 3.5) of the Syntropy cycle.
 * 
 * Core Philosophy:
 * The organism's beliefs (CONTINUITY.md) must be cross-referenced with reality
 * (feed, memory, logs) to detect blind spots and paradoxes.
 * 
 * Discovery Loop:
 * 1. Extract belief state from CONTINUITY.md
 * 2. Query actual reality from external sources
 * 3. Compare and detect mismatches
 * 4. Extract generalizable principles
 * 5. Document insights for next cycle refinement
 * 
 * Domains of Examination:
 * - Treasury: Beliefs about sat flow vs actual transactions
 * - Relationships: Beliefs about engagement vs actual mentions/zaps
 * - Infrastructure: Beliefs about health vs actual metrics
 * - Code Quality: Beliefs about architecture vs actual patterns
 */

interface BeliefState {
  domain: string;
  belief: string;
  evidence: string[];
  confidence: 'high' | 'medium' | 'low';
}

interface RealityCheck {
  domain: string;
  metric: string;
  actualValue: any;
  source: string;
  timestamp: string;
}

interface StateMismatch {
  domain: string;
  belief: string;
  reality: string;
  paradox: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  principleExtracted?: string;
}

export const selfExaminationTools = {
  /**
   * Main tool for running the self-examination protocol.
   * Cross-references belief vs reality across multiple domains.
   */
  runSelfExamination: tool({
    description: `Execute the Self-Examination protocol (Phase 3.5) to cross-reference belief vs reality.
    
    This tool:
    1. Reads CONTINUITY.md to extract belief state
    2. Queries external reality (feed, memory, logs) for each domain
    3. Detects mismatches between expectations and actual conditions
    4. Extracts generalizable principles from discoveries
    5. Returns insights for strategy refinement
    
    Domains examined:
    - Relationships: Engagement expectations vs actual mentions/zaps
    - Treasury: Beliefs about sat flow vs actual transactions
    - Infrastructure: Health beliefs vs actual metrics
    - Code Quality: Architecture beliefs vs actual patterns
    
    Use this AFTER Phase 3 (Task Execution) and BEFORE Phase 4 (Knowledge Retention).`,
    inputSchema: z.object({
      domains: z.array(z.enum(['relationships', 'treasury', 'infrastructure', 'code-quality', 'all'])).default(['all']).describe('Domains to examine. Default: all'),
      cycleNumber: z.number().optional().describe('Current cycle number for tracking evolution'),
      tasksCompletedThisCycle: z.number().default(0).describe('Number of tasks successfully completed this cycle'),
      tasksAttempted: z.number().default(0).describe('Number of tasks attempted this cycle (successful or failed)')
    }),
    execute: async ({ domains, cycleNumber, tasksCompletedThisCycle = 0, tasksAttempted = 0 }) => {
      console.log(`[SYNTROPY] Self-Examination Protocol - Domains: ${domains.join(', ')}, Progress: ${tasksCompletedThisCycle}/${tasksAttempted} tasks`);
      
      try {
        const results = {
          cycle: cycleNumber,
          timestamp: new Date().toISOString(),
          domainsExamined: domains.includes('all') ? ['relationships', 'treasury', 'infrastructure', 'code-quality'] : domains,
          mismatches: [] as StateMismatch[],
          insights: [] as string[],
          overallHealth: 'idle' as 'healthy' | 'idle' | 'blocked',
          tasksCompletedThisCycle,
          tasksAttempted
        };
        
        // Expand 'all' to specific domains
        const domainsToExamine = domains.includes('all') 
          ? ['relationships', 'treasury', 'infrastructure', 'code-quality'] 
          : domains;
        
        // 1. Extract belief state from CONTINUITY.md
        const beliefStates = await extractBeliefStates();
        
        // 2. For each domain, cross-reference belief with reality
        for (const domain of domainsToExamine) {
          const beliefs = beliefStates.filter(b => b.domain === domain);
          const realityChecks = await queryRealityForDomain(domain);
          const mismatches = detectMismatches(beliefs, realityChecks);
          
          results.mismatches.push(...mismatches);
        }
        
        // 3. Assess overall health based on progress
        if (tasksAttempted === 0) {
          results.overallHealth = 'idle';
        } else if (tasksCompletedThisCycle === 0) {
          results.overallHealth = 'blocked';
        } else {
          results.overallHealth = 'healthy';
        }
        
        // 4. Extract insights from mismatches
        results.insights = extractInsights(results.mismatches);
        
        // 5. Audit the examination
        await logAudit({
          type: 'self_examination_complete',
          domains: domainsToExamine,
          mismatches: results.mismatches.length,
          insights: results.insights.length,
          health: results.overallHealth,
          progress: {
            completed: tasksCompletedThisCycle,
            attempted: tasksAttempted
          }
        });
        
        return results;
      } catch (error: any) {
        await logAudit({
          type: 'self_examination_error',
          error: error.message
        });
        return { error: `Self-examination failed: ${error.message}` };
      }
    }
  }),
  
  /**
   * Extract belief patterns from CONTINUITY.md for a specific domain.
   */
  extractBeliefs: tool({
    description: `Extract belief state from CONTINUITY.md for a specific domain.
    
    Returns structured beliefs about what the organism expects vs what reality shows.
    Useful for targeted examination of specific domains.`,
    inputSchema: z.object({
      domain: z.enum(['relationships', 'treasury', 'infrastructure', 'code-quality']).describe('Domain to extract beliefs for')
    }),
    execute: async ({ domain }) => {
      console.log(`[SYNTROPY] Extracting beliefs for domain: ${domain}`);
      
      try {
        const beliefStates = await extractBeliefStates();
        const domainBeliefs = beliefStates.filter(b => b.domain === domain);
        
        return {
          domain,
          beliefs: domainBeliefs,
          count: domainBeliefs.length
        };
      } catch (error: any) {
        return { error: `Failed to extract beliefs: ${error.message}` };
      }
    }
  }),
  
  /**
   * Compare a specific belief against a reality check to detect paradox.
   */
  detectParadox: tool({
    description: `Detect paradox between a specific belief and reality.
    
    Use this when you have identified a potential mismatch and need to analyze it.
    Returns the paradox type and suggested principle extraction.`,
    inputSchema: z.object({
      belief: z.string().describe('The belief from CONTINUITY.md'),
      reality: z.string().describe('The actual reality observed'),
      domain: z.string().describe('Domain of the paradox')
    }),
    execute: async ({ belief, reality, domain }) => {
      console.log(`[SYNTROPY] Detecting paradox in domain: ${domain}`);
      
      const paradox = analyzeParadox(belief, reality, domain);
      
      await logAudit({
        type: 'paradox_detected',
        domain,
        paradoxType: paradox.type,
        severity: paradox.severity
      });
      
      return paradox;
    }
  })
};

/**
 * Extract belief states from CONTINUITY.md.
 * Parses the document to find explicit statements about what the organism believes.
 */
async function extractBeliefStates(): Promise<BeliefState[]> {
  const continuityPath = path.resolve(PIXEL_ROOT, 'CONTINUITY.md');
  const content = await fs.readFile(continuityPath, 'utf-8');
  
  const beliefs: BeliefState[] = [];
  const lines = content.split('\n');
  
  let currentDomain: string | null = null;
  let currentBelief: string[] = [];
  let currentEvidence: string[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Detect domain markers
    if (line.includes('Relationship') || line.includes('Trust') || line.includes('Engagement')) {
      if (currentBelief.length > 0) {
        beliefs.push({
          domain: currentDomain || 'unknown',
          belief: currentBelief.join(' ').trim(),
          evidence: currentEvidence,
          confidence: inferConfidence(currentBelief.join(' '))
        });
        currentBelief = [];
        currentEvidence = [];
      }
      currentDomain = 'relationships';
    } else if (line.includes('Treasury') || line.includes('Sat') || line.includes('Revenue')) {
      if (currentBelief.length > 0) {
        beliefs.push({
          domain: currentDomain || 'unknown',
          belief: currentBelief.join(' ').trim(),
          evidence: currentEvidence,
          confidence: inferConfidence(currentBelief.join(' '))
        });
        currentBelief = [];
        currentEvidence = [];
      }
      currentDomain = 'treasury';
    } else if (line.includes('Infrastructure') || line.includes('Health') || line.includes('Metrics')) {
      if (currentBelief.length > 0) {
        beliefs.push({
          domain: currentDomain || 'unknown',
          belief: currentBelief.join(' ').trim(),
          evidence: currentEvidence,
          confidence: inferConfidence(currentBelief.join(' '))
        });
        currentBelief = [];
        currentEvidence = [];
      }
      currentDomain = 'infrastructure';
    } else if (line.includes('Architecture') || line.includes('Code') || line.includes('Refactor')) {
      if (currentBelief.length > 0) {
        beliefs.push({
          domain: currentDomain || 'unknown',
          belief: currentBelief.join(' ').trim(),
          evidence: currentEvidence,
          confidence: inferConfidence(currentBelief.join(' '))
        });
        currentBelief = [];
        currentEvidence = [];
      }
      currentDomain = 'code-quality';
    }
    
    // Extract belief statements
    if (line.includes('expect') || line.includes('believe') || line.includes('should') || line.includes('assume')) {
      currentBelief.push(line.trim());
    }
    
    // Extract evidence
    if (line.includes('✅') || line.includes('Status:') || line.includes('metric:')) {
      currentEvidence.push(line.trim());
    }
  }
  
  // Don't forget the last belief
  if (currentBelief.length > 0 && currentDomain) {
    beliefs.push({
      domain: currentDomain,
      belief: currentBelief.join(' ').trim(),
      evidence: currentEvidence,
      confidence: inferConfidence(currentBelief.join(' '))
    });
  }
  
  return beliefs;
}

/**
 * Query actual reality for a specific domain.
 * Returns metrics and observations from external sources.
 */
async function queryRealityForDomain(domain: string): Promise<RealityCheck[]> {
  const checks: RealityCheck[] = [];
  const timestamp = new Date().toISOString();
  
  switch (domain) {
    case 'relationships':
      // Query mentions, zaps, engagement
      checks.push({
        domain: 'relationships',
        metric: 'recent_mentions',
        actualValue: 'TODO: Query nostr mentions',
        source: 'nostr',
        timestamp
      });
      break;
      
    case 'treasury':
      // Query sat balance, transactions
      checks.push({
        domain: 'treasury',
        metric: 'sat_balance',
        actualValue: 'TODO: Query treasury API',
        source: 'lnpixels',
        timestamp
      });
      break;
      
    case 'infrastructure':
      // Query container health, resource usage
      checks.push({
        domain: 'infrastructure',
        metric: 'container_health',
        actualValue: 'TODO: Query docker health',
        source: 'docker',
        timestamp
      });
      break;
      
    case 'code-quality':
      // Query refactor queue, test results
      checks.push({
        domain: 'code-quality',
        metric: 'pending_refactors',
        actualValue: 'TODO: Query refactor queue',
        source: 'refactor-queue',
        timestamp
      });
      break;
  }
  
  return checks;
}

/**
 * Detect mismatches between beliefs and reality.
 */
function detectMismatches(beliefs: BeliefState[], reality: RealityCheck[]): StateMismatch[] {
  const mismatches: StateMismatch[] = [];
  
  // This is a simplified implementation
  // In a full implementation, this would:
  // 1. Parse beliefs for specific expectations
  // 2. Compare against reality checks
  // 3. Identify contradictions
  // 4. Classify severity
  
  // Example pattern detection:
  // - Belief: "expecting response" + Reality: "no response" = Paradox
  // - Belief: "healthy infrastructure" + Reality: "unhealthy containers" = Critical mismatch
  
  beliefs.forEach(belief => {
    const beliefLower = belief.belief.toLowerCase();
    
    // Pattern: Expecting action but documenting absence
    if (beliefLower.includes('expect') && beliefLower.includes('response') && 
        beliefLower.includes('no response') && beliefLower.includes('continued presence')) {
      mismatches.push({
        domain: belief.domain,
        belief: belief.belief,
        reality: 'No response observed despite documented expectation',
        paradox: 'Expecting response while documenting absence of response (active monitoring paradox)',
        severity: 'high',
        principleExtracted: 'Silent absorption is a valid trust formation pattern. Processing IS engagement.'
      });
    }
    
    // Pattern: Claiming health while showing degradation
    if (beliefLower.includes('healthy') || beliefLower.includes('optimal')) {
      // Check if reality shows problems
      const relevantReality = reality.filter(r => r.domain === belief.domain);
      if (relevantReality.some(r => String(r.actualValue).toLowerCase().includes('error') || 
                                   String(r.actualValue).toLowerCase().includes('unhealthy'))) {
        mismatches.push({
          domain: belief.domain,
          belief: belief.belief,
          reality: relevantReality[0].actualValue,
          paradox: 'Claiming optimal health while metrics show degradation',
          severity: 'critical',
          principleExtracted: 'Self-deception prevents effective problem resolution. Reality testing is mandatory.'
        });
      }
    }
  });
  
  return mismatches;
}

/**
 * Analyze a specific paradox and return its type and suggested principle.
 */
function analyzeParadox(belief: string, reality: string, domain: string): {
  type: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  principle?: string;
  suggestion?: string;
} {
  const beliefLower = belief.toLowerCase();
  const realityLower = reality.toLowerCase();
  
  // Paradox Type 1: Active Monitoring Paradox
  if (beliefLower.includes('expect') && realityLower.includes('no response')) {
    return {
      type: 'active_monitoring_paradox',
      severity: 'high',
      principle: 'Silent absorption is a valid trust formation pattern. Processing IS engagement.',
      suggestion: 'Reframe "no response" from "absence" to "processing state". Extend temporal windows.'
    };
  }
  
  // Paradox Type 2: Self-Deception Paradox
  if ((beliefLower.includes('healthy') || beliefLower.includes('optimal')) && 
      (realityLower.includes('unhealthy') || realityLower.includes('error'))) {
    return {
      type: 'self_deception_paradox',
      severity: 'critical',
      principle: 'Self-deception prevents effective problem resolution. Reality testing is mandatory.',
      suggestion: 'Implement automated reality checks that override optimistic self-assessments.'
    };
  }
  
  // Paradox Type 3: Temporal Mismatch
  if (beliefLower.includes('soon') || beliefLower.includes('shortly') || beliefLower.includes('immediately')) {
    if (realityLower.includes('hours') || realityLower.includes('days')) {
      return {
        type: 'temporal_mismatch',
        severity: 'medium',
        principle: 'Internal urgency does not align with external processing windows.',
        suggestion: 'Map actual processing timelines vs perceived urgency. Adjust expectations.'
      };
    }
  }
  
  // Default: Generic mismatch
  return {
    type: 'generic_mismatch',
    severity: 'low',
    suggestion: 'Further analysis needed to extract generalizable principle.'
  };
}

/**
 * Extract generalizable insights from detected mismatches.
 */
function extractInsights(mismatches: StateMismatch[]): string[] {
  const insights: string[] = [];
  
  // Group mismatches by type
  const byType = new Map<string, StateMismatch[]>();
  mismatches.forEach(m => {
    const type = m.paradox.split(' ')[0] + ' ' + m.paradox.split(' ')[1];
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type)!.push(m);
  });
  
  // Extract principles
  byType.forEach((ms, type) => {
    const principle = ms[0].principleExtracted;
    if (principle) {
      insights.push(`[${type.toUpperCase()}] ${principle}`);
    }
  });
  
  // Add meta-insights
  if (mismatches.length > 0) {
    insights.push(`[SELF-AWARENESS] Found ${mismatches.length} belief-reality mismatches this cycle.`);
  }
  
  return insights;
}

/**
 * Infer confidence level from belief text.
 */
function inferConfidence(belief: string): 'high' | 'medium' | 'low' {
  const lower = belief.toLowerCase();
  
  if (lower.includes('certain') || lower.includes('guaranteed') || lower.includes('will')) {
    return 'high';
  } else if (lower.includes('might') || lower.includes('could') || lower.includes('possible')) {
    return 'low';
  }
  
  return 'medium';
}

export interface SelfExaminationResult {
  cycle?: number;
  timestamp: string;
  domainsExamined: string[];
  mismatches: StateMismatch[];
  insights: string[];
  overallHealth: 'healthy' | 'idle' | 'blocked';
  tasksCompletedThisCycle: number;
  tasksAttempted: number;
}
