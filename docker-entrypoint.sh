#!/bin/sh
# If SERVER_WALLET_JSON is set (base64), decode it to the wallet file path
if [ -n "$SERVER_WALLET_JSON" ]; then
  echo "$SERVER_WALLET_JSON" | base64 -d > "${SERVER_WALLET_PATH:-/app/server-wallet.json}"
fi
exec "$@"
