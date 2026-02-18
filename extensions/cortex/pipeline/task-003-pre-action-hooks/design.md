# Technical Design - Pre-Action Hook System

**Task ID**: task-003-pre-action-hooks  
**Version**: 1.0  
**Date**: 2026-02-18  
**Role**: Design Specialist Agent  
**Input**: requirements.md

## Approach Summary

Transform Helios from voluntary knowledge consultation to **mandatory** pre-execution checks by enhancing the existing `before_tool_call` hook system. The key architectural principle: **intercept first, discover knowledge, force acknowledgment, then proceed**.

**Core Design Pattern**:

```
Tool Call → Context Extraction → Knowledge Discovery → Mandatory Injection → Acknowledgment → Execution
    ↑              ↑                    ↑                    ↑               ↑            ↑
(Any Tool)   (Smart Keywords)    (SOP + Cortex)      (Block with Info)   (Retry)   (Original Intent)
```

**Enhancement Strategy**: Extend the existing SOP enforcement hook (lines 672-880 in `index.ts`) to support universal tool interception, intelligent context extraction, and multi-source knowledge discovery.

## Files to Create/Modify

### Files to CREATE

#### 1. `~/Projects/helios/extensions/cortex/hooks/knowledge-discovery.ts`

**Purpose**: Core knowledge discovery engine for pre-action hooks

```typescript
export interface KnowledgeContext {
  toolName: string;
  params: Record<string, unknown>;
  keywords: string[];
  projectPath?: string;
  serviceType?: string;
  hostTarget?: string;
  workingDir?: string;
  urlHost?: string;
}

export interface KnowledgeResult {
  sopFiles: Array<{ label: string; path: string; content: string }>;
  memories: Array<{ id: string; content: string; confidence: number; category: string }>;
  totalSources: number;
  lookupTimeMs: number;
}

export class KnowledgeDiscovery {
  async extractContext(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<KnowledgeContext>;
  async discoverSOPs(context: KnowledgeContext): Promise<SopResult[]>;
  async discoverMemories(
    context: KnowledgeContext,
    confidenceThreshold: number,
  ): Promise<MemoryResult[]>;
  async parallelLookup(context: KnowledgeContext, options: LookupOptions): Promise<KnowledgeResult>;
}
```

#### 2. `~/Projects/helios/extensions/cortex/hooks/context-extractor.ts`

**Purpose**: Intelligent context extraction from tool call parameters

```typescript
export interface ContextPattern {
  pattern: RegExp;
  extractor: (match: RegExpMatchArray, params: Record<string, unknown>) => string[];
  priority: number;
}

export class ContextExtractor {
  private patterns: Map<string, ContextPattern[]> = new Map();

  // Enhanced patterns beyond current SOP_PATTERNS
  private initializePatterns(): void {
    // Project detection: /Projects/{name} → extract project name
    // Service detection: comfyui, flux, docker, etc. → extract service type
    // Host detection: IPs, hostnames → extract target host
    // URL detection: browser calls → extract hostname and path
    // Command detection: exec calls → extract primary command and flags
  }

  async extractKeywords(toolName: string, params: Record<string, unknown>): Promise<string[]>;
  async detectProject(params: Record<string, unknown>): Promise<string | null>;
  async detectService(params: Record<string, unknown>): Promise<string | null>;
  async detectHost(params: Record<string, unknown>): Promise<string | null>;
}
```

#### 3. `~/Projects/helios/extensions/cortex/hooks/enforcement-engine.ts`

**Purpose**: Enforcement logic with configurable levels and cooldown management

```typescript
export enum EnforcementLevel {
  DISABLED = "disabled",
  ADVISORY = "advisory",
  CATEGORY = "category",
  STRICT = "strict",
}

export interface EnforcementConfig {
  level: EnforcementLevel;
  categoryRules: Map<string, EnforcementLevel>; // Override per category
  cooldownMs: number;
  confidenceThresholds: Map<string, number>; // Per operation type
  emergencyBypass: boolean;
}

export class EnforcementEngine {
  private recentInjections = new Map<string, number>();

  async shouldBlock(
    context: KnowledgeContext,
    knowledge: KnowledgeResult,
    config: EnforcementConfig,
  ): Promise<{ block: boolean; reason?: string }>;

  async formatKnowledgeInjection(knowledge: KnowledgeResult): Promise<string>;
  async trackInjection(key: string): void;
  async checkCooldown(key: string, cooldownMs: number): Promise<boolean>;
}
```

#### 4. `~/Projects/helios/extensions/cortex/hooks/sop-enhancer.ts`

**Purpose**: Enhanced SOP pattern matching beyond current 6 patterns

```typescript
export interface SOPPattern {
  pattern: RegExp;
  sopPaths: string[];
  label: string;
  priority: number;
  sections: string[]; // Which sections to extract
}

export class SOPEnhancer {
  // Extend current SOP_PATTERNS with 20+ new patterns
  private patterns: SOPPattern[] = [
    // Current 6 patterns + 15 new ones:
    // Git operations, Python environments, SSH tunneling, Database operations,
    // API integrations, File system operations, Network diagnostics, etc.
  ];

  async findRelevantSOPs(
    context: KnowledgeContext,
  ): Promise<Array<{ label: string; path: string; content: string }>>;
  async extractSOPSections(content: string, sections: string[]): Promise<string>;
  async cacheSOPContent(path: string): Promise<void>; // Performance optimization
}
```

#### 5. `~/Projects/helios/extensions/cortex/config/pre-action-hooks.json`

**Purpose**: Configuration file for enforcement levels and patterns

```json
{
  "version": "2.0.0",
  "enforcement": {
    "level": "category",
    "cooldown_minutes": 5,
    "emergency_bypass": false,
    "confidence_thresholds": {
      "critical": 0.8,
      "routine": 0.5,
      "experimental": 0.2
    }
  },
  "category_rules": {
    "process": "strict",
    "security": "strict",
    "credentials": "strict",
    "technical": "advisory",
    "gotchas": "category",
    "general": "advisory"
  },
  "performance": {
    "max_lookup_ms": 150,
    "cache_ttl_minutes": 30,
    "parallel_queries": true
  }
}
```

### Files to MODIFY

#### 1. `~/Projects/helios/extensions/cortex/index.ts`

**Lines to modify**: ~672-880 (current SOP hook), ~2478 (hook registration)

**Major Changes**:

```typescript
// Replace existing SOP hook with universal pre-action hook
import { KnowledgeDiscovery } from "./hooks/knowledge-discovery.js";
import { EnforcementEngine, EnforcementLevel } from "./hooks/enforcement-engine.js";

// Enhanced before_tool_call hook
api.on(
  "before_tool_call",
  async (event, _ctx) => {
    // UNIVERSAL TOOL INTERCEPTION (not just exec/nodes)
    const targetTools = config.interceptTools || ["exec", "nodes", "browser", "message"];
    if (!targetTools.includes(event.toolName)) {
      return;
    }

    try {
      // STEP 1: Extract context from tool call
      const context = await knowledgeDiscovery.extractContext(event.toolName, event.params);

      // STEP 2: Parallel knowledge lookup (SOPs + memories)
      const knowledge = await knowledgeDiscovery.parallelLookup(context, {
        confidenceThreshold: getConfidenceThreshold(context),
        maxLookupMs: 150,
        includeCategories: ["process", "technical", "security", "gotchas", "credentials"],
      });

      // STEP 3: Enforcement decision
      const enforcement = await enforcementEngine.shouldBlock(
        context,
        knowledge,
        enforcementConfig,
      );

      // STEP 4: Metrics and logging
      await writeMetric("sop", {
        sop_name: context.serviceType || "generic",
        tool_blocked: enforcement.block,
        tool_name: event.toolName,
        acknowledged: false,
        knowledge_sources: knowledge.totalSources,
        lookup_time_ms: knowledge.lookupTimeMs,
      });

      if (enforcement.block) {
        return {
          block: true,
          blockReason: await enforcementEngine.formatKnowledgeInjection(knowledge),
        };
      }
    } catch (err) {
      // Fail-open: don't block on hook errors
      api.logger.debug?.(`Pre-action hook error: ${err}`);
      return;
    }
  },
  { priority: 95 },
); // High priority, before existing SOP hook
```

#### 2. `~/Projects/helios/extensions/cortex/cortex-bridge.ts`

**Lines to modify**: Memory search functions (~200-400)

**Changes**:

```typescript
// Add confidence-based memory search for pre-action hooks
async searchMemoriesWithConfidence(
  query: string,
  categories: string[],
  minConfidence: number,
  limit: number = 10
): Promise<Array<{ id: string; content: string; confidence: number; category: string }>>

// Add category-focused search
async searchByCategory(
  categories: string[],
  keywords: string[],
  limit: number = 20
): Promise<MemorySearchResult[]>
```

#### 3. `~/Projects/helios/extensions/cortex/python/cortex_bridge.py`

**Lines to modify**: Memory query functions

**Changes**:

```python
def search_memories_with_confidence(self, query: str, categories: List[str], min_confidence: float, limit: int) -> List[Dict]:
    """Enhanced memory search with confidence filtering for pre-action hooks"""

def search_by_category(self, categories: List[str], keywords: List[str], limit: int) -> List[Dict]:
    """Category-focused search for relevant process memories"""
```

## Data Model Changes

### Enhanced Context Extraction

Current SOP system only extracts basic patterns. New system extracts comprehensive context:

```typescript
interface EnhancedContext {
  // Current: basic pattern matching
  toolName: string;
  paramString: string;

  // New: structured context extraction
  keywords: string[]; // Smart keyword extraction
  projectPath?: string; // /Projects/{name} detection
  serviceType?: string; // comfyui, docker, augur, etc.
  hostTarget?: string; // IP addresses, hostnames
  workingDir?: string; // pwd from exec calls
  urlHost?: string; // hostname from browser calls
  commandType?: string; // primary command from exec
  riskLevel: "low" | "medium" | "high" | "critical"; // Based on operation type
}
```

### Knowledge Discovery Results

```typescript
interface KnowledgeResult {
  // SOP discovery (enhanced from current 6 patterns to 20+)
  sopFiles: Array<{
    label: string;
    path: string;
    content: string; // Extracted sections only (preflight, gotchas, credentials)
    priority: number;
    matchedPattern: string;
  }>;

  // Memory discovery (new capability)
  memories: Array<{
    id: string;
    content: string;
    confidence: number; // From Cortex v1.2.0+ confidence scoring
    category: string; // process, technical, security, gotchas, credentials
    lastAccessed: string;
    accessCount: number;
  }>;

  // Performance metrics
  totalSources: number;
  lookupTimeMs: number;
  cacheHits: number;
}
```

## API/Interface Changes

### New Hook Registration Options

```typescript
// Enhanced hook registration with configuration
api.registerPreActionHook({
  tools: ["exec", "nodes", "browser", "message"],
  enforcement: EnforcementLevel.CATEGORY,
  categories: {
    process: EnforcementLevel.STRICT,
    security: EnforcementLevel.STRICT,
    technical: EnforcementLevel.ADVISORY,
  },
  confidenceThresholds: {
    critical: 0.8,
    routine: 0.5,
  },
  cooldownMs: 300000, // 5 minutes
  maxLookupMs: 150,
});
```

### Enhanced Tool Call Blocking

Current blocking is binary (block/allow). Enhanced system provides structured information:

```typescript
interface EnhancedBlockResult {
  block: boolean;
  blockReason: string;
  metadata: {
    sopCount: number;
    memoryCount: number;
    confidenceRange: [number, number];
    categories: string[];
    lookupTimeMs: number;
    canBypass: boolean;
  };
}
```

## Integration Points with Existing Systems

### 1. Current SOP Hook Enhancement

**Location**: Lines 672-880 in `index.ts`

**Integration Strategy**:

- Replace current hook with enhanced version
- Maintain backward compatibility for existing SOPs
- Extend pattern matching from 6 to 20+ patterns
- Add memory integration alongside SOP checking

**Data Flow**:

```
Current: Tool Call → SOP Pattern Match → Block with SOP Content
Enhanced: Tool Call → Context Extract → Parallel(SOP + Memory) → Block with Full Knowledge
```

### 2. Cortex Memory System Integration

**Hook Points**:

- `cortex-bridge.ts` memory search functions
- Python bridge for confidence-based queries
- STM integration for recent context

**Data Flow**:

```
Pre-Action Hook → Context Keywords → Cortex Search(categories, confidence) → Filter Results
```

### 3. Metrics System Integration

**Existing**: Lines ~25-65 (`writeMetric` function)

**Enhancement**:

```typescript
// Current metrics
writeMetric("sop", { sop_name, tool_blocked, tool_name, acknowledged });

// Enhanced metrics
writeMetric("sop", {
  sop_name,
  tool_blocked,
  tool_name,
  acknowledged,
  knowledge_sources: number,    // NEW: total sources found
  lookup_time_ms: number,       // NEW: performance tracking
  confidence_range: [min, max], // NEW: memory confidence range
  categories: string[]          // NEW: triggered categories
});
```

### 4. Configuration System Integration

**Current**: Plugin configuration via OpenClaw schema

**Enhancement**: Add pre-action hook configuration section:

```typescript
const configSchema = Type.Object({
  // Existing config...
  preActionHooks: Type.Object({
    enabled: Type.Boolean({ default: true }),
    enforcement: Type.Enum(EnforcementLevel, { default: EnforcementLevel.CATEGORY }),
    interceptTools: Type.Array(Type.String(), { default: ["exec", "nodes", "browser"] }),
    confidenceThresholds: Type.Object({
      critical: Type.Number({ default: 0.8 }),
      routine: Type.Number({ default: 0.5 }),
      experimental: Type.Number({ default: 0.2 }),
    }),
  }),
});
```

## Risk Assessment

### HIGH RISK: Performance Impact on All Tool Calls

**Problem**: Adding knowledge lookup to every tool call could significantly slow operations
**Mitigation Strategy**:

1. **Parallel Queries**: SOP and memory lookups run concurrently
2. **Aggressive Caching**: Cache SOP content and frequent memory queries
3. **Timeout Protection**: Hard 150ms timeout with fallback to existing behavior
4. **Selective Interception**: Only intercept high-risk tool types by default

**Implementation**:

```typescript
async parallelLookup(context: KnowledgeContext, maxMs: number = 150): Promise<KnowledgeResult> {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Lookup timeout')), maxMs)
  );

  const sopPromise = this.discoverSOPs(context);
  const memoryPromise = this.discoverMemories(context, confidenceThreshold);

  try {
    const [sopResults, memoryResults] = await Promise.race([
      Promise.all([sopPromise, memoryPromise]),
      timeout
    ]);
    return { sopFiles: sopResults, memories: memoryResults, lookupTimeMs: Date.now() - startTime };
  } catch (err) {
    // Fallback to existing SOP behavior only
    return await this.fallbackSOPOnly(context);
  }
}
```

### MEDIUM RISK: False Positives in Context Extraction

**Problem**: Context extraction might trigger irrelevant SOPs/memories  
**Mitigation Strategy**:

1. **Confidence Scoring**: Only show memories above threshold
2. **Keyword Ranking**: Prioritize high-confidence keywords
3. **User Feedback**: Learn from acknowledgment patterns
4. **Gradual Rollout**: Start with ADVISORY mode, upgrade to STRICT

### MEDIUM RISK: Knowledge Discovery Latency

**Problem**: Cortex memory search + SOP file reading could exceed 150ms target
**Mitigation Strategy**:

1. **Memory Pre-fetching**: Cache recent category searches
2. **SOP Content Caching**: Keep frequent SOPs in memory
3. **Index Optimization**: Ensure database indexes support category queries
4. **Background Refresh**: Update caches during idle time

### LOW RISK: Configuration Complexity

**Problem**: Many configuration options might confuse users
**Mitigation Strategy**:

1. **Sensible Defaults**: CATEGORY enforcement with proven thresholds
2. **Configuration Validation**: Validate config on startup
3. **Documentation**: Clear examples for common scenarios

## Estimated Complexity: EXTRA LARGE (XL)

**Reasoning**:

- **Universal Tool Interception**: Affects ALL tool calls, not just exec/nodes
- **Multi-Source Integration**: SOPs + Cortex + confidence scoring + categories
- **Performance-Critical**: Must not slow down normal operations
- **Complex Context Extraction**: Smart keyword detection across different tool types
- **Configuration Management**: Multiple enforcement levels and category rules
- **Backward Compatibility**: Must not break existing SOP enforcement

**Effort Breakdown**:

- Context extraction system: 25%
- Knowledge discovery engine: 30%
- Enforcement engine integration: 20%
- Performance optimization: 15%
- Testing and validation: 10%

**Dependencies**:

- Cortex v1.3.0 confidence scoring system
- Existing SOP hook architecture (lines 672-880)
- Metrics system for tamper-evident logging
- OpenClaw plugin hook system

## Success Metrics

### Technical Metrics

- **Interception Coverage**: 100% of target tool calls intercepted
- **Performance Impact**: <150ms additional latency per tool call (95th percentile)
- **Knowledge Discovery Accuracy**: 90%+ relevant SOP/memory matches
- **Cache Hit Rate**: 80%+ for repeated patterns
- **Failure Recovery**: 100% fail-open rate (never break tool execution)

### Business Metrics

- **Knowledge Utilization**: 5x increase in SOP/memory consultation before tool execution
- **Error Prevention**: Measurable reduction in repeated mistakes (tracked via metrics)
- **Agent Compliance**: >90% acknowledgment rate for injected knowledge
- **Configuration Adoption**: All enforcement levels functional and documented

## Next Steps for Implementation

1. **Document Stage**: Update architecture documentation with pre-action hook design
2. **Build Stage**: Implement knowledge discovery engine and enhanced context extraction
3. **Security Review**: Verify fail-open behavior and emergency bypass functionality
4. **Test Stage**: Performance testing, accuracy validation, and regression testing
5. **Deploy Stage**: Gradual rollout with ADVISORY mode first, then CATEGORY enforcement
