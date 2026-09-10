#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
deploy_target="${DEPLOY_TARGET:-}"
pages_project_name="${PAGES_PROJECT_NAME:-}"
commit_sha="${GITHUB_SHA:-}"
runner_temp="${RUNNER_TEMP:-}"
github_output="${GITHUB_OUTPUT:-}"

case "${deploy_target}" in
  production)
    pages_environment="production"
    pages_branch="main"
    ;;
  staging)
    pages_environment="preview"
    pages_branch="staging"
    ;;
  *)
    echo "DEPLOY_TARGET must be production or staging" >&2
    exit 78
    ;;
esac

if [[ ! "${commit_sha}" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "GITHUB_SHA must be a full commit SHA" >&2
  exit 78
fi
if [[ ! "${pages_project_name}" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
  echo "PAGES_PROJECT_NAME is invalid" >&2
  exit 78
fi
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
if [ -z "${github_output}" ] || [ ! -f "${github_output}" ] || [ -L "${github_output}" ]; then
  echo "GITHUB_OUTPUT must name an existing regular non-symlink file" >&2
  exit 78
fi
case "${github_output}" in
  /*) ;;
  *)
    echo "GITHUB_OUTPUT must be an absolute path" >&2
    exit 78
    ;;
esac

unset GITHUB_OUTPUT
umask 077
deployment_list_json="$(mktemp "${runner_temp%/}/hyperbet-pages-deployments.XXXXXX.json")"
deployment_output="$(mktemp "${runner_temp%/}/hyperbet-pages-deployment-output.XXXXXX")"

cleanup_pages_deployment_output() {
  local path
  for path in "${deployment_list_json}" "${deployment_output}"; do
    case "${path}" in
      "${runner_temp%/}"/hyperbet-pages-deployments.*.json | \
        "${runner_temp%/}"/hyperbet-pages-deployment-output.*)
        rm -f -- "${path}"
        ;;
      *)
        echo "Refusing to clean an unexpected Pages deployment path" >&2
        return 1
        ;;
    esac
  done
}
trap cleanup_pages_deployment_output EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

deployment_list_status=0
if bash "${script_dir}/run-wrangler-with-scoped-auth.sh" \
  wrangler pages deployment list \
  --project-name "${pages_project_name}" \
  --environment "${pages_environment}" \
  --json >"${deployment_list_json}"; then
  deployment_list_status=0
else
  deployment_list_status=$?
fi

unset CLOUDFLARE_API_TOKEN CLOUDFLARE_WRANGLER_CONFIG_B64
if [ "${deployment_list_status}" -ne 0 ]; then
  exit "${deployment_list_status}"
fi

EXPECTED_COMMIT_SHA="${commit_sha}" \
  EXPECTED_PAGES_ENVIRONMENT="${pages_environment}" \
  EXPECTED_PAGES_BRANCH="${pages_branch}" \
  EXPECTED_PAGES_PROJECT_NAME="${pages_project_name}" \
  node "${script_dir}/ci-solana-pages-deployment-output.mjs" \
  <"${deployment_list_json}" >"${deployment_output}"

if [ ! -f "${github_output}" ] || [ -L "${github_output}" ]; then
  echo "GITHUB_OUTPUT changed before validated output publication" >&2
  exit 1
fi
cat "${deployment_output}" >>"${github_output}"
