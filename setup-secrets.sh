#!/usr/bin/env bash
# setup-secrets.sh — One-time Secret Manager setup for digest-worker
# Run this ONCE, then use deploy.sh for subsequent deploys.
#
# Prerequisites:
#   - gcloud CLI authenticated with sufficient permissions
#   - Secret Manager API enabled: gcloud services enable secretmanager.googleapis.com

set -euo pipefail

PROJECT="spatial-airship-487608-s8"
SA="digest-build@${PROJECT}.iam.gserviceaccount.com"

# ── Secret names ──
SECRETS=(
  "digest-gmail-client-secret"
  "digest-gmail-refresh-token"
  "digest-telegram-bot-token"
  "digest-telegram-webhook-secret"
)

echo "=== Secret Manager Setup for digest-worker ==="
echo "Project: ${PROJECT}"
echo "Service Account: ${SA}"
echo ""

# ── 1. Enable Secret Manager API ──
echo "[1/4] Enabling Secret Manager API..."
gcloud services enable secretmanager.googleapis.com --project="${PROJECT}"

# ── 2. Create secrets (interactive — prompts for values) ──
echo ""
echo "[2/4] Creating secrets..."
echo "You will be prompted to enter each secret value."
echo ""

for SECRET_NAME in "${SECRETS[@]}"; do
  if gcloud secrets describe "${SECRET_NAME}" --project="${PROJECT}" &>/dev/null; then
    echo "  ✓ ${SECRET_NAME} already exists — skipping creation"
    echo "    (To update: echo -n 'NEW_VALUE' | gcloud secrets versions add ${SECRET_NAME} --data-file=- --project=${PROJECT})"
  else
    echo "  → Creating ${SECRET_NAME}..."
    echo -n "    Enter value for ${SECRET_NAME}: "
    read -rs SECRET_VALUE
    echo ""
    echo -n "${SECRET_VALUE}" | gcloud secrets create "${SECRET_NAME}" \
      --data-file=- \
      --replication-policy="automatic" \
      --project="${PROJECT}"
    echo "    ✓ ${SECRET_NAME} created"
  fi
done

# ── 3. Grant Secret Accessor role to service account ──
echo ""
echo "[3/4] Granting secretAccessor role to ${SA}..."

for SECRET_NAME in "${SECRETS[@]}"; do
  gcloud secrets add-iam-policy-binding "${SECRET_NAME}" \
    --member="serviceAccount:${SA}" \
    --role="roles/secretmanager.secretAccessor" \
    --project="${PROJECT}" \
    --quiet
  echo "  ✓ ${SECRET_NAME} → ${SA}"
done

# ── 4. Verify ──
echo ""
echo "[4/4] Verification:"
for SECRET_NAME in "${SECRETS[@]}"; do
  VERSION=$(gcloud secrets versions list "${SECRET_NAME}" --project="${PROJECT}" --limit=1 --format="value(name)" 2>/dev/null || echo "NONE")
  echo "  ${SECRET_NAME}: latest version = ${VERSION}"
done

echo ""
echo "=== Done ==="
echo "Next step: run ./deploy.sh to deploy with secrets"
