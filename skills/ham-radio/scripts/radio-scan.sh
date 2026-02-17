#!/usr/bin/env bash
set -euo pipefail

# Radio Band Scanner for FT-991A
# Automated scanning with activity detection

RADIO_HOST="radio.fleet.wood"
RADIO_PORT="2222"

usage() {
  cat <<'USAGE'
Usage: radio-scan.sh [options] [band|start_freq end_freq]

Perform automated band scanning on the FT-991A with activity detection.

Arguments:
  band           Preset band name: 80m, 40m, 20m, 15m, 10m, 2m
  start_freq     Custom start frequency in MHz (requires end_freq)
  end_freq       Custom end frequency in MHz (requires start_freq)

Options:
  -s, --step     Frequency step in kHz (default: 25)
  -t, --time     Dwell time per frequency in seconds (default: 2)
  -l, --level    Signal threshold for activity detection (default: S3)
  -m, --mode     Operating mode for scan (default: auto per band)
  -v, --verbose  Show all frequencies, even without activity
  -c, --count    Maximum number of active frequencies to report (default: 10)
  -h, --help     Show this help

Examples:
  ./radio-scan.sh 20m           # Scan 20 meter band
  ./radio-scan.sh 14.0 14.35    # Custom frequency range
  ./radio-scan.sh 2m --step 12.5 --mode FM   # Scan 2m with FM mode
  ./radio-scan.sh 40m --verbose # Show all frequencies during scan

Preset Bands:
  80m: 3.5-4.0 MHz (LSB/CW)     Regional evening/night activity
  40m: 7.0-7.3 MHz (LSB/CW)     Reliable day/night DX
  20m: 14.0-14.35 MHz (USB/CW)  Premier DX band (daytime)
  15m: 21.0-21.45 MHz (USB/CW)  Solar cycle dependent
  10m: 28.0-29.7 MHz (USB/FM)   Sporadic-E, contests
  2m:  144-148 MHz (FM/SSB)     Local repeaters, weak signal
USAGE
}

# Default parameters
step_khz=25
dwell_time=2
signal_threshold="S3"
mode=""
verbose=false
max_results=10
start_freq=""
end_freq=""
band_name=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    -s|--step)    step_khz="${2-}"; shift 2 ;;
    -t|--time)    dwell_time="${2-}"; shift 2 ;;
    -l|--level)   signal_threshold="${2-}"; shift 2 ;;
    -m|--mode)    mode="${2-}"; shift 2 ;;
    -v|--verbose) verbose=true; shift ;;
    -c|--count)   max_results="${2-}"; shift 2 ;;
    -h|--help)    usage; exit 0 ;;
    80m|40m|20m|15m|10m|2m|6m|70cm)
      band_name="$1"; shift ;;
    [0-9]*.*)
      if [[ -z "$start_freq" ]]; then
        start_freq="$1"
      elif [[ -z "$end_freq" ]]; then
        end_freq="$1"
      else
        echo "Too many frequency arguments" >&2; usage; exit 1
      fi
      shift
      ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

# Set band parameters
if [[ -n "$band_name" ]]; then
  case "$band_name" in
    80m)  start_freq="3.5"; end_freq="4.0"; mode="${mode:-LSB}" ;;
    40m)  start_freq="7.0"; end_freq="7.3"; mode="${mode:-LSB}" ;;
    20m)  start_freq="14.0"; end_freq="14.35"; mode="${mode:-USB}" ;;
    15m)  start_freq="21.0"; end_freq="21.45"; mode="${mode:-USB}" ;;
    10m)  start_freq="28.0"; end_freq="29.7"; mode="${mode:-USB}" ;;
    6m)   start_freq="50.0"; end_freq="54.0"; mode="${mode:-USB}" ;;
    2m)   start_freq="144.0"; end_freq="148.0"; mode="${mode:-FM}" ;;
    70cm) start_freq="420.0"; end_freq="450.0"; mode="${mode:-FM}" ;;
  esac
fi

# Validate arguments
if [[ -z "$start_freq" || -z "$end_freq" ]]; then
  echo "Error: Must specify either a band name or start/end frequencies" >&2
  usage
  exit 1
fi

# Validate frequency format
if ! [[ "$start_freq" =~ ^[0-9]+\.?[0-9]*$ ]] || ! [[ "$end_freq" =~ ^[0-9]+\.?[0-9]*$ ]]; then
  echo "❌ Invalid frequency format" >&2
  exit 1
fi

# Check that start < end
if (( $(echo "$start_freq >= $end_freq" | bc -l) )); then
  echo "❌ Start frequency must be less than end frequency" >&2
  exit 1
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

echo "📻 FT-991A Band Scanner"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [[ -n "$band_name" ]]; then
  echo "🎯 Band: $band_name ($start_freq - $end_freq MHz)"
else
  echo "🎯 Range: $start_freq - $end_freq MHz"
fi
echo "⚙️  Step: ${step_khz} kHz, Dwell: ${dwell_time}s, Mode: ${mode:-Auto}"
echo "📊 Signal Threshold: $signal_threshold"
echo ""

# Set operating mode if specified
if [[ -n "$mode" ]]; then
  echo "Setting mode to $mode..."
  ssh -p "$RADIO_PORT" "$RADIO_HOST" ft991a-cli set-mode "$mode" >/dev/null 2>&1 || true
fi

# Calculate scan parameters
step_mhz=$(echo "scale=6; $step_khz / 1000" | bc -l)
total_steps=$(echo "scale=0; ($end_freq - $start_freq) / $step_mhz" | bc -l)
scan_time=$(echo "scale=0; $total_steps * $dwell_time" | bc -l)

echo "🔄 Scanning $total_steps frequencies (estimated ${scan_time}s)"
echo "⚠️  SAFETY: RX ONLY - NO TRANSMIT OPERATIONS"
echo ""

# Initialize results array
declare -a active_frequencies=()
current_freq="$start_freq"
step_count=0

# Scan loop
while (( $(echo "$current_freq <= $end_freq" | bc -l) )); do
  step_count=$((step_count + 1))
  
  # Set frequency
  if ssh -p "$RADIO_PORT" "$RADIO_HOST" ft991a-cli set-freq "$current_freq" >/dev/null 2>&1; then
    
    # Wait for settling
    sleep "$dwell_time"
    
    # Check signal level
    signal_reading=""
    if signal_reading=$(ssh -p "$RADIO_PORT" "$RADIO_HOST" ft991a-cli get-signal 2>/dev/null); then
      
      # Simple signal detection (would need more sophisticated logic for real implementation)
      has_activity=false
      if [[ "$signal_reading" =~ S[4-9] ]] || [[ "$signal_reading" =~ S[1-9][0-9] ]]; then
        has_activity=true
      fi
      
      if [[ "$has_activity" == true ]]; then
        active_frequencies+=("$current_freq MHz: $signal_reading")
        echo "🎵 $current_freq MHz: $signal_reading"
      elif [[ "$verbose" == true ]]; then
        echo "🔇 $current_freq MHz: $signal_reading"
      fi
      
      # Limit results
      if [[ "${#active_frequencies[@]}" -ge "$max_results" ]]; then
        echo ""
        echo "⏹️  Stopping scan: reached maximum of $max_results active frequencies"
        break
      fi
      
    else
      if [[ "$verbose" == true ]]; then
        echo "❌ $current_freq MHz: Unable to read signal"
      fi
    fi
    
    # Progress indicator (every 50 steps or if verbose)
    if [[ "$verbose" == true ]] || (( step_count % 50 == 0 )); then
      progress=$(echo "scale=1; $step_count * 100 / $total_steps" | bc -l)
      echo "📈 Progress: ${progress}% (${step_count}/${total_steps})"
    fi
    
  else
    if [[ "$verbose" == true ]]; then
      echo "❌ $current_freq MHz: Failed to set frequency"
    fi
  fi
  
  # Next frequency
  current_freq=$(echo "scale=6; $current_freq + $step_mhz" | bc -l)
done

echo ""
echo "📋 Scan Complete"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [[ "${#active_frequencies[@]}" -eq 0 ]]; then
  echo "🔇 No significant activity detected above $signal_threshold threshold"
else
  echo "🎵 Found ${#active_frequencies[@]} active frequencies:"
  echo ""
  for freq_info in "${active_frequencies[@]}"; do
    echo "   $freq_info"
  done
fi

echo ""
echo "⏱️  Scanned $step_count frequencies in $(date)"
echo "🔧 Use radio-tune.sh <frequency> to tune to an active frequency"
echo "⚠️  REMEMBER: NO TX WITHOUT MATTHEW PRESENT"