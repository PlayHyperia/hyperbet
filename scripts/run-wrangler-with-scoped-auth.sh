#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "Usage: run-wrangler-with-scoped-auth.sh <command> [args...]" >&2
  exit 64
fi

cloudflare_api_token="${CLOUDFLARE_API_TOKEN:-}"
wrangler_config_b64="${CLOUDFLARE_WRANGLER_CONFIG_B64:-}"

if { [ -n "${cloudflare_api_token}" ] && [ -n "${wrangler_config_b64}" ]; } ||
  { [ -z "${cloudflare_api_token}" ] && [ -z "${wrangler_config_b64}" ]; }; then
  echo "Exactly one Cloudflare credential source must be configured" >&2
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

umask 077
auth_home="$(mktemp -d "${runner_temp%/}/hyperbet-wrangler-auth.XXXXXX")"

cleanup_wrangler_auth() {
  case "${auth_home}" in
    "${runner_temp%/}"/hyperbet-wrangler-auth.*)
      if [ -d "${auth_home}" ]; then
        find "${auth_home}" -depth -mindepth 1 -delete
        rmdir "${auth_home}"
      fi
      ;;
    *)
      echo "Refusing to clean an unexpected Wrangler auth path" >&2
      return 1
      ;;
  esac
}
trap cleanup_wrangler_auth EXIT

export HOME="${auth_home}"
export XDG_CONFIG_HOME="${auth_home}/.config"

if [ -n "${wrangler_config_b64}" ]; then
  wrangler_config_path="${HOME}/.wrangler/config/default.toml"
  mkdir -p "$(dirname "${wrangler_config_path}")"
  printf '%s' "${wrangler_config_b64}" |
    openssl base64 -d -A >"${wrangler_config_path}"
  if [ ! -s "${wrangler_config_path}" ]; then
    echo "Cloudflare Wrangler config decoded to an empty file" >&2
    exit 78
  fi
  chmod 600 "${wrangler_config_path}"
fi

unset CLOUDFLARE_WRANGLER_CONFIG_B64

command_status=0
if "$@"; then
  command_status=0
else
  command_status=$?
fi

if [ -n "${cloudflare_api_token}" ] &&
  grep -R -F -q -- "${cloudflare_api_token}" "${auth_home}"; then
  echo "Wrangler persisted the Cloudflare API token to disk" >&2
  command_status=1
fi

exit "${command_status}"
