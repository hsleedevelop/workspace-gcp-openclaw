#!/usr/bin/env bash
# deploy.sh — Deploy digest-worker to Cloud Run
#
# Secrets are injected from Secret Manager (not .env.yaml).
# Non-sensitive vars are loaded from .env.yaml via --env-vars-file.
#
# Prerequisites:
#   - Secrets created via ./setup-secrets.sh
#   - gcloud CLI authenticated

set -euo pipefail

PROJECT="spatial-airship-487608-s8"
REGION="asia-northeast3"
SERVICE="digest-worker"
SA="digest-build@${PROJECT}.iam.gserviceaccount.com"

# ── Secret → env var mapping ──
# Format: ENV_VAR=secret-name:version
SECRETS=(
  "CLIENT_SECRET=digest-gmail-client-secret:latest"
  "REFRESH_TOKEN=digest-gmail-refresh-token:latest"
  "TELEGRAM_BOT_TOKEN=digest-telegram-bot-token:latest"
  "TELEGRAM_WEBHOOK_SECRET=digest-telegram-webhook-secret:latest"
)

# Join secrets with comma for --set-secrets flag
SECRETS_FLAG=$(IFS=,; echo "${SECRETS[*]}")

echo "=== Deploying ${SERVICE} ==="
echo "Project: ${PROJECT}"
echo "Region:  ${REGION}"
echo "SA:      ${SA}"
echo "Secrets: ${#SECRETS[@]} from Secret Manager"
echo ""

gcloud run deploy "${SERVICE}" \
  --project="${PROJECT}" \
  --region="${REGION}" \
  --source=. \
  --service-account="${SA}" \
  --env-vars-file=.env.yaml \
  --set-secrets="${SECRETS_FLAG}" \
  --allow-unauthenticated \
  --memory=512Mi \
  --timeout=300 \
  --max-instances=1 \
  --quiet

echo ""
echo "=== Deploy complete ==="

# ── Show service URL ──
URL=$(gcloud run services describe "${SERVICE}" \
  --project="${PROJECT}" \
  --region="${REGION}" \
  --format="value(status.url)")

echo "Service URL: ${URL}"
echo ""
echo "Post-deploy checklist:"
echo "  1. Health check: curl ${URL}/health"
echo "  2. Set Telegram webhook (if not already set):"
echo "     curl -X POST \"https://api.telegram.org/bot\$(gcloud secrets versions access latest --secret=digest-telegram-bot-token --project=${PROJECT})/setWebhook\" \\"
echo "       -d \"url=${URL}/telegram/webhook&secret_token=\$(gcloud secrets versions access latest --secret=digest-telegram-webhook-secret --project=${PROJECT})\""
