#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "Usage: run-railway-with-scoped-auth.sh <command> [args...]" >&2
  exit 64
fi

railway_token="${RAILWAY_TOKEN:-}"
if [ -z "${railway_token}" ]; then
  echo "RAILWAY_TOKEN must be configured" >&2
  exit 78
fi
case "${railway_token}" in
  *$'\n'* | *$'\r'*)
    echo "RAILWAY_TOKEN is malformed" >&2
    exit 78
    ;;
esac
if [ "${#railway_token}" -gt 4096 ]; then
  echo "RAILWAY_TOKEN is malformed" >&2
  exit 78
fi

runner_temp="${RUNNER_TEMP:-}"
if [ -z "${runner_temp}" ] || [ ! -d "${runner_temp}" ]; then
  echo "RUNNER_TEMP must name an existing private temporary directory" >&2
  exit 78
fi
case "${runner_temp}" in
  /*) ;;
  *)
    echo "RUNNER_TEMP must be an absolute path" >&2
    exit 78
    ;;
esac

context_root="$(pwd -P)"
railway_context="${context_root}/.railway"
if [ -e "${railway_context}" ] || [ -L "${railway_context}" ]; then
  echo "Refusing pre-existing Railway context" >&2
  exit 78
fi

umask 077
auth_home="$(mktemp -d "${runner_temp%/}/hyperbet-railway-auth.XXXXXX")"
mkdir -p \
  "${auth_home}/.config" \
  "${auth_home}/.local/share" \
  "${auth_home}/.local/state" \
  "${auth_home}/.cache"

remove_owned_path() {
  local owned_path="$1"
  if [ -L "${owned_path}" ]; then
    unlink "${owned_path}"
    return
  fi
  if [ -d "${owned_path}" ]; then
    find "${owned_path}" -depth -mindepth 1 -delete
    rmdir "${owned_path}"
    return
  fi
  if [ -e "${owned_path}" ]; then
    rm -f -- "${owned_path}"
  fi
}

cleanup_railway_auth() {
  local cleanup_status=0
  case "${auth_home}" in
    "${runner_temp%/}"/hyperbet-railway-auth.*)
      remove_owned_path "${auth_home}" || cleanup_status=1
      ;;
    *)
      echo "Refusing to clean an unexpected Railway auth path" >&2
      cleanup_status=1
      ;;
  esac
  if [ "${railway_context}" = "${context_root}/.railway" ]; then
    remove_owned_path "${railway_context}" || cleanup_status=1
  else
    echo "Refusing to clean an unexpected Railway context path" >&2
    cleanup_status=1
  fi
  return "${cleanup_status}"
}
trap cleanup_railway_auth EXIT

export HOME="${auth_home}"
export XDG_CONFIG_HOME="${auth_home}/.config"
export XDG_DATA_HOME="${auth_home}/.local/share"
export XDG_STATE_HOME="${auth_home}/.local/state"
export XDG_CACHE_HOME="${auth_home}/.cache"

command_status=0
if "$@"; then
  command_status=0
else
  command_status=$?
fi
unset RAILWAY_TOKEN

for persistence_root in "${auth_home}" "${railway_context}"; do
  if [ -L "${persistence_root}" ]; then
    echo "Railway created an unexpected symlinked credential path" >&2
    command_status=1
    continue
  fi
  if [ -d "${persistence_root}" ] &&
    grep -r -F -q -- "${railway_token}" "${persistence_root}"; then
    echo "Railway persisted the Railway token to disk" >&2
    command_status=1
  fi
done

if cleanup_railway_auth; then
  cleanup_status=0
else
  cleanup_status=$?
fi
trap - EXIT
if [ "${cleanup_status}" -ne 0 ]; then
  command_status=1
fi

exit "${command_status}"
