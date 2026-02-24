#!/bin/bash
# Simulates a Partna Webhook hitting the local Dayle backend
# Requires a valid ledger entry reference in the DB for the vault

REFERENCE=$1
AMOUNT=${2:-500}

if [ -z "$REFERENCE" ]; then
  echo "Usage: ./test_webhook.sh <ledger_provider_ref> [amount]"
  echo "Example: ./test_webhook.sh ref_123 500"
  exit 1
fi

curl -X POST http://localhost:3000/webhooks/partna \
  -H "Content-Type: application/json" \
  -d '{
    "reference": "'$REFERENCE'",
    "status": "success",
    "amount": '$AMOUNT',
    "type": "collection"
  }'

echo -e "\nWebhook sent!"
