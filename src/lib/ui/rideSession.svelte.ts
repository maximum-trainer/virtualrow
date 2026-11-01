/**
 * The ride-session store (#542 workout slice) — the live rower pipeline App.tsx
 * ran while a session was on, ported to a Svelte 5 runes store.
 *
 * It holds what the workout screen reads every frame: the latest rower packet,
 * the recording session, the heart-rate samples, the start sequence and the
 * finish. App subscribed the rower and heart-rate services for the lifetime of
 * the component — not from the device panels — so a session kept recording
 * after the view switched from Routes to the workout; the same reasoning keeps
 * those subscriptions here, on a store held in the shell that outlives every
 * navigation, alongside {@link SessionStore} (which owns device connection and
 * the start/demo actions).
 *
 * The 3D scene itself is the engine's (`src/lib/renderer/`), reached through the
 * `Canvas3DHost` seam; this store feeds it the per-frame row state via
 * {@link RideSessionStore.frame}. Services and the frame scheduler are injected
 * (defaulting to the production singletons) so a test drives the pipeline with
 * stubs and a synchronous scheduler, mirroring the other shell stores.
 */
import type { PM5Data, HeartRateSample, WaterRoute, WorkoutSession } from '../types/index';
import { bluetoothService } from '../services/bluetoothService';
import { ftmsBluetoothService } from '../services/ftmsBluetoothService';
import { heartRateBluetoothService } from '../services/heartRateBluetoothService';
import { workoutService } from '../services/workoutService';
import { pm5Simulator } from '../services/pm5SimulatorService';
import { heartRateSimulator } from '../services/heartRateSimulatorService';
import { formatSplit } from '../utils/formatters';
import {
  paceGhost,
  ghostDistanceAt,
  ghostFinishSeconds,
  gapMeters,
  type GhostSource,
} from '../../components/rower3d/ghost';
import { bestPaceOnRoute } from '../utils/sessionSummary';
import {
  saveCompletedSession,
  markSessionUploaded,
  loadSessions,
} from '../services/localStorageWorkoutStore';
import { StartSequenceStore, isStrokeReading } from './startSequence.svelte';
import type { SessionState, RowerType } from './sessionStore.svelte';
import type { GhostChoice } from './ghostChoice';
import type { ChallengeResult } from '../services/challengesService';
import type { RideFrame } from './rideCanvas';
import {
  defaultRideLoop,
  finishDistanceMeters,
  finishTimeSeconds,
  lapsCompleted,
  type RideLoop,
  type RideLoopTarget,
} from './rideLoop';

export type { RideFrame };

/** The finish banner stays up this long, then the session ends (App FINISH_BANNER_MS). */
export const FINISH_BANNER_MS = 2000;

/** A rower BLE service, down to the slice the pipeline subscribes to. */
interface RowerEventSource {
  on(event: string, listener: (data: unknown) => void): void;
  off(event: string, listener: (data: unknown) => void): void;
}

/** The slice of {@link SessionStore} this store reads and drives. */
export interface RideSessionSession {
  activeRowerType: RowerType;
  isDemoMode: boolean;
  sessionActive: boolean;
  sessionState: SessionState;
  selectedRowerConnected: boolean;
  hrConnected: boolean;
  ghostChoice: GhostChoice;
  currentWorkout: {
    stop(): void;
    tick(data: PM5Data): void;
    /** The structured workout's speed factor, undefined for a free row. */
    readonly speedFactor?: number;
  };
}

/** The slice of {@link RoutesStore} this store reads. */
export interface RideSessionRoutes {
  selectedRoute: WaterRoute | null;
}

/**
 * The slice of {@link AuthStore} this store reads, to decide the guest vs
 * signed-in summary and to key the local save/history (App read `user`).
 * Defaults to signed-out so the store still constructs with two arguments.
 */
export interface RideSessionAuth {
  readonly user: { id: string } | null;
  readonly isAuthenticated: boolean;
}

export interface RideSessionDeps {
  workoutService: Pick<
    typeof workoutService,
    | 'updateSessionWithPM5Data'
    | 'updateSessionHeartRate'
    | 'getCurrentSession'
    | 'pauseSession'
    | 'resumeSession'
    | 'endSession'
  >;
  bluetoothService: RowerEventSource;
  ftmsBluetoothService: RowerEventSource;
  heartRateBluetoothService: RowerEventSource;
  pm5Simulator: Pick<typeof pm5Simulator, 'addListener' | 'removeListener' | 'stop'>;
  heartRateSimulator: Pick<typeof heartRateSimulator, 'stop'>;
  /** Frame scheduler, injected so a test runs the deferred updates synchronously. */
  raf: (cb: () => void) => void;
  now: () => number;
}

const defaultDeps = (): RideSessionDeps => ({
  workoutService,
  bluetoothService,
  ftmsBluetoothService,
  heartRateBluetoothService,
  pm5Simulator,
  heartRateSimulator,
  raf:
    typeof requestAnimationFrame !== 'undefined'
      ? (cb) => void requestAnimationFrame(() => cb())
      : (cb) => void setTimeout(cb, 0),
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
});

export class RideSessionStore {
  #deps: RideSessionDeps;
  #session: RideSessionSession;
  #routes: RideSessionRoutes;
  #auth: RideSessionAuth;

  // Live state read by the workout view each frame.
  pm5Data = $state<PM5Data | null>(null);
  currentSession = $state<WorkoutSession | null>(null);
  heartRateSamples = $state<HeartRateSample[]>([]);
  strokeAt = $state<number | null>(null);
  finish = $state<{ distanceMeters: number; elapsedMs: number } | null>(null);
  activityElapsedMs = $state(0);

  // The row just finished, held so the post-finish summary can show it over
  // the Routes screen (App's completedSession / guestCompletedSession). A
  // signed-in row goes in `completedSession`; a guest's in
  // `guestCompletedSession`; `completedSessionWasDemo` flags a simulated row,
  // which keeps the summary but never the upload (R5).
  completedSession = $state<WorkoutSession | null>(null);
  guestCompletedSession = $state<WorkoutSession | null>(null);
  completedSessionWasDemo = $state(false);
  /**
   * The challenge this row is being rowed against (#415 Phase 4). Set by
   * the Challenges screen's "Row this course" / "Race this time" buttons;
   * read by the SessionSummary to render the "would have been Nth of M"
   * line (AC5.1). Cleared on the next non-challenge selection and on
   * `sessionDone`. The leaderboard snapshot is captured at pick time, so
   * late submissions do not change what the summary says.
   */
  challengeInProgress = $state<{
    challengeName: string;
    courseDistanceMeters: number;
    results: ChallengeResult[];
  } | null>(null);

  /**
   * Loop policy for the ride (#647). When `enabled`, the boat wraps back to
   * the start when it reaches the route finish, and the finish fires on the
   * target (distance / time / free) rather than on route length. Default is
   * off — today's route-length-finish behaviour is unchanged. A challenge or
   * ghost race forces this off (FR9/FR10) because those rows are scored on the
   * route's own distance.
   */
  loop = $state<RideLoop>(defaultRideLoop());

  readonly startSequence = new StartSequenceStore();

  // Plain (non-reactive) guards mirroring App's refs.
  #strokeSeen = false;
  #finishing = false;
  #pending: PM5Data | null = null;
  #rafScheduled = false;
  #hrProcessing = false;
  #activityTimer: ReturnType<typeof setInterval> | null = null;
  #finishTimer: ReturnType<typeof setTimeout> | null = null;

  readonly latestHeartRate = $derived(
    this.heartRateSamples.length > 0
      ? this.heartRateSamples[this.heartRateSamples.length - 1].bpm
      : (this.pm5Data?.heartRate ?? null),
  );
  readonly workoutElapsedTimeMs = $derived(
    this.pm5Data?.elapsedTime ? this.pm5Data.elapsedTime * 1000 : this.activityElapsedMs,
  );
  readonly elapsedSeconds = $derived(this.workoutElapsedTimeMs / 1000);
  readonly strokeIntensity = $derived(Math.min(1, Math.max(0.2, (this.pm5Data?.power ?? 0) / 300)));
  // These read the injected stores, so they defer through `$derived.by`: a
  // field initializer runs before the constructor assigns `#session`/`#routes`.
  readonly activityProgressPercent = $derived.by(() =>
    this.pm5Data && this.#routes.selectedRoute
      ? Math.min(100, (this.pm5Data.distance / 1000) / this.#routes.selectedRoute.distance * 100)
      : 0,
  );

  /**
   * Laps completed on the selected route (#647 FR4). Floor of
   * `distanceMeters / routeMeters`; 0 before the first seam. The HUD reads
   * `laps + 1` as the current lap and `laps` as the completed count.
   */
  readonly laps = $derived.by(() => {
    const route = this.#routes.selectedRoute;
    if (!route || !this.pm5Data) return 0;
    return lapsCompleted(this.pm5Data.distance, route.distance * 1000);
  });

  /**
   * True while loop mode must be forced off — a challenge row is scored on the
   * course's own distance (#647 FR9), so looping is not a user choice there.
   * The UI reflects this by disabling the toggle; the finish logic reflects
   * it by reading `effectiveLoop`, not `loop`, so a stale `loop.enabled` from
   * before the challenge was picked still produces the leaderboard-defined
   * finish.
   */
  readonly loopLocked = $derived.by(() => this.challengeInProgress !== null);

  /**
   * The loop policy the finish detector and the engine actually read. Falls
   * back to the route-finish default when `loopLocked` is true.
   */
  readonly effectiveLoop = $derived.by<RideLoop>(() =>
    this.loopLocked ? defaultRideLoop() : this.loop,
  );

  /** The ghost to race, resolved from the chosen option (App `ghostSource`). */
  readonly ghostSource = $derived.by<GhostSource | null>(() =>
    this.#session.ghostChoice.kind === 'pace'
      ? paceGhost(this.#session.ghostChoice.paceSPer500)
      : null,
  );
  readonly #ghostLabel = $derived.by(() => {
    const choice = this.#session.ghostChoice;
    if (choice.kind !== 'pace') return 'your best';
    // #415 AC4.4 — chasing a leaderboard time names who set it, not the
    // pace. Picker-set paces (no name) fall through to the #338 wording.
    return choice.displayName ?? `a ${formatSplit(choice.paceSPer500)} pace`;
  });

  /**
   * The gap to the ghost for the HUD (#338). Null until the row has actually
   * started — two boats on the line have no gap worth reading.
   */
  readonly ghostGap = $derived.by(() => {
    const ghost = this.ghostSource;
    if (!ghost) return null;
    const rowerMeters = this.pm5Data?.distance ?? 0;
    const started = this.workoutElapsedTimeMs > 0 && rowerMeters > 0;
    return {
      gapMeters: started
        ? gapMeters(rowerMeters, ghostDistanceAt(ghost, this.workoutElapsedTimeMs / 1000))
        : null,
      label: this.#ghostLabel,
    };
  });

  /**
   * How the race came out, for the summary (App `completedGhost`, #338). The
   * ghost's time to the distance the row actually covered, so a row cut short
   * is compared where it stopped rather than at a finish neither boat reached.
   */
  readonly completedGhost = $derived.by(() => {
    const completed = this.completedSession;
    const source = this.ghostSource;
    if (!completed || !source) return null;
    return { seconds: ghostFinishSeconds(source, completed.distance), label: this.#ghostLabel };
  });

  /**
   * This athlete's best on the route before this row (App `completedSessionBest`,
   * #337). None for a demo row, which is not theirs to compare, or without an
   * athlete to ask about.
   */
  readonly completedSessionBest = $derived.by(() => {
    const completed = this.completedSession;
    if (!completed || !this.#auth.user || this.completedSessionWasDemo) return undefined;
    return bestPaceOnRoute(loadSessions(this.#auth.user.id), completed);
  });

  constructor(
    session: RideSessionSession,
    routes: RideSessionRoutes,
    deps: Partial<RideSessionDeps> = {},
    auth: RideSessionAuth = { user: null, isAuthenticated: false },
  ) {
    this.#session = session;
    this.#routes = routes;
    this.#deps = { ...defaultDeps(), ...deps };
    this.#auth = auth;
  }

  /**
   * Subscribe to the rower and heart-rate services for the app's lifetime and
   * return a teardown. Only the selected rower drives the session; both stay
   * subscribed so a device left connected on the other tab does not interleave
   * its frames (App.tsx `activeRowerTypeRef`).
   */
  init(): () => void {
    const onPm5 = (data: unknown) => {
      if (this.#session.activeRowerType === 'pm5') this.#handleData(data as PM5Data);
    };
    const onFtms = (data: unknown) => {
      if (this.#session.activeRowerType === 'ftms') this.#handleData(data as PM5Data);
    };
    const onHr = (payload: unknown) => {
      const { bpm } = (payload ?? {}) as { bpm?: number };
      if (typeof bpm !== 'number') return;
      if (this.#hrProcessing) return;
      this.#hrProcessing = true;
      try {
        this.#deps.workoutService.updateSessionHeartRate(bpm);
      } finally {
        this.#hrProcessing = false;
      }
      this.#deps.raf(() => {
        const session = this.#deps.workoutService.getCurrentSession();
        this.heartRateSamples = session?.heartRateSamples ? [...session.heartRateSamples] : [];
      });
    };

    this.#deps.bluetoothService.on('data', onPm5);
    this.#deps.ftmsBluetoothService.on('data', onFtms);
    this.#deps.heartRateBluetoothService.on('heartRate', onHr);

    return () => {
      this.#deps.bluetoothService.off('data', onPm5);
      this.#deps.ftmsBluetoothService.off('data', onFtms);
      this.#deps.heartRateBluetoothService.off('heartRate', onHr);
      this.#stopActivityTimer();
      this.#clearFinishTimer();
    };
  }

  #demoListening = false;
  /** The demo feeds the same pipeline directly from the simulator (App gate). */
  setDemoListening(on: boolean): void {
    if (on === this.#demoListening) return;
    this.#demoListening = on;
    if (on) this.#deps.pm5Simulator.addListener(this.#demoListener);
    else this.#deps.pm5Simulator.removeListener(this.#demoListener);
  }
  #demoListener = (data: PM5Data): void => this.#handleData(data);

  /**
   * Start or stop the activity-elapsed timer with the session, and clear the
   * row's transient state when it ends (App's timer effect + the sessionEnded
   * listener). The owner drives this from an `$effect` on `session.sessionActive`.
   */
  setActive(active: boolean): void {
    if (active) {
      if (this.#activityTimer !== null) return;
      const startTime = Date.now();
      this.#activityTimer = setInterval(() => {
        this.activityElapsedMs = Date.now() - startTime;
      }, 250);
    } else {
      this.#stopActivityTimer();
      this.#clearFinishTimer();
      this.activityElapsedMs = 0;
      this.#strokeSeen = false;
      this.#finishing = false;
      this.strokeAt = null;
      this.finish = null;
      this.pm5Data = null;
      this.currentSession = null;
      this.heartRateSamples = [];
      this.startSequence.reset();
    }
  }

  /** Seed the recording session when it starts (App's sessionStarted listener). */
  onStarted(session: WorkoutSession | null): void {
    this.currentSession = session ?? null;
  }

  /**
   * Feed a simulated PM5 frame from the debug panel's PM5 simulator into the
   * same intake the demo uses (App wired the simulator through `handlePM5Data`).
   */
  onSimulatedData(data: PM5Data): void {
    this.#handleData(data);
  }

  /**
   * Update the loop policy for the ride (#647 FR1/FR2). The pre-row panel
   * calls this to turn looping on and pick a target. Ignored while the
   * current row is challenge-gated (`loopLocked`), so a late pick cannot
   * destabilise a challenge in progress.
   */
  setLoop(next: RideLoop | ((prev: RideLoop) => RideLoop)): void {
    if (this.loopLocked) return;
    const resolved = typeof next === 'function' ? next(this.loop) : next;
    this.loop = resolved;
  }

  /** Convenience: flip the loop toggle without touching the target. */
  setLoopEnabled(enabled: boolean): void {
    this.setLoop((prev) => ({ ...prev, enabled }));
  }

  /** Convenience: pick a loop target (and leave `enabled` as-is). */
  setLoopTarget(target: RideLoopTarget): void {
    this.setLoop((prev) => ({ ...prev, target }));
  }

  pauseWorkout(): void {
    this.#session.sessionState = 'paused';
    this.#deps.workoutService.pauseSession();
  }

  resumeWorkout(): void {
    this.#session.sessionState = 'active';
    this.#deps.workoutService.resumeSession();
  }

  /** Reset the live metrics but keep the session (App `handleResetWorkout`). */
  resetWorkout(): void {
    this.activityElapsedMs = 0;
  }

  /**
   * End the row (App `handleEndWorkout`). `workoutService.endSession()`
   * dispatches `virtualrow:sessionEnded`, which the shell turns into navigation
   * back to Routes and `setActive(false)`; the completed row is then held so the
   * summary can show over the Routes screen.
   *
   * A guest's row goes to `guestCompletedSession`; a signed-in row is kept
   * locally before any upload (so a row the athlete declines to upload still
   * survives a reload, AC6.1) and goes to `completedSession`. The guest/
   * signed-in split follows the row's own `isGuest` flag, set from the guest
   * mode in force when it started.
   */
  endWorkout(): void {
    this.#clearFinishTimer();
    this.#finishing = false;
    this.finish = null;
    this.#strokeSeen = false;
    this.strokeAt = null;
    const completed = this.#deps.workoutService.endSession();
    this.#session.currentWorkout.stop();
    const wasDemo = this.#session.isDemoMode;
    this.completedSessionWasDemo = wasDemo;
    if (wasDemo) {
      this.#deps.pm5Simulator.stop();
      this.#deps.heartRateSimulator.stop();
    }

    if (!completed) return;

    if (completed.isGuest) {
      this.guestCompletedSession = completed;
      return;
    }

    if (this.#auth.user) saveCompletedSession(this.#auth.user.id, completed, { isDemo: wasDemo });
    this.completedSession = completed;
  }

  /** Record that the signed-in row reached intervals.icu (App `handleSessionSaved`, AC6.2). */
  sessionSaved(activityId: string): void {
    const completed = this.completedSession;
    if (this.#auth.user && completed) {
      markSessionUploaded(this.#auth.user.id, completed.id, activityId);
    }
  }

  /** Dismiss the signed-in summary (App `handleSessionDone`); the shell is already on Routes. */
  sessionDone(): void {
    this.completedSession = null;
    this.challengeInProgress = null;
  }

  /** Dismiss the guest summary (App `handleGuestRowAgain` / `handleGuestExit`). */
  guestDone(): void {
    this.guestCompletedSession = null;
  }

  /** The per-frame snapshot the engine pulls through the canvas seam. */
  frame(): RideFrame {
    return {
      paceSPer500: this.pm5Data?.pace ?? null,
      distanceMeters: this.pm5Data?.distance ?? null,
      cadence: this.pm5Data?.cadence ?? null,
      isPlaying: this.#session.sessionActive && this.#session.sessionState === 'active',
      holdBoat: this.startSequence.holdBoat,
      finished: this.finish !== null,
      // The structured workout's speed factor, 1 for a free row (App `intensityFactor`).
      intensityFactor: this.#session.currentWorkout.speedFactor ?? 1,
      elapsedSeconds: this.workoutElapsedTimeMs / 1000,
      ghost: this.ghostSource,
      loop: this.effectiveLoop.enabled,
    };
  }

  /** App `handlePM5Data`: update the service now, defer the React-ish state to a frame. */
  #handleData(data: PM5Data): void {
    this.#deps.workoutService.updateSessionWithPM5Data(data);

    // The first stroke starts the countdown from a timer, not from the frame
    // below: a software renderer draws about a frame a second.
    if (this.#session.sessionActive && !this.#strokeSeen && isStrokeReading(data)) {
      this.#strokeSeen = true;
      const at = Date.now();
      setTimeout(() => {
        if (this.#strokeSeen) this.strokeAt = at;
      }, 0);
    }

    this.#pending = data;
    if (this.#rafScheduled) return;
    this.#rafScheduled = true;
    this.#deps.raf(() => {
      this.#rafScheduled = false;
      const latest = this.#pending;
      if (!latest) return;

      this.pm5Data = latest;
      // Advance the structured workout, if one is running; no-op for a free row.
      this.#session.currentWorkout.tick(latest);

      if (!this.#session.sessionActive) return;
      if (latest.heartRate) {
        const updated = this.#deps.workoutService.getCurrentSession();
        this.heartRateSamples = updated?.heartRateSamples ? [...updated.heartRateSamples] : [];
      }
      // Read straight from the service so mutated distance/duration are current.
      const latestSession = this.#deps.workoutService.getCurrentSession();
      this.currentSession = latestSession ? { ...latestSession } : null;

      this.#maybeFinish(latest, latestSession);
    });
  }

  /**
   * Finish when the row reaches the loop target (#647 FR5). Target `route`
   * (the default) keeps the historical "finish at route length" behaviour
   * through the same 99.5 % threshold, so a loop-off row behaves exactly as
   * before. A `distance` target fires at the chosen metres (also with a
   * 99.5 % threshold so the PM5's sample grid lands cleanly on the cue);
   * a `time` target fires on elapsed seconds; `free` never auto-finishes.
   */
  #maybeFinish(latest: PM5Data, latestSession: WorkoutSession | null): void {
    const route = this.#routes.selectedRoute;
    if (!route || typeof window === 'undefined') return;
    if (window.__PLAYWRIGHT_TESTING && !window.__VIRTUALROW_AUTO_FINISH) return;
    if (this.#finishing) return;
    const routeDistanceMeters = route.distance * 1000;
    const loop = this.effectiveLoop;

    const targetMeters = finishDistanceMeters(loop, routeDistanceMeters);
    const targetSeconds = finishTimeSeconds(loop);
    const elapsedSeconds = latest.elapsedTime ?? (latestSession?.duration ?? 0);

    const hitsDistance =
      targetMeters !== null && targetMeters > 0 && latest.distance >= targetMeters * 0.995;
    const hitsTime =
      targetSeconds !== null && targetSeconds > 0 && elapsedSeconds >= targetSeconds;

    if (!hitsDistance && !hitsTime) return;

    this.#finishing = true;
    const finalMeters = hitsDistance && targetMeters !== null ? targetMeters : latest.distance;
    this.finish = {
      distanceMeters: finalMeters,
      elapsedMs: elapsedSeconds * 1000,
    };
    this.#finishTimer = setTimeout(() => this.endWorkout(), FINISH_BANNER_MS);
  }

  #stopActivityTimer(): void {
    if (this.#activityTimer !== null) {
      clearInterval(this.#activityTimer);
      this.#activityTimer = null;
    }
  }

  #clearFinishTimer(): void {
    if (this.#finishTimer !== null) {
      clearTimeout(this.#finishTimer);
      this.#finishTimer = null;
    }
  }
}
