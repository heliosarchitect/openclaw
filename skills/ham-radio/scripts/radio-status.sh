#!/usr/bin/env bash
set -euo pipefail

# Radio Status Script for FT-991A
# Connects to radio.fleet.wood and retrieves formatted status information

RADIO_HOST="radio.fleet.wood"
RADIO_PORT="2222"

usage() {
  cat <<'USAGE'
Usage: radio-status.sh [options]

Get formatted status information from the FT-991A ham radio.

Options:
  -v, --verbose     Show detailed status information
  -j, --json        Output in JSON format
  -h, --help        Show this help

Examples:
  ./radio-status.sh              # Basic status
  ./radio-status.sh --verbose    # Detailed status with SWR, power, etc.
  ./radio-status.sh --json       # JSON output for parsing
USAGE
}

verbose=false
json_output=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -v|--verbose) verbose=true; shift ;;
    -j|--json)    json_output=true; shift ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

# Check SSH connectivity
if ! ssh -p "$RADIO_PORT" -o ConnectTimeout=5 "$RADIO_HOST" echo "test" >/dev/null 2>&1; then
  echo "❌ Cannot connect to radio server at ${RADIO_HOST}:${RADIO_PORT}" >&2
  echo "   Check network connectivity and SSH service" >&2
  exit 1
fi

# Check if ft991a-cli is available
if ! ssh -p "$RADIO_PORT" "$RADIO_HOST" command -v ft991a-cli >/dev/null 2>&1; then
  echo "❌ ft991a-cli not found on $RADIO_HOST" >&2
  echo "   Ensure ft991a-control package is installed and in PATH" >&2
  exit 1
fi

# Get radio status
if ! radio_status=$(ssh -p "$RADIO_PORT" "$RADIO_HOST" ft991a-cli status 2>&1); then
  echo "❌ Failed to get radio status" >&2
  echo "   Radio response: $radio_status" >&2
  echo "   Check USB connection to FT-991A and serial port permissions" >&2
  exit 1
fi

# Parse and format output
if [[ "$json_output" == true ]]; then
  # Output as JSON (basic implementation - could be enhanced)
  echo "{"
  echo "  \"status\": \"connected\","
  echo "  \"host\": \"$RADIO_HOST:$RADIO_PORT\","
  echo "  \"callsign\": \"KO4TUV\","
  echo "  \"radio_output\": \"$radio_status\""
  echo "}"
else
  echo "📻 FT-991A Status (KO4TUV)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "🔗 Connection: ${RADIO_HOST}:${RADIO_PORT}"
  echo ""
  
  # Display radio status with formatting
  echo "📊 Radio Status:"
  echo "$radio_status" | sed 's/^/   /'
  
  if [[ "$verbose" == true ]]; then
    echo ""
    echo "🔧 Additional Information:"
    
    # Get additional details if verbose
    if freq=$(ssh -p "$RADIO_PORT" "$RADIO_HOST" ft991a-cli get-freq 2>/dev/null); then
      echo "   Frequency: $freq MHz"
    fi
    
    if mode=$(ssh -p "$RADIO_PORT" "$RADIO_HOST" ft991a-cli get-mode 2>/dev/null); then
      echo "   Mode: $mode"
    fi
    
    if power=$(ssh -p "$RADIO_PORT" "$RADIO_HOST" ft991a-cli get-power 2>/dev/null); then
      echo "   RF Power: $power"
    fi
    
    if swr=$(ssh -p "$RADIO_PORT" "$RADIO_HOST" ft991a-cli get-swr 2>/dev/null); then
      echo "   SWR: $swr"
    fi
    
    if signal=$(ssh -p "$RADIO_PORT" "$RADIO_HOST" ft991a-cli get-signal 2>/dev/null); then
      echo "   Signal: $signal"
    fi
  fi
  
  echo ""
  echo "⚠️  SAFETY: NO TX WITHOUT MATTHEW PRESENT"
  echo "✅ RX monitoring and frequency changes permitted"
fi