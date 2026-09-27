#!/usr/bin/env bash
# Evolution API ilə əl ilə mesaj göndərmə yoxlaması.
#
# İstifadə:
#   scripts/send-message.sh <instance> <nömrə> "<mətn>"        # göndərir
#   scripts/send-message.sh <instance> <nömrə> "<mətn>" --dry  # yalnız göstərir, göndərmir
#
# Nömrə: yalnız rəqəmlər, ölkə kodu ilə (994...). Boşluq/+/tire özü silinir.
#
# Qəsdən BURAXILANLAR:
#   - delay yoxdur  -> qarşı tərəf «yazır...» görmür
#   - presence yoxdur -> onlayn görünmürsən
#   - söhbət oxunmuş İŞARƏLƏNMİR (readMessages/readStatus instance ayarıdır, bu skript ona toxunmur)
set -euo pipefail

ENV_FILE="${ENV_FILE:-/var/www/evolution-api/.env}"
BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
[ $# -ge 3 ] || usage

INSTANCE="$1"
NUMBER="$(printf '%s' "$2" | tr -cd '0-9')"
TEXT="$3"
DRY="${4:-}"

[ -n "$NUMBER" ] || { echo "xəta: nömrədə rəqəm yoxdur" >&2; exit 1; }
[ -r "$ENV_FILE" ] || { echo "xəta: $ENV_FILE oxunmur" >&2; exit 1; }

APIKEY="$(grep -m1 '^AUTHENTICATION_API_KEY=' "$ENV_FILE" | cut -d= -f2- | tr -d "'\"")"
[ -n "$APIKEY" ] || { echo "xəta: AUTHENTICATION_API_KEY tapılmadı" >&2; exit 1; }

PAYLOAD="$(NUMBER="$NUMBER" TEXT="$TEXT" node -e 'process.stdout.write(JSON.stringify({number:process.env.NUMBER,text:process.env.TEXT,linkPreview:false}))')"

echo "instance : $INSTANCE"
echo "nömrə    : $NUMBER"
echo "payload  : $PAYLOAD"

if [ "$DRY" = "--dry" ]; then
  echo "(--dry: göndərilmədi)"
  exit 0
fi

STATE="$(curl -sS -H "apikey: $APIKEY" "$BASE_URL/instance/connectionState/$INSTANCE")"
echo "state    : $STATE"
case "$STATE" in
  *'"state":"open"'*) ;;
  *) echo "xəta: instance qoşulu deyil, göndərilmədi" >&2; exit 1 ;;
esac

BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT
CODE="$(curl -sS -o "$BODY_FILE" -w '%{http_code}' \
  -X POST "$BASE_URL/message/sendText/$INSTANCE" \
  -H "apikey: $APIKEY" -H 'Content-Type: application/json' \
  -d "$PAYLOAD")"

echo "http     : $CODE"
cat "$BODY_FILE"; echo
[ "$CODE" = "201" ] || [ "$CODE" = "200" ]
