---
name: ham-radio
description: "Control Yaesu FT-991A ham radio via ft991a-control package on radio.fleet.wood. Supports status monitoring, frequency tuning, band scanning, and CW operations."
metadata:
  {
    "openclaw":
      {
        "emoji": "📻",
        "requires": { "bins": ["ssh"] },
        "install":
          [
            {
              "id": "openssh-client",
              "kind": "apt",
              "package": "openssh-client",
              "bins": ["ssh"],
              "label": "Install SSH client (apt)",
            },
          ],
      },
  }
---

# Ham Radio Skill (FT-991A)

Control the Yaesu FT-991A ham radio transceiver via SSH connection to `radio.fleet.wood` (192.168.10.179:2222).

**CRITICAL SAFETY RULE**: 🚨 **NO TRANSMIT (TX) OPERATIONS UNLESS MATTHEW IS PHYSICALLY PRESENT**  
RX monitoring, frequency changes, and status checks are permitted when operating solo.

## Connection Info

- **Host**: radio.fleet.wood (192.168.10.179)
- **Port**: 2222
- **Radio**: Yaesu FT-991A on /dev/ttyUSB0 (38400 baud)
- **Callsign**: KO4TUV
- **Control Software**: ft991a-cli (v0.3.5)

## Quick Commands

### Radio Status

Check current frequency, mode, power level, and connection status:

```bash
ssh -p 2222 radio.fleet.wood ft991a-cli status
```

### Tune to Frequency

Set radio to specific frequency (MHz):

```bash
ssh -p 2222 radio.fleet.wood ft991a-cli set-freq 14.230
```

### Band Scan

Scan amateur bands for activity:

```bash
ssh -p 2222 radio.fleet.wood ft991a-cli scan
```

## Available Commands via ft991a-cli

### Frequency Control

- `set-freq <MHz>` - Set frequency (e.g., 14.230 for 20m)
- `get-freq` - Get current frequency
- `set-mode <mode>` - Set operating mode (LSB, USB, CW, FM, AM, etc.)
- `get-mode` - Get current operating mode

### Band Operations

- `scan` - Scan current band for activity
- `band-sweep <start> <end>` - Sweep frequency range
- `get-band-edges` - Show amateur band frequencies

### CW (Morse Code)

- `cw-encode "<text>"` - Convert text to Morse code (audio/visual)
- `cw-decode` - Listen and decode incoming Morse
- `cw-keyer-speed <wpm>` - Set keyer speed (words per minute)

### Status & Info

- `status` - Complete radio status (freq, mode, power, SWR, etc.)
- `get-power` - Get RF power level
- `get-swr` - Get SWR reading
- `get-signal` - Get signal strength (S-meter)

### Memory Operations

- `memory-store <channel> <freq> <mode>` - Store frequency to memory
- `memory-recall <channel>` - Recall memory channel
- `memory-list` - List programmed memories

## Scripts

The skill includes convenience scripts in the `scripts/` directory:

### radio-status.sh

Quick status check with formatted output:

```bash
./scripts/radio-status.sh
```

### radio-tune.sh

Tune to frequency with validation:

```bash
./scripts/radio-tune.sh 14.230  # 20m band
./scripts/radio-tune.sh 7.125   # 40m band
```

### radio-scan.sh

Automated band scanning with activity detection:

```bash
./scripts/radio-scan.sh
```

## Amateur Radio Bands (KO4TUV)

Common frequencies for reference:

- **80m**: 3.5-4.0 MHz (good for evening/night, regional)
- **40m**: 7.0-7.3 MHz (reliable day/night, national/international)
- **20m**: 14.0-14.35 MHz (daytime DX, worldwide)
- **15m**: 21.0-21.45 MHz (solar cycle dependent)
- **10m**: 28.0-29.7 MHz (sporadic-E, contest)
- **2m**: 144-148 MHz (local FM repeaters, packet)

## Safety & Legal Notes

1. **Transmit Authorization**: Only licensed operator (KO4TUV/Matthew) may authorize transmissions
2. **Band Plans**: Respect ARRL band plans and local coordination frequencies
3. **Power Limits**: FT-991A max 100W - verify antenna SWR before high power
4. **Emergency Frequencies**: Monitor but do not interfere with emergency nets
5. **Spurious Emissions**: Ensure clean signal - monitor harmonics with spectrum analyzer

## Troubleshooting

### Connection Issues

```bash
# Test SSH connectivity
ssh -p 2222 radio.fleet.wood echo "Connection OK"

# Check if ft991a-cli is in PATH
ssh -p 2222 radio.fleet.wood which ft991a-cli

# Verify radio connection
ssh -p 2222 radio.fleet.wood ft991a-cli --version
```

### Radio Issues

- **No Response**: Check USB connection on /dev/ttyUSB0
- **Permission Denied**: User must be in `dialout` group
- **Invalid Frequency**: Ensure frequency is within amateur allocations
- **High SWR**: Check antenna connections before transmitting

## Examples

Monitor 20m band for DX stations:

```bash
ssh -p 2222 radio.fleet.wood ft991a-cli set-freq 14.205
ssh -p 2222 radio.fleet.wood ft991a-cli set-mode USB
ssh -p 2222 radio.fleet.wood ft991a-cli status
```

Quick CW beacon decode:

```bash
ssh -p 2222 radio.fleet.wood ft991a-cli set-freq 14.100
ssh -p 2222 radio.fleet.wood ft991a-cli set-mode CW
ssh -p 2222 radio.fleet.wood ft991a-cli cw-decode
```

Store repeater frequency:

```bash
ssh -p 2222 radio.fleet.wood ft991a-cli memory-store 1 146.52 FM
```
