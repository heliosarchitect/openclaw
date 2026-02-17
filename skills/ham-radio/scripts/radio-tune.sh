#!/usr/bin/env bash
set -euo pipefail

# Radio Tuning Script for FT-991A
# Tune to specified frequency with amateur band validation

RADIO_HOST="radio.fleet.wood"
RADIO_PORT="2222"

usage() {
  cat <<'USAGE'
Usage: radio-tune.sh <frequency> [mode]

Tune FT-991A to specified frequency with amateur band validation.

Arguments:
  frequency    Frequency in MHz (e.g., 14.230, 7.125, 3.650)
  mode         Operating mode: LSB, USB, CW, FM, AM, etc. (optional)

Options:
  -f, --force     Skip amateur band validation (advanced users only)
  -s, --status    Show status after tuning
  -h, --help      Show this help

Examples:
  ./radio-tune.sh 14.230        # Tune to 14.230 MHz (auto-detect mode)
  ./radio-tune.sh 14.230 USB    # Tune to 14.230 MHz USB
  ./radio-tune.sh 146.52 FM     # Tune to 2m repeater
  ./radio-tune.sh 7.125 LSB -s  # Tune to 40m and show status

Amateur Band Quick Reference:
  80m: 3.5-4.0 MHz    (LSB voice, CW)
  40m: 7.0-7.3 MHz    (LSB voice, CW) 
  20m: 14.0-14.35 MHz (USB voice, CW)
  15m: 21.0-21.45 MHz (USB voice, CW)
  10m: 28.0-29.7 MHz  (USB voice, FM, CW)
  2m:  144-148 MHz    (FM, SSB, CW)
USAGE
}

force_tune=false
show_status=false
frequency=""
mode=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    -f|--force)  force_tune=true; shift ;;
    -s|--status) show_status=true; shift ;;
    -h|--help)   usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; usage; exit 1 ;;
    *)
      if [[ -z "$frequency" ]]; then
        frequency="$1"
      elif [[ -z "$mode" ]]; then
        mode="$1"
      else
        echo "Too many arguments" >&2; usage; exit 1
      fi
      shift
      ;;
  esac
done

if [[ -z "$frequency" ]]; then
  echo "Error: Frequency required" >&2
  usage
  exit 1
fi

# Validate frequency format
if ! [[ "$frequency" =~ ^[0-9]+\.?[0-9]*$ ]]; then
  echo "❌ Invalid frequency format: $frequency" >&2
  echo "   Use decimal format like 14.230 or 146.52" >&2
  exit 1
fi

# Convert to float for comparison
freq_num=$(echo "$frequency" | bc -l 2>/dev/null || echo "0")
if (( $(echo "$freq_num == 0" | bc -l) )); then
  echo "❌ Invalid frequency: $frequency" >&2
  exit 1
fi

# Amateur band validation (unless forced)
if [[ "$force_tune" != true ]]; then
  valid_band=false
  band_name=""
  suggested_mode=""
  
  # Check amateur allocations (US bands - adjust for other countries if needed)
  if (( $(echo "$freq_num >= 1.8 && $freq_num <= 2.0" | bc -l) )); then
    valid_band=true; band_name="160m"; suggested_mode="LSB"
  elif (( $(echo "$freq_num >= 3.5 && $freq_num <= 4.0" | bc -l) )); then
    valid_band=true; band_name="80m"; suggested_mode="LSB"
  elif (( $(echo "$freq_num >= 7.0 && $freq_num <= 7.3" | bc -l) )); then
    valid_band=true; band_name="40m"; suggested_mode="LSB"
  elif (( $(echo "$freq_num >= 14.0 && $freq_num <= 14.35" | bc -l) )); then
    valid_band=true; band_name="20m"; suggested_mode="USB"
  elif (( $(echo "$freq_num >= 21.0 && $freq_num <= 21.45" | bc -l) )); then
    valid_band=true; band_name="15m"; suggested_mode="USB"
  elif (( $(echo "$freq_num >= 28.0 && $freq_num <= 29.7" | bc -l) )); then
    valid_band=true; band_name="10m"; suggested_mode="USB"
  elif (( $(echo "$freq_num >= 50.0 && $freq_num <= 54.0" | bc -l) )); then
    valid_band=true; band_name="6m"; suggested_mode="USB"
  elif (( $(echo "$freq_num >= 144.0 && $freq_num <= 148.0" | bc -l) )); then
    valid_band=true; band_name="2m"; suggested_mode="FM"
  elif (( $(echo "$freq_num >= 420.0 && $freq_num <= 450.0" | bc -l) )); then
    valid_band=true; band_name="70cm"; suggested_mode="FM"
  fi
  
  if [[ "$valid_band" != true ]]; then
    echo "⚠️  WARNING: $frequency MHz is not in amateur radio allocation" >&2
    echo "   Valid bands: 80m, 40m, 20m, 15m, 10m, 6m, 2m, 70cm" >&2
    echo "   Use --force to override (ensure you have authorization)" >&2
    exit 1
  fi
  
  # Auto-suggest mode if not specified
  if [[ -z "$mode" && -n "$suggested_mode" ]]; then
    echo "ℹ️  Auto-selecting $suggested_mode mode for $band_name band"
    mode="$suggested_mode"
  fi
fi

# Check SSH connectivity
if ! ssh -p "$RADIO_PORT" -o ConnectTimeout=5 "$RADIO_HOST" echo "test" >/dev/null 2>&1; then
  echo "❌ Cannot connect to radio server at ${RADIO_HOST}:${RADIO_PORT}" >&2
  exit 1
fi

# Check ft991a-cli availability
if ! ssh -p "$RADIO_PORT" "$RADIO_HOST" command -v ft991a-cli >/dev/null 2>&1; then
  echo "❌ ft991a-cli not found on $RADIO_HOST" >&2
  exit 1
fi

echo "📻 Tuning FT-991A to $frequency MHz" 
if [[ -n "$band_name" ]]; then
  echo "   Band: $band_name"
fi

# Set frequency
if ! ssh -p "$RADIO_PORT" "$RADIO_HOST" ft991a-cli set-freq "$frequency" 2>&1; then
  echo "❌ Failed to set frequency" >&2
  exit 1
fi

# Set mode if specified
if [[ -n "$mode" ]]; then
  echo "   Mode: $mode"
  if ! ssh -p "$RADIO_PORT" "$RADIO_HOST" ft991a-cli set-mode "$mode" 2>&1; then
    echo "⚠️  Warning: Failed to set mode to $mode" >&2
  fi
fi

echo "✅ Successfully tuned to $frequency MHz"

# Show status if requested
if [[ "$show_status" == true ]]; then
  echo ""
  if status_output=$(ssh -p "$RADIO_PORT" "$RADIO_HOST" ft991a-cli status 2>&1); then
    echo "📊 Current Status:"
    echo "$status_output" | sed 's/^/   /'
  fi
fi

echo ""
echo "⚠️  SAFETY: NO TX WITHOUT MATTHEW PRESENT"