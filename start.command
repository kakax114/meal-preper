#!/bin/bash
cd "$(dirname "$0")"

# Kill any existing server — by name and by port
pkill -f "node server.js" 2>/dev/null
lsof -ti:3456 | xargs kill -9 2>/dev/null
sleep 1

node server.js &
sleep 1.5
open http://localhost:3456
wait
