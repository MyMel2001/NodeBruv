#!/bin/bash
cd "$(dirname "$0")"
bruv pull 2>/dev/null || git pull 2>/dev/null || true

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"
nvm install 24
nvm use 24

npm i
node server.js > nodebruv.log 2>&1 &
