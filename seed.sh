#!/bin/sh
# Push the plan into the Worker. Needs the admin token the Worker knows as ADMIN_TOKEN.
#
#   RUNWAY_ADMIN_TOKEN=... ./seed.sh <code> [seed.json]
#
# The file it sends is never committed: seed.json is in .gitignore.
set -e
CODE="$1"
FILE="${2:-seed.json}"
[ -n "$CODE" ] || { echo "usage: RUNWAY_ADMIN_TOKEN=... ./seed.sh <code> [file]"; exit 1; }
[ -n "$RUNWAY_ADMIN_TOKEN" ] || { echo "set RUNWAY_ADMIN_TOKEN"; exit 1; }
[ -f "$FILE" ] || { echo "no such file: $FILE"; exit 1; }
API="${RUNWAY_API:-https://runway-sync.paul-o-a04.workers.dev}"
node -e '
  const fs = require("fs");
  const plan = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(JSON.stringify({ plan }));
' "$FILE" | curl -sS -X PUT "$API/api/plan/$CODE" \
  -H "Authorization: Bearer $RUNWAY_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @-
echo
