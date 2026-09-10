#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-}"
CONTROL_PATH="${2:-}"
SERVICE="${3:-}"

if [[ -z "$ACTION" || -z "$CONTROL_PATH" || -z "$SERVICE" ]]; then
  echo "usage: $0 <start|stop|kill|restart|status|wait-ready> <control-path> <service>" >&2
  exit 1
fi

if [[ ! -f "$CONTROL_PATH" ]]; then
  echo "missing control file: $CONTROL_PATH" >&2
  exit 1
fi

service_json_path=".services[\"$SERVICE\"]"
service_exists="$(jq -r "${service_json_path} != null" "$CONTROL_PATH")"
if [[ "$service_exists" != "true" ]]; then
  echo "service \"$SERVICE\" is not defined in $CONTROL_PATH; skipping"
  exit 0
fi

read_service_field() {
  local field="$1"
  jq -r "${service_json_path}.${field} // empty" "$CONTROL_PATH"
}

pid_file="$(read_service_field "pidFile")"
env_file="$(read_service_field "envFile")"
log_path="$(read_service_field "logPath")"
cwd_path="$(read_service_field "cwd")"
health_url="$(read_service_field "healthUrl")"
rpc_url="$(read_service_field "rpcUrl")"
stream_state_url="$(read_service_field "streamStateUrl")"
app_dir="$(jq -r '.appDir // empty' "$CONTROL_PATH")"
launch_path="$(jq -r '.launchPath // empty' "$CONTROL_PATH")"
start_command="$(read_service_field "startCommand")"
restart_signal="$(read_service_field "restartSignal")"
pid_strategy="$(read_service_field "pidStrategy")"
pid_strategy="${pid_strategy:-listener}"

if [[ -z "$launch_path" || "$launch_path" == *$'\n'* || ":$launch_path:" == *"::"* ]]; then
  echo "control launchPath must be a non-empty colon-delimited path without empty entries" >&2
  exit 1
fi
IFS=':' read -r -a launch_path_entries <<<"$launch_path"
for launch_path_entry in "${launch_path_entries[@]}"; do
  if [[ "$launch_path_entry" != /* ]]; then
    echo "control launchPath entries must be absolute: $launch_path_entry" >&2
    exit 1
  fi
done
if [[ "$pid_strategy" != "root" && "$pid_strategy" != "listener" ]]; then
  echo "service pidStrategy must be root or listener: $pid_strategy" >&2
  exit 1
fi

require_file() {
  local label="$1"
  local path="$2"
  if [[ -z "$path" || ! -f "$path" ]]; then
    echo "missing ${label}: ${path:-<empty>}" >&2
    exit 1
  fi
}

pid_from_file() {
  if [[ -f "$pid_file" ]]; then
    cat "$pid_file" 2>/dev/null || true
  fi
}

port_from_url() {
  local url="$1"
  if [[ -z "$url" ]]; then
    return 0
  fi
  python3 - "$url" <<'PY'
import sys
from urllib.parse import urlparse

url = sys.argv[1]
parsed = urlparse(url)
print(parsed.port or "")
PY
}

listener_pids_for_port() {
  local port="$1"
  if [[ -z "$port" ]]; then
    return 0
  fi
  lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
}

listener_pids_for_service() {
  local port=""
  case "$SERVICE" in
    keeper|hyperia|hyperiaClient|hlsPrimaryOrigin|hlsBackupOrigin)
      port="$(port_from_url "$health_url")"
      ;;
    solanaProxy|anvil)
      port="$(port_from_url "$rpc_url")"
      ;;
  esac
  listener_pids_for_port "$port"
}

stop_pid() {
  local pid="$1"
  if [[ -z "$pid" ]]; then
    return 0
  fi
  if ! kill -0 "$pid" >/dev/null 2>&1; then
    return 0
  fi

  kill "$pid" >/dev/null 2>&1 || true
  for _ in {1..20}; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  kill -9 "$pid" >/dev/null 2>&1 || true
  for _ in {1..5}; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "failed to stop service \"$SERVICE\" (pid $pid)" >&2
  exit 1
}

kill_pid_immediately() {
  local pid="$1"
  if [[ -z "$pid" ]] || ! kill -0 "$pid" >/dev/null 2>&1; then
    return 0
  fi

  kill -9 "$pid" >/dev/null 2>&1 || true
  for _ in {1..10}; do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "failed to hard-stop service \"$SERVICE\" (pid $pid)" >&2
  exit 1
}

process_tree_pids() {
  local root_pid="$1"
  [[ -z "$root_pid" ]] && return 0
  local pending="$root_pid"
  local discovered="$root_pid"
  local current_pid=""
  local child_pid=""

  while [[ -n "$pending" ]]; do
    current_pid="${pending%% *}"
    if [[ "$pending" == *" "* ]]; then
      pending="${pending#* }"
    else
      pending=""
    fi
    while IFS= read -r child_pid; do
      [[ -z "$child_pid" ]] && continue
      if [[ " $discovered " == *" $child_pid "* ]]; then
        continue
      fi
      discovered="$discovered $child_pid"
      pending="${pending:+$pending }$child_pid"
    done < <(pgrep -P "$current_pid" 2>/dev/null || true)
  done

  printf '%s\n' $discovered
}

kill_process_tree_immediately() {
  local root_pid="$1"
  [[ -z "$root_pid" ]] && return 0
  local tree_pids=""
  tree_pids="$(process_tree_pids "$root_pid")"
  [[ -z "$tree_pids" ]] && return 0
  echo "hard-stop-tree service=$SERVICE pids=$(printf '%s' "$tree_pids" | tr '\n' ',')"
  local tree_pid=""
  while IFS= read -r tree_pid; do
    [[ -z "$tree_pid" ]] && continue
    kill -9 "$tree_pid" >/dev/null 2>&1 || true
  done <<<"$tree_pids"
}

stop_service() {
  local pid
  pid="$(pid_from_file)"
  local hard_stop="false"
  if [[ "$ACTION" == "kill" && "$restart_signal" != "SIGKILL" ]]; then
    echo "service \"$SERVICE\" does not authorize an immediate SIGKILL" >&2
    exit 1
  fi
  if [[ "$restart_signal" == "SIGKILL" && ( "$ACTION" == "restart" || "$ACTION" == "kill" ) ]]; then
    hard_stop="true"
    echo "hard-stopping service=$SERVICE pid=${pid:-missing}"
    kill_process_tree_immediately "$pid"
  else
    stop_pid "$pid"
  fi

  local listener_pid
  local listener_pids
  listener_pids="$(listener_pids_for_service)"
  if [[ -n "$listener_pids" ]]; then
    while IFS= read -r listener_pid; do
      [[ -z "$listener_pid" || "$listener_pid" == "$pid" ]] && continue
      if [[ "$hard_stop" == "true" ]]; then
        kill_pid_immediately "$listener_pid"
      else
        stop_pid "$listener_pid"
      fi
    done <<<"$listener_pids"
  fi

  if [[ "$hard_stop" == "true" ]]; then
    local remaining_listener_pids=""
    for _ in {1..20}; do
      remaining_listener_pids="$(listener_pids_for_service)"
      if [[ -z "$remaining_listener_pids" ]]; then
        break
      fi
      while IFS= read -r listener_pid; do
        [[ -z "$listener_pid" ]] && continue
        kill_pid_immediately "$listener_pid"
      done <<<"$remaining_listener_pids"
      sleep 0.25
    done
    remaining_listener_pids="$(listener_pids_for_service)"
    if [[ -n "$remaining_listener_pids" ]]; then
      echo "service \"$SERVICE\" retained a listener after SIGKILL: $remaining_listener_pids" >&2
      exit 1
    fi
    echo "hard-stopped service=$SERVICE listener=none"
  fi

  rm -f "$pid_file"
}

wait_for_http_url() {
  local url="$1"
  for _ in {1..90}; do
    if [[ "$(curl -s -o /dev/null -w "%{http_code}" "$url" || true)" == "200" ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_keeper() {
  wait_for_http_url "$health_url"
}

wait_for_keeper_bot() {
  for _ in {1..90}; do
    local response
    response="$(curl -s "$health_url" || true)"
    if [[ -n "$response" ]] && \
      [[ "$(printf '%s' "$response" | jq -r '.running == true and .health.chainKey == "solana"' 2>/dev/null || true)" == "true" ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_solana_proxy() {
  for _ in {1..90}; do
    local response
    response="$(curl -s -X POST "$rpc_url" \
      -H "content-type: application/json" \
      -d '{"jsonrpc":"2.0","id":1,"method":"getVersion"}' || true)"
    if [[ "$response" == *'"solana-core"'* ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_anvil() {
  for _ in {1..90}; do
    local response
    response="$(curl -s -X POST "$rpc_url" \
      -H "content-type: application/json" \
      -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' || true)"
    if [[ "$response" == *'"result"'* ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_hyperia() {
  if ! wait_for_http_url "$health_url"; then
    return 1
  fi
  if [[ -z "$stream_state_url" ]]; then
    return 0
  fi
  for _ in {1..90}; do
    local response
    response="$(curl -s "$stream_state_url" || true)"
    if [[ "$response" == *'"duelId"'* && "$response" == *'"duelKeyHex"'* ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_hyperia_client() {
  wait_for_http_url "$health_url"
}

wait_for_hls_origin() {
  local expected_label=""
  case "$SERVICE" in
    hlsPrimaryOrigin) expected_label="primary" ;;
    hlsBackupOrigin) expected_label="backup" ;;
  esac
  for _ in {1..90}; do
    if curl -fsS -I "$health_url" 2>/dev/null | tr -d '\r' | \
      grep -qi "^x-hyperbet-e2e-hls-origin: ${expected_label}$"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_service() {
  case "$SERVICE" in
    keeper)
      wait_for_keeper
      ;;
    keeperBot)
      wait_for_keeper_bot
      ;;
    solanaProxy)
      wait_for_solana_proxy
      ;;
    anvil)
      wait_for_anvil
      ;;
    hyperia)
      wait_for_hyperia
      ;;
    hyperiaClient)
      wait_for_hyperia_client
      ;;
    hlsPrimaryOrigin|hlsBackupOrigin)
      wait_for_hls_origin
      ;;
    *)
      echo "unsupported service \"$SERVICE\"" >&2
      exit 1
      ;;
  esac
}

start_shell_service() {
  local env_label="$1"
  local not_ready_message="$2"
  require_file "$env_label" "$env_file"
  mkdir -p "$(dirname "$log_path")"
  local command_string="$start_command"
  if [[ -z "$command_string" ]]; then
    command_string="bun run --cwd \"$cwd_path\" service"
  fi
  local command_prefix=""
  if [[ -n "$cwd_path" ]]; then
    command_prefix="cd \"$cwd_path\" && "
  fi
  /usr/bin/nohup /usr/bin/env PATH="$launch_path" /bin/bash -c "${command_prefix}set -a; source \"$env_file\"; set +a; ${command_string}" \
    >>"$log_path" 2>&1 < /dev/null &
  local launched_pid="$!"
  printf '%s\n' "$launched_pid" >"$pid_file"
  if ! wait_for_service; then
    echo "$not_ready_message" >&2
    tail -n 80 "$log_path" || true
    exit 1
  fi
  if [[ "$pid_strategy" == "listener" ]]; then
    local listener_pid
    listener_pid="$(listener_pids_for_service | head -n 1)"
    if [[ -n "$listener_pid" ]]; then
      printf '%s\n' "$listener_pid" >"$pid_file"
    fi
  fi
}

start_keeper() {
  start_shell_service "keeper env file" "keeper did not become ready after restart"
}

start_keeper_bot() {
  start_shell_service "keeper bot env file" "keeper bot did not become ready after restart"
}

start_solana_proxy() {
  require_file "proxy env file" "$env_file"
  if [[ -z "$app_dir" ]]; then
    echo "missing appDir in $CONTROL_PATH" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$log_path")"
  /usr/bin/nohup /usr/bin/env PATH="$launch_path" /bin/bash -c "set -a; source \"$env_file\"; set +a; node \"$app_dir/scripts/solana-rpc-proxy.mjs\"" \
    >>"$log_path" 2>&1 < /dev/null &
  printf '%s\n' "$!" >"$pid_file"
  if ! wait_for_solana_proxy; then
    echo "solana proxy did not become ready after restart" >&2
    tail -n 80 "$log_path" || true
    exit 1
  fi
  local listener_pid
  listener_pid="$(listener_pids_for_service | head -n 1)"
  if [[ -n "$listener_pid" ]]; then
    printf '%s\n' "$listener_pid" >"$pid_file"
  fi
}

start_anvil() {
  require_file "anvil env file" "$env_file"
  mkdir -p "$(dirname "$log_path")"
  /usr/bin/nohup /usr/bin/env PATH="$launch_path" /bin/bash -c "set -a; source \"$env_file\"; set +a; anvil --silent --host 127.0.0.1 --port \"\$ANVIL_PORT\" --chain-id \"\$EVM_CHAIN_ID\" --state \"\$ANVIL_STATE_PATH\" --state-interval \"\${ANVIL_STATE_INTERVAL:-1}\"" \
    >>"$log_path" 2>&1 < /dev/null &
  printf '%s\n' "$!" >"$pid_file"
  if ! wait_for_anvil; then
    echo "anvil did not become ready after restart" >&2
    tail -n 80 "$log_path" || true
    exit 1
  fi
  local listener_pid
  listener_pid="$(listener_pids_for_service | head -n 1)"
  if [[ -n "$listener_pid" ]]; then
    printf '%s\n' "$listener_pid" >"$pid_file"
  fi
}

start_hyperia() {
  start_shell_service "hyperia env file" "hyperia did not become ready after restart"
}

start_hyperia_client() {
  start_shell_service "hyperia client env file" "hyperia client did not become ready after restart"
}

start_hls_origin() {
  start_shell_service "HLS origin env file" "$SERVICE did not become ready after restart"
}

start_service() {
  case "$SERVICE" in
    keeper)
      start_keeper
      ;;
    keeperBot)
      start_keeper_bot
      ;;
    solanaProxy)
      start_solana_proxy
      ;;
    anvil)
      start_anvil
      ;;
    hyperia)
      start_hyperia
      ;;
    hyperiaClient)
      start_hyperia_client
      ;;
    hlsPrimaryOrigin|hlsBackupOrigin)
      start_hls_origin
      ;;
    *)
      echo "unsupported service \"$SERVICE\"" >&2
      exit 1
      ;;
  esac
}

status_service() {
  local pid=""
  local listener_pid=""
  pid="$(pid_from_file)"
  listener_pid="$(listener_pids_for_service | head -n 1 || true)"
  echo "service=$SERVICE"
  echo "pid=${pid:-}"
  echo "listenerPid=${listener_pid:-}"
  if [[ -n "$health_url" ]]; then
    echo "healthUrl=$health_url"
  fi
  if wait_for_service >/dev/null 2>&1; then
    echo "ready=true"
  else
    echo "ready=false"
  fi
}

case "$ACTION" in
  start)
    stop_service
    start_service
    ;;
  stop)
    stop_service
    ;;
  kill)
    stop_service
    ;;
  restart)
    stop_service
    start_service
    ;;
  status)
    status_service
    ;;
  wait-ready)
    wait_for_service
    ;;
  *)
    echo "unsupported action \"$ACTION\"" >&2
    exit 1
    ;;
esac
