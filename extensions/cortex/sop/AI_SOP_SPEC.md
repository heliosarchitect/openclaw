# `.ai.sop` — AI Standard Operating Procedure Specification

**Version:** 1.0.0  
**Cortex Version:** 1.1.0  
**Author:** Helios

## Overview

`.ai.sop` files are machine-readable standard operating procedures that live alongside the projects they describe. They encode the knowledge an AI agent needs to operate on a project without guessing, improvising, or repeating past mistakes.

## File Convention

- **Filename:** `{project-name}.ai.sop` (e.g., `comfyui.ai.sop`, `augur.ai.sop`)
- **Location:** Project root directory
- **Format:** YAML with structured sections
- **Encoding:** UTF-8

## Required Sections

### `meta`

Project identity and ownership.

```yaml
meta:
  name: string # Human-readable project name
  version: string # Current project version (semver)
  repo: string # Absolute path to repo root
  hosts: [string] # Fleet hosts this project runs on
  updated: string # ISO 8601 date of last SOP update
```

### `preflight`

Steps to execute BEFORE any action. These are mandatory — skip nothing.

```yaml
preflight:
  - id: string # Unique step identifier
    action: string # What to do (human-readable)
    command: string # Optional: exact command to run
    check: string # Optional: expected output or condition
    reason: string # Why this step matters (lessons learned)
```

### `hosts`

Per-host connection and environment details.

```yaml
hosts:
  - name: string # Hostname or alias
    ip: string # IP address
    port: int # SSH port
    user: string # SSH user
    services: [string] # Running services (comfyui, ollama, etc.)
    env: string # Activation command (conda, venv, etc.)
    gpu: string # GPU model and VRAM
    gotchas: [string] # Known issues specific to this host
```

### `commands`

Canonical commands for common operations. No guessing.

```yaml
commands:
  start: string # How to start the service
  stop: string # How to stop it
  status: string # How to check if it's running
  deploy: string # How to deploy updates
  test: string # How to run tests
  logs: string # How to view logs
```

### `gotchas`

Hard-won lessons. Things that broke before and will break again if forgotten.

```yaml
gotchas:
  - id: string # Reference ID
    description: string # What goes wrong
    fix: string # How to fix or avoid it
    learned: string # Date learned (ISO 8601)
```

## Optional Sections

### `dependencies`

What this project needs from other systems.

```yaml
dependencies:
  - name: string # Dependency name
    type: string # service | package | model | hardware
    required: bool # Hard or soft dependency
    notes: string # Version constraints, gotchas
```

### `alerts`

Conditions that should trigger notification.

```yaml
alerts:
  - condition: string # What to watch for
    severity: string # critical | warning | info
    action: string # What to do when triggered
```

## Example

```yaml
meta:
  name: ComfyUI Image Generation
  version: 0.9.2
  repo: ~/Projects/ComfyUI
  hosts: [blackview]
  updated: 2026-02-17

preflight:
  - id: check-ollama
    action: Unload or stop Ollama to free GPU VRAM
    command: >
      ssh blackview 'curl -s http://localhost:11434/api/generate
      -d "{\"model\":\"qwen2.5:32b\",\"keep_alive\":0}"'
    reason: Ollama loads 27GB into VRAM, leaving ComfyUI with 1.6GB

  - id: check-gpu
    action: Verify GPU VRAM is free
    command: ssh blackview 'nvidia-smi --query-gpu=memory.used --format=csv,noheader'
    check: "< 5000 MiB"
    reason: Flux Dev fp8 needs ~17GB VRAM for inference

hosts:
  - name: blackview
    ip: 192.168.10.163
    port: 2222
    user: bonsaihorn
    services: [comfyui, ollama, augur]
    env: source ~/miniconda3/bin/activate comfyui
    gpu: "NVIDIA GeForce RTX 5090 32GB"
    gotchas:
      - "SSH sessions disconnect → kills ComfyUI. ALWAYS use nohup."
      - "Flux uses UNETLoader + DualCLIPLoader, NOT CheckpointLoaderSimple."
      - "Ollama auto-reloads models. Stop the service, not just the model."

commands:
  start: >
    ssh blackview 'nohup bash -c "source ~/miniconda3/bin/activate comfyui &&
    cd ~/Projects/ComfyUI && python3 main.py --listen 0.0.0.0 --port 8188"
    > /tmp/comfyui.log 2>&1 &'
  stop: ssh blackview 'pkill -f "main.py.*8188"'
  status: curl -s http://192.168.10.163:8188/system_stats | head -5
  logs: ssh blackview 'tail -50 /tmp/comfyui.log'

gotchas:
  - id: flux-loader
    description: Flux models need UNETLoader + DualCLIPLoader (clip_l + t5xxl_fp8, type=flux) + VAELoader (ae.safetensors). CheckpointLoaderSimple does NOT work — it loads but never generates.
    fix: Use the Flux-specific workflow nodes
    learned: 2026-02-17

  - id: broken-pipe
    description: Starting ComfyUI in an SSH foreground session causes BrokenPipeError when SSH disconnects during sampling. The tqdm progress bar writes to a dead pipe.
    fix: Always start with nohup and redirect stdout/stderr
    learned: 2026-02-17
```

## Cortex Integration

When cortex v1.1.0 lands, the process engine will:

1. Detect which project/host an action targets
2. Look for `*.ai.sop` files in the relevant project directory
3. Inject the `preflight` and `gotchas` sections into context BEFORE action execution
4. This is not voluntary — it's structural enforcement

## Template File

See `template.ai.sop` in this directory for a blank template.
