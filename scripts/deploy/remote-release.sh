#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
shift || true

prepare_incoming() {
  [[ $# == 1 ]] || { echo 'usage: remote-release.sh prepare INCOMING' >&2; exit 64; }
  local incoming="$1" current_user
  current_user="$(id -un)"

  [[ "$incoming" == /opt/dx-rework/incoming/* ]] || {
    echo 'incoming path is outside /opt/dx-rework/incoming' >&2
    exit 64
  }

  for path in /opt/dx-rework /opt/dx-rework/incoming; do
    [[ -d "$path" && ! -L "$path" ]] || {
      echo "required directory is missing or unsafe: $path" >&2
      exit 1
    }
    [[ "$(stat -c %U "$path")" == "$current_user" ]] || {
      echo "directory owner mismatch: $path" >&2
      exit 1
    }
    mode_bits="$(stat -c %a "$path")"
    (( (8#$mode_bits & 0022) == 0 )) || {
      echo "directory is group/world writable: $path" >&2
      exit 1
    }
  done

  [[ ! -e "$incoming" && ! -L "$incoming" ]] || {
    echo 'incoming directory already exists' >&2
    exit 1
  }
  mkdir -m 0700 "$incoming"
}

apply_release() {
  [[ $# == 4 ]] || {
    echo 'usage: remote-release.sh apply INCOMING SHA APPLY_MIGRATIONS RUN_ID' >&2
    exit 64
  }
  local incoming="$1" sha="$2" apply_migrations="$3" run_id="$4" bundle actual_sha

  [[ "$incoming" == /opt/dx-rework/incoming/* ]] || {
    echo 'incoming path is outside /opt/dx-rework/incoming' >&2
    exit 64
  }
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'invalid release SHA' >&2; exit 64; }
  [[ "$apply_migrations" == true || "$apply_migrations" == false ]] || {
    echo 'invalid apply-migrations switch' >&2
    exit 64
  }
  [[ "$run_id" =~ ^[0-9]+$ ]] || { echo 'invalid GitHub run ID' >&2; exit 64; }
  [[ -f "$incoming/transfer.tar.gz" && ! -L "$incoming/transfer.tar.gz" ]] || {
    echo 'transfer archive is missing or unsafe' >&2
    exit 1
  }

  python3 - "$incoming/transfer.tar.gz" "$incoming" <<'PY'
import sys
import tarfile

archive, destination = sys.argv[1:]
with tarfile.open(archive, "r:gz") as tar:
    for member in tar.getmembers():
        parts = member.name.split("/")
        if (
            member.name.startswith("/")
            or any(part in ("", ".", "..") for part in parts)
            or not (member.isfile() or member.isdir())
        ):
            raise SystemExit("unsafe tar entry")
    tar.extractall(destination, filter="data")
PY

  bundle="$incoming/$sha"
  [[ -d "$bundle/api" && -d "$bundle/frontend" && -f "$bundle/SHA256SUMS" ]] || {
    echo 'release bundle is incomplete' >&2
    exit 1
  }

  actual_sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["gitSha"])' "$bundle/release-manifest.json")"
  [[ "$actual_sha" == "$sha" ]] || { echo 'bundle SHA mismatch' >&2; exit 1; }

  (cd "$bundle" && sha256sum -c --strict SHA256SUMS)
  (cd "$bundle/api" && sha256sum -c --strict SHA256SUMS)
  (cd "$bundle/frontend" && sha256sum -c --strict SHA256SUMS)

  DX_REWORK_APPLY=true \
  DX_REWORK_ENVIRONMENT_APPROVED=true \
  DX_REWORK_CONFIRM_RELEASE="$sha" \
  DX_REWORK_APPLY_MIGRATIONS="$apply_migrations" \
  GITHUB_RUN_ID="$run_id" \
    "$bundle/api/scripts/deploy/release.sh" "$sha" "$bundle"
}

case "$mode" in
  prepare)
    prepare_incoming "$@"
    ;;
  apply)
    apply_release "$@"
    ;;
  *)
    echo 'usage: remote-release.sh prepare|apply ...' >&2
    exit 64
    ;;
esac
