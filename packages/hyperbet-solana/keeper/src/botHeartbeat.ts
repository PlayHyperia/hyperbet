export type KeeperBotHeartbeatOptions = {
  intervalMs: number;
  probe: () => Promise<void>;
  onRpcSuccess: () => void;
  writeSnapshot: () => void;
  onProbeError?: (error: unknown) => void;
};

export type KeeperBotHeartbeat = {
  start: () => void;
  stop: () => void;
  tick: () => Promise<boolean>;
  isRunning: () => boolean;
  isProbeInFlight: () => boolean;
};

export function createKeeperBotHeartbeat(
  options: KeeperBotHeartbeatOptions,
): KeeperBotHeartbeat {
  if (!Number.isInteger(options.intervalMs) || options.intervalMs < 250) {
    throw new Error("keeper bot heartbeat interval must be at least 250ms");
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let probeInFlight = false;

  const tick = async (): Promise<boolean> => {
    if (stopped || probeInFlight) return false;
    probeInFlight = true;
    try {
      await options.probe();
      if (stopped) return false;
      options.onRpcSuccess();
      return true;
    } catch (error) {
      options.onProbeError?.(error);
      return false;
    } finally {
      if (!stopped) options.writeSnapshot();
      probeInFlight = false;
    }
  };

  return {
    start: () => {
      if (timer) return;
      stopped = false;
      timer = setInterval(() => {
        void tick();
      }, options.intervalMs);
      timer.unref?.();
    },
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
    isRunning: () => timer != null,
    isProbeInFlight: () => probeInFlight,
  };
}
