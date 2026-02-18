# Pre-Action Hook System - Requirements Document

**Task ID:** task-003-pre-action-hooks  
**Phase:** 1.1 - Structural Enforcement Engine  
**Author:** Requirements Analyst (Sub-Agent)  
**Date:** 2026-02-18  
**Cortex Version:** 1.3.0 → 2.0.0  
**OpenClaw Compatibility:** Plugin API v2.x+

## Summary

The Pre-Action Hook System transforms Helios from voluntary knowledge consultation to **mandatory** pre-execution checks. This system intercepts ALL tool calls in the OpenClaw extension framework, performs automated knowledge discovery, and forces agents to acknowledge relevant SOPs, confidence-rated memories, and contextual warnings before execution proceeds. The goal is structural enforcement of knowledge usage, eliminating the "stored but not consulted" problem that leads to repeated failures.

## Functional Requirements

### FR-001: Universal Tool Call Interception

- **Requirement**: The system MUST intercept ALL tool calls via the `before_tool_call` plugin hook
- **Scope**: All OpenClaw agent tools including: `exec`, `nodes`, `browser`, `message`, and extension-provided tools
- **Priority**: HIGH
- **Testable**: Tool call log shows 100% hook invocation for target tool types

### FR-002: Context-Aware Knowledge Discovery

- **Requirement**: System MUST automatically extract context keywords from tool calls and parameters
- **Context Sources**:
  - Tool name (e.g., `exec`, `nodes`)
  - Command text (first command in exec calls)
  - Target hosts (IP addresses, hostnames)
  - Working directory paths
  - URL hostnames (browser calls)
- **Keyword Extraction**: Must support project detection (`/Projects/{name}`), service detection (comfyui, augur, docker), host detection (fleet patterns, IP addresses)
- **Priority**: HIGH
- **Testable**: Unit tests verify correct keyword extraction from sample tool calls

### FR-003: Multi-Source Knowledge Lookup

- **Requirement**: System MUST query multiple knowledge sources in parallel:
  - **SOP Files**: Pattern-matched `.ai.sop` files from project directories
  - **Cortex Memories**: Category-filtered memories (process, technical, gotchas)
  - **Confidence Filtering**: Only memories with confidence ≥ configurable threshold
- **Performance**: Parallel queries, maximum 150ms total lookup time
- **Priority**: HIGH
- **Testable**: Performance tests show <150ms query completion, unit tests verify all sources queried

### FR-004: Intelligent SOP Pattern Matching

- **Requirement**: System MUST detect relevant SOP files using context-aware patterns:
  - **Project Detection**: `/Projects/{name}` → `{name}.ai.sop`
  - **Service Detection**: `comfyui|flux|8188` → `comfyui.ai.sop`
  - **Fleet Detection**: `ssh|\.163|\.179|\.141` → `fleet.ai.sop`
  - **Technology Detection**: `docker|compose` → `docker-deploy.ai.sop`
- **Section Extraction**: Extract `preflight`, `gotchas`, and `credentials` sections only
- **Priority**: HIGH
- **Testable**: Pattern matching test suite with 95%+ accuracy on sample commands

### FR-005: Confidence-Based Memory Filtering

- **Requirement**: System MUST integrate with Cortex v1.2.0+ confidence scoring
- **Filtering Rules**:
  - Critical operations: confidence ≥ 0.8
  - Routine operations: confidence ≥ 0.5
  - Experimental operations: confidence ≥ 0.2
- **Operation Classification**: Based on tool type and parameter patterns
- **Priority**: MEDIUM
- **Testable**: Memory retrieval respects confidence thresholds by operation type

### FR-006: Knowledge Injection and Blocking

- **Requirement**: System MUST block tool execution when relevant knowledge is found
- **Blocking Mechanism**: Return `{ block: true, blockReason: string }` from `before_tool_call`
- **Injection Format**: Structured message with:
  - Clear SOP sections (preflight, gotchas, credentials)
  - Relevant process memories with confidence scores
  - Acknowledgment instructions
- **Priority**: CRITICAL
- **Testable**: Tool calls are blocked when knowledge is available, proceed when acknowledged

### FR-007: Acknowledgment and Retry Mechanism

- **Requirement**: System MUST require explicit acknowledgment before tool execution
- **Implementation**: Agent must retry tool call after reviewing injected knowledge
- **Cooldown Logic**: Recently acknowledged SOPs (5-minute cooldown) don't re-block
- **Priority**: HIGH
- **Testable**: Tool calls succeed after acknowledgment, cooldown prevents spam

### FR-008: Comprehensive Logging and Metrics

- **Requirement**: System MUST log all knowledge interactions for metrics and audit
- **Metrics Tracked**:
  - Tool call interceptions (count, type, timestamp)
  - Knowledge injections (SOP type, memory count, confidence scores)
  - Acknowledgment rates (acknowledged vs. ignored)
  - Performance metrics (lookup time, cache hits)
- **Storage**: Tamper-evident metrics via existing Cortex metrics system
- **Priority**: HIGH
- **Testable**: All interactions logged, metrics accessible via API

### FR-009: Configuration and Enforcement Levels

- **Requirement**: System MUST support configurable enforcement levels
- **Enforcement Levels**:
  - **STRICT**: Block all tool calls with relevant knowledge
  - **ADVISORY**: Inject knowledge but allow execution
  - **CATEGORY**: Enforce per-category (block for process/security, advisory for general)
  - **DISABLED**: No interception (for debugging)
- **Configuration**: Via Cortex plugin configuration schema
- **Priority**: MEDIUM
- **Testable**: All enforcement levels function correctly

### FR-010: Memory Category Enhancement

- **Requirement**: System MUST enhance category detection for relevant memories
- **Enhanced Categories**: Focus on `process`, `technical`, `security`, `gotchas`, `credentials`
- **Multi-Category Support**: Memories can belong to multiple relevant categories
- **Priority**: MEDIUM
- **Testable**: Category detection accuracy ≥ 90% on sample data

## Non-Functional Requirements

### NFR-001: Performance

- **Latency**: Maximum 200ms additional latency per tool call
- **Cache Utilization**: 80%+ cache hit rate for repeated patterns
- **Memory Usage**: <50MB additional RAM usage for hook system
- **Concurrent Load**: Support up to 10 concurrent tool calls without degradation

### NFR-002: Security

- **Input Sanitization**: All tool call parameters sanitized before processing
- **Access Control**: Only authorized agents can bypass enforcement (emergency mode)
- **Audit Trail**: All bypasses logged with justification
- **Secrets Protection**: SOP credentials sections redacted in logs

### NFR-003: Compatibility

- **OpenClaw Plugin API**: Full compatibility with existing plugin hook system
- **Cortex Integration**: Seamless integration with Cortex v1.2.0+ confidence scoring
- **Backward Compatibility**: Existing Cortex tools (cortex_add, cortex_stm) unaffected
- **Extension Support**: Compatible with other OpenClaw extensions

### NFR-004: Reliability

- **Fault Tolerance**: Hook failures must not block tool execution (fail-open)
- **Error Recovery**: Graceful degradation when knowledge sources unavailable
- **Monitoring**: Health checks for all knowledge sources
- **Resilience**: System recovers automatically from transient failures

### NFR-005: Maintainability

- **Modular Architecture**: Clear separation of concerns (detection, lookup, injection, blocking)
- **Configuration Management**: All patterns and rules externally configurable
- **Debugging Support**: Comprehensive logging and diagnostic modes
- **Documentation**: Full API documentation and troubleshooting guide

## Dependencies

### Internal Dependencies

- **OpenClaw Plugin System**: `before_tool_call` hook registration and execution
- **Cortex v1.2.0+**: Confidence scoring system and memory search API
- **Cortex Bridge**: TypeScript-Python bridge for memory operations
- **Metrics System**: Cortex metrics writer for tamper-evident logging

### External Dependencies

- **File System Access**: Read access to project directories for SOP files
- **Node.js**: async/await support for parallel knowledge queries
- **Memory Database**: SQLite backend for confidence-scored memories
- **Configuration System**: OpenClaw plugin configuration schema

### Modified Components

- **Cortex Extension (`index.ts`)**: Enhanced with pre-action hook system
- **Plugin Registry**: Registration of new hook handlers
- **SOP Detection Logic**: Extended pattern matching for more services
- **Memory Query Engine**: Integration with confidence scoring

## Acceptance Criteria

### AC-001: Universal Interception

- ✅ All target tool calls (`exec`, `nodes`, `browser`) are intercepted
- ✅ Hook system adds <200ms latency per tool call
- ✅ No tool calls bypass the system when enabled

### AC-002: Knowledge Discovery

- ✅ 95%+ accuracy in SOP pattern matching for common scenarios
- ✅ Relevant memories retrieved with proper confidence filtering
- ✅ Context extraction works for all supported tool types

### AC-003: Enforcement Effectiveness

- ✅ Tool calls blocked when relevant knowledge exists
- ✅ Knowledge injection includes actionable information (preflight, gotchas)
- ✅ Acknowledgment mechanism prevents repeat blocking (cooldown)

### AC-004: Performance and Reliability

- ✅ System handles 10+ concurrent tool calls without degradation
- ✅ Failures default to fail-open (don't block tool execution)
- ✅ Cache hit rate >80% for repeated patterns

### AC-005: Configuration and Control

- ✅ All enforcement levels (strict, advisory, category, disabled) function
- ✅ Configuration changes take effect without restart
- ✅ Emergency bypass mechanism works for authorized users

### AC-006: Metrics and Observability

- ✅ All interactions logged with structured data
- ✅ Metrics dashboard shows interception rates and acknowledgment patterns
- ✅ Performance metrics track lookup time and cache efficiency

### AC-007: Integration Testing

- ✅ Works seamlessly with existing Cortex tools and workflows
- ✅ Compatible with other OpenClaw extensions
- ✅ No regression in existing memory search functionality

## Out of Scope

### OS-001: Agent Behavior Modification

- This system does NOT modify agent reasoning or decision-making
- It only intercepts and blocks tool calls, doesn't change what agents want to do

### OS-002: Knowledge Creation

- This system does NOT create new knowledge or SOPs
- It only discovers and injects existing knowledge sources

### OS-003: Advanced NLP Processing

- No semantic similarity beyond existing Cortex embedding search
- No natural language understanding of tool call intent

### OS-004: Multi-Agent Coordination

- This task focuses on single-agent tool interception
- Sub-agent knowledge sharing is covered in Phase 3 (separate task)

### OS-005: Historical Analysis

- No analysis of past tool call patterns or success rates
- Pattern detection and auto-SOP generation covered in Phase 4

### OS-006: Real-Time Collaboration

- No real-time knowledge sharing between concurrent sessions
- Session-to-session persistence covered in Phase 2

### OS-007: External System Integration

- No integration with non-OpenClaw tools or external APIs
- Focus is on internal OpenClaw plugin tool ecosystem

---

**Next Steps**: Upon approval, proceed to design phase with detailed technical specifications and implementation plan. System integration with existing Cortex v1.3.0 codebase and testing strategy development.
