#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  --help|'')
    printf '%s\n' 'Usage: bash install.sh --fresh' 'Creates a new isolated Docker installation; refuses an existing runtime/profile.'
    exit 0
    ;;
  --fresh)
    [[ $# -eq 1 ]] || { printf '%s\n' 'Unexpected arguments' >&2; exit 2; }
    [[ -f /.dockerenv ]] || { printf '%s\n' 'This validated installer is Docker-only; the host is never a target.' >&2; exit 2; }
    root="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"
    exec node "${root:?}/tools/clean-install/install.mjs" --fresh
    ;;
  *) printf '%s\n' 'Usage: bash install.sh --fresh' >&2; exit 2 ;;
esac
