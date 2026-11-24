#!/usr/bin/env bash
# Deploys (or updates) the Piano Companion recognition server on Google Cloud Run.
# Run it in Google Cloud Shell (https://shell.cloud.google.com) with:
#
#   rm -rf PianoApp && git clone --depth 1 https://github.com/Bezoon5/PianoApp.git && bash PianoApp/server/deploy-cloudrun.sh
#
# Optional: SERVICE=name REGION=europe-west1 bash PianoApp/server/deploy-cloudrun.sh
set -euo pipefail

SERVICE="${SERVICE:-piano-recogniser}"
REGION="${REGION:-europe-west1}"   # Belgium: close to the UK and in Google's cheapest price tier
cd "$(dirname "$0")"

PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
if [ -z "$PROJECT" ] || [ "$PROJECT" = "(unset)" ]; then
  echo "No Google Cloud project is selected. Your projects:"
  gcloud projects list --format="value(projectId)"
  read -rp "Type the project ID to use: " PROJECT
  gcloud config set project "$PROJECT"
fi
echo "==> Project: $PROJECT   Region: $REGION   Service: $SERVICE"

BILLING="$(gcloud billing projects describe "$PROJECT" --format='value(billingEnabled)' 2>/dev/null || true)"
if [ "$BILLING" = "False" ]; then
  echo "Billing is not turned on for this project, so Cloud Run can't be used yet."
  echo "Link a billing account here, then run this command again:"
  echo "  https://console.cloud.google.com/billing/linkedaccount?project=$PROJECT"
  exit 1
fi

echo "==> Turning on Cloud Run, Cloud Build and Artifact Registry (first time only)"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

# New projects don't give the default build account the rights it needs for source
# deploys (Google: grant Cloud Run Builder to the Compute Engine default service account).
NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
BUILDER="serviceAccount:${NUMBER}-compute@developer.gserviceaccount.com"
if ! gcloud projects get-iam-policy "$PROJECT" --flatten='bindings[].members' \
     --filter="bindings.role=roles/run.builder AND bindings.members=$BUILDER" --format='value(bindings.role)' | grep -q run.builder; then
  echo "==> Giving the build account permission to build (first time only)"
  gcloud projects add-iam-policy-binding "$PROJECT" --member="$BUILDER" --role=roles/run.builder --condition=None --quiet >/dev/null
  echo "    Waiting 90 seconds for the permission to take effect..."
  sleep 90
fi

echo "==> Building and deploying (about 5-10 minutes the first time)"
# 2 vCPU / 4 GiB per page; at most 2 copies run at once, which caps cost;
# scales to zero when unused.
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --cpu 2 --memory 4Gi --cpu-boost \
  --timeout 600 --concurrency 1 \
  --min-instances 0 --max-instances 2 \
  --quiet

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
echo "==> Checking the server"
if curl -fsS --max-time 120 "$URL/health"; then echo; else echo "(The health check didn't answer yet; try $URL/health in a browser in a minute.)"; fi
echo
echo "============================================================"
echo " Server address for the app:"
echo "   $URL"
echo " In Piano Companion: Settings > Photo recognition > paste it > Test connection"
echo "============================================================"
