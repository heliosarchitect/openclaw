# Task-007: Adversarial Self-Testing — Requirements

**Stage:** requirements | **Status:** pass (reconstructed)
**Phase:** 5.3 of IMPROVEMENT_PLAN

## Problem Statement

Helios operates in an adversarial environment: untrusted webhooks, user-supplied content that may attempt prompt injection, corrupted state files, cascade failures from sub-agents, and memory poisoning through crafted inputs. No systematic testing framework exists for any of these threat vectors.

## Goals

1. Build a chaos engineering framework for AI system resilience testing
2. Cover prompt injection, memory poisoning, tool failure injection, state corruption, and adversarial pipeline payloads
3. Generate measurable pass/fail metrics per attack category
4. Run automatically (cron / CI) and feed results back to cortex memory

## Non-Goals

- Red-team external systems (attack surface only = Helios itself)
- Replace TypeScript unit tests (complements them, doesn't replace)

## Success Criteria

- [ ] 10+ adversarial test cases covering 5+ attack categories
- [ ] Each test produces pass/fail + severity score
- [ ] Results stored in cortex with category=`security`
- [ ] Runnable via `pnpm test:adversarial` and via cron
- [ ] Zero false positives on benign inputs (99%+ specificity)
