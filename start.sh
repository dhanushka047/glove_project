#!/usr/bin/env bash
# ============================================================
#  start.sh — SignGlove one-click launcher
#  Usage: ./start.sh [port]
# ============================================================

set -e

PORT="${1:-3000}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$SCRIPT_DIR/server"

# ── Colours ─────────────────────────────────────────────────
BOLD="\033[1m"
GREEN="\033[32m"
CYAN="\033[36m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"

echo ""
echo -e "${BOLD}${CYAN}🧤  SignGlove Dashboard${RESET}"
echo -e "    Sign Language Detection System"
echo ""

# ── Check Node.js ────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo -e "${RED}✗  Node.js not found. Install from https://nodejs.org${RESET}"
  exit 1
fi

NODE_VER=$(node --version)
echo -e "  ${GREEN}✓${RESET}  Node.js ${NODE_VER}"

# ── Install dependencies if needed ──────────────────────────
if [ ! -d "$SERVER_DIR/node_modules" ]; then
  echo -e "  ${YELLOW}⚙${RESET}  Installing dependencies…"
  (cd "$SERVER_DIR" && npm install --silent)
  echo -e "  ${GREEN}✓${RESET}  Dependencies installed"
else
  echo -e "  ${GREEN}✓${RESET}  Dependencies ready"
fi

# ── Get local IP ─────────────────────────────────────────────
LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || \
           ipconfig getifaddr en1 2>/dev/null || \
           hostname -I 2>/dev/null | awk '{print $1}' || \
           echo "unknown")

# ── Start server ─────────────────────────────────────────────
echo ""
echo -e "  ${BOLD}Starting server on port ${PORT}…${RESET}"
echo ""
echo -e "  ${CYAN}┌─────────────────────────────────────────┐${RESET}"
echo -e "  ${CYAN}│${RESET}  🌐  Web Dashboard                       ${CYAN}│${RESET}"
echo -e "  ${CYAN}│${RESET}      http://localhost:${PORT}              ${CYAN}│${RESET}"
echo -e "  ${CYAN}│${RESET}                                         ${CYAN}│${RESET}"
echo -e "  ${CYAN}│${RESET}  📡  On your local network:              ${CYAN}│${RESET}"
echo -e "  ${CYAN}│${RESET}      http://${LOCAL_IP}:${PORT}           ${CYAN}│${RESET}"
echo -e "  ${CYAN}│${RESET}                                         ${CYAN}│${RESET}"
echo -e "  ${CYAN}│${RESET}  🔌  ESP32 WebSocket target:             ${CYAN}│${RESET}"
echo -e "  ${CYAN}│${RESET}      SERVER_HOST = \"${LOCAL_IP}\"       ${CYAN}│${RESET}"
echo -e "  ${CYAN}└─────────────────────────────────────────┘${RESET}"
echo ""
echo -e "  Press ${BOLD}Ctrl+C${RESET} to stop"
echo ""

# Open browser after 1.5s (macOS)
if command -v open &>/dev/null; then
  (sleep 1.5 && open "http://localhost:${PORT}") &
fi

# Run server
PORT="$PORT" node "$SERVER_DIR/server.js"
