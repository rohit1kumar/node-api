#!/usr/bin/env bash
BASE="${BASE:-http://localhost:3000}"

echo "GET /health"
curl -s "$BASE/health" | jq .

echo -e "\nPOST /cache"
curl -s -X POST "$BASE/cache" -H "Content-Type: application/json" -d '{"key":"user:1","value":{"name":"Alice","id":1},"ttl":60}' | jq .

echo -e "\nGET /cache/:key"
curl -s "$BASE/cache/user:1" | jq .

echo -e "\nDELETE /cache/:key"
curl -s -X DELETE "$BASE/cache/user:1" | jq .
