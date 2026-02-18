# .ai.sop Index

> Auto-maintained registry of all AI Standard Operating Procedures across LBF projects.
> Last updated: 2026-02-17

## SOP Files

| SOP                         | Project            | Path                                       | Purpose                                            |
| --------------------------- | ------------------ | ------------------------------------------ | -------------------------------------------------- |
| `comfyui.ai.sop`            | ComfyUI            | `~/Projects/ComfyUI/`                      | Image generation via Flux on blackview (.163)      |
| `ft991a.ai.sop`             | lbf-ham-radio      | `~/Projects/lbf-ham-radio/`                | FT-991A rig control on radio.fleet.wood (.179)     |
| `fleet.ai.sop`              | lbf-infrastructure | `~/Projects/lbf-infrastructure/`           | Fleet machine access (SSH, ports, services)        |
| `augur.ai.sop`              | augur-trading      | `~/Projects/augur-trading/`                | Augur crypto trading bot operations                |
| `versioning.ai.sop`         | cortex/sop         | `~/Projects/helios/extensions/cortex/sop/` | Semver + Google Sheet registry bump flow           |
| `documentation.ai.sop`      | cortex/sop         | `~/Projects/helios/extensions/cortex/sop/` | Documentation standards (lbf-templates)            |
| `sub-agent.ai.sop`          | cortex/sop         | `~/Projects/helios/extensions/cortex/sop/` | Sub-agent spawning, model policy, coordination     |
| `program-management.ai.sop` | cortex/sop         | `~/Projects/helios/extensions/cortex/sop/` | LBF task board workflow (programs→projects→tasks)  |
| `software-lifecycle.ai.sop` | cortex/sop         | `~/Projects/helios/extensions/cortex/sop/` | Git workflow, semver, registry updates             |
| `docker-deploy.ai.sop`      | cortex/sop         | `~/Projects/helios/extensions/cortex/sop/` | Container deployment across fleet hosts            |
| `3d-printing.ai.sop`        | cortex/sop         | `~/Projects/helios/extensions/cortex/sop/` | OctoPrint/Prusa MK4 operations on octopi (.141)    |
| `security-audit.ai.sop`     | cortex/sop         | `~/Projects/helios/extensions/cortex/sop/` | Wazuh SIEM, network hardening, SSH security        |
| `daily-ops.ai.sop`          | cortex/sop         | `~/Projects/helios/extensions/cortex/sop/` | Fleet monitoring, AUGUR reports, backup checks     |
| `new-project.ai.sop`        | cortex/sop         | `~/Projects/helios/extensions/cortex/sop/` | Project creation checklist, templates, registry    |
| `merge.ai.sop`              | cortex/sop         | `~/Projects/helios/extensions/cortex/sop/` | Upstream merge, fork sync, post-merge verification |

## Cortex Process Memories (importance 3.0)

| Rule               | Summary                                                           |
| ------------------ | ----------------------------------------------------------------- |
| MASTER RULE        | Query cortex "process" category before ANY infra/tool action      |
| COMFYUI PRE-FLIGHT | .163:2222, stop ollama, conda `comfyui`, Flux fp8 workflow        |
| FLEET PRE-FLIGHT   | Check cortex for host, correct SSH port (usually 2222), check GPU |

## Completed ✅

All 14 SOPs have been created and documented. The core SOP system is now complete with comprehensive coverage of:

- **Infrastructure**: fleet access, docker deployment, daily operations
- **Development**: software lifecycle, new project creation, program management
- **Security**: audit procedures, hardening checklists, SIEM monitoring
- **Specialized Systems**: ComfyUI, ham radio, 3D printing
- **AI Operations**: sub-agent management, documentation standards, versioning

## Spec & Template

- **Spec**: `~/Projects/helios/extensions/cortex/sop/AI_SOP_SPEC.md` (v1.0.1)
- **Template**: `~/Projects/helios/extensions/cortex/sop/template.ai.sop`
