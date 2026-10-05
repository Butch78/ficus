#!/bin/sh
# Trust the egress CA. Run by the sandbox Durable Object after it registers
# its HTTPS routes: the platform writes the per-instance CA only once HTTPS
# interception is on, which is after the container (and its entrypoint)
# started. Idempotent: rebuilds the bundle from the image's original each time.
set -eu
ca=/etc/cloudflare/certs/cloudflare-containers-ca.crt
original=/nix/var/nix/profiles/default/etc/ssl/certs/ca-bundle.crt
# A fresh container can take a while: up to a minute.
for _ in $(seq 1 600); do
  [ -s "$ca" ] && break
  sleep 0.1
done
[ -s "$ca" ] || { echo "no egress CA at $ca" >&2; exit 1; }
cat "$original" "$ca" > /tmp/ca-bundle.crt
rm -f /etc/ssl/certs/ca-bundle.crt
mv /tmp/ca-bundle.crt /etc/ssl/certs/ca-bundle.crt
