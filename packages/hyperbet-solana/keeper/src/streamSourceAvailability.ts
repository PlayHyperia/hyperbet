export type StreamSourceAvailabilityState = {
  unavailablePublished: boolean;
};

export type StreamSourceAvailabilityEvent =
  "disconnected" | "authoritative-frame";

export type StreamSourceAvailabilityTransition = {
  state: StreamSourceAvailabilityState;
  publishUnavailable: boolean;
};

/**
 * A relay process cannot inherit live-source authority across its own restart.
 * Treat a configured upstream as unavailable until this process observes its
 * first authoritative frame. That lets a restarted producer establish a new,
 * strictly newer timestamp even when its sequence counter legitimately reset.
 */
export function createInitialStreamSourceAvailability(
  sourceConfigured: boolean,
): StreamSourceAvailabilityState {
  return { unavailablePublished: sourceConfigured };
}

export function isStreamSourceAvailable(
  state: StreamSourceAvailabilityState,
): boolean {
  return !state.unavailablePublished;
}

export function transitionStreamSourceAvailability(
  state: StreamSourceAvailabilityState,
  event: StreamSourceAvailabilityEvent,
): StreamSourceAvailabilityTransition {
  if (event === "authoritative-frame") {
    return {
      state: { unavailablePublished: false },
      publishUnavailable: false,
    };
  }

  return {
    state: { unavailablePublished: true },
    publishUnavailable: !state.unavailablePublished,
  };
}
