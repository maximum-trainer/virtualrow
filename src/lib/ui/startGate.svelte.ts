/**
 * #741 VP-21 FR5 — Start and the demo row wait for the selected route's map
 * data by default. A route's OSM enrichment can take tens of seconds, and a
 * row started before it lands opens on the generic canal. A held start runs
 * the moment the data is in; `startNow` is the visible "start now with
 * simple scenery" escape. The late data is still applied mid-row when it
 * arrives (#746).
 */
export type StartKind = 'workout' | 'demo';

export class StartGate {
  /** The start being held, if any. */
  pending = $state<StartKind | null>(null);
  #run: (() => void) | null = null;

  /** Start now if the route data is in, otherwise hold the start. */
  request(kind: StartKind, loading: boolean, run: () => void): void {
    if (!loading) {
      this.cancel();
      run();
      return;
    }
    this.pending = kind;
    this.#run = run;
  }

  /** Feed the loading flag; a held start runs once it clears. */
  update(loading: boolean): void {
    if (!loading && this.#run) this.startNow();
  }

  /** Run the held start without waiting. */
  startNow(): void {
    const run = this.#run;
    this.cancel();
    run?.();
  }

  cancel(): void {
    this.pending = null;
    this.#run = null;
  }
}
