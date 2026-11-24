#!/usr/bin/env bash
# Lock the Cloud Run recognition server with a key, so only your devices can use it.
# Run in Google Cloud Shell:
#   rm -rf PianoApp && git clone --depth 1 https://github.com/Bezoon5/PianoApp.git && bash PianoApp/server/lock-server.sh
# Prints the new key and a set-up link once. Run it again to replace the key
# (every device then needs the new link). To remove the lock: add --unlock.
set -euo pipefail
SERVICE="${SERVICE:-piano-recogniser}"
REGION="${REGION:-europe-west1}"
APP_URL="${APP_URL:-https://bezoon5.github.io/PianoApp/}"

if [ "${1:-}" = "--unlock" ]; then
  gcloud run services update "$SERVICE" --region "$REGION" --remove-env-vars API_KEY --quiet >/dev/null
  echo "Unlocked: any device can use the recognition server again."
  exit 0
fi

KEY="$(openssl rand -hex 16)"
echo "Locking $SERVICE ($REGION)… this takes about a minute."
# --update-env-vars keeps the server's other settings; --set-env-vars would wipe them.
gcloud run services update "$SERVICE" --region "$REGION" --update-env-vars "API_KEY=$KEY" --quiet >/dev/null

cat <<MSG

Done. The recognition server is locked.

Set-up link (open it once on each of your devices: iPhone, iPad, laptop):

  ${APP_URL}#key=${KEY}

Or type the key in Settings → Photo recognition → Key:  ${KEY}

Keep the link to yourself: anyone with it can use your server.
This key is not stored anywhere else, so save the link somewhere private
(for example a note to yourself) in case you set up a new device later.
MSG
