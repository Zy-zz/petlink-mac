#!/bin/sh
set -eu
pid=$1
target=$2
candidate=$3
stage=$4
backup="$stage/previous.app"
launch() {
  # Preserve isolated profiles when testing or running a separate local instance.
  set -- -n
  if [ -n "${PETLINK_PROFILE:-}" ]; then set -- "$@" --env "PETLINK_PROFILE=$PETLINK_PROFILE"; fi
  if [ -n "${PETLINK_RELAYS:-}" ]; then set -- "$@" --env "PETLINK_RELAYS=$PETLINK_RELAYS"; fi
  if [ -n "${PETLINK_HIDDEN:-}" ]; then set -- "$@" --env "PETLINK_HIDDEN=$PETLINK_HIDDEN"; fi
  /usr/bin/open "$@" "$target"
}
count=0
while kill -0 "$pid" 2>/dev/null; do
  count=$((count + 1))
  if [ "$count" -gt 120 ]; then
    echo 'PetLink did not exit; original application was kept.'
    exit 1
  fi
  /bin/sleep 0.5
done
rollback() {
  if [ -d "$backup" ]; then
    if [ -e "$target" ]; then /bin/mv "$target" "$stage/failed.app"; fi
    /bin/mv "$backup" "$target"
    launch || true
  fi
}
/bin/mv "$target" "$backup"
trap rollback EXIT
/bin/mv "$candidate" "$target"
launch
trap - EXIT
# The new app removes this directory only after its configuration loads successfully.
