#!/usr/bin/env sh
# Liest die Optionen aus der Home Assistant Add-on Konfiguration aus und exportiert sie als ENV
if [ -f /data/options.json ]; then
  export ADMIN_NUMBER=$(node -p "require('/data/options.json').ADMIN_NUMBER || ''")
  export ALLOWED_USERS=$(node -p "require('/data/options.json').ALLOWED_USERS || ''")
  export CONVERSATION_AGENT=$(node -p "require('/data/options.json').CONVERSATION_AGENT || ''")
  export STT_ENGINE=$(node -p "require('/data/options.json').STT_ENGINE || ''")
  export GROUP_IDS=$(node -p "require('/data/options.json').GROUP_IDS || ''")
  export USER_TOKENS=$(node -p "require('/data/options.json').USER_TOKENS || ''")
  export WAHA_URL=$(node -p "require('/data/options.json').WAHA_URL || 'http://192.168.0.2:3100'")
  export WAHA_API_KEY=$(node -p "require('/data/options.json').WAHA_API_KEY || ''")
  export WAHA_SESSION=$(node -p "require('/data/options.json').WAHA_SESSION || 'default'")
  export WAHA_WEBHOOK_URL=$(node -p "require('/data/options.json').WAHA_WEBHOOK_URL || ''")
  export HA_URL="http://supervisor/core"
  # Home Assistant Supervisor Token automatisch nutzen
  export HA_TOKEN="$SUPERVISOR_TOKEN"
fi

exec node /app/index.js