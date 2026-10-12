export type ForgePhase = 'idle' | 'working' | 'stressed' | 'critical' | 'arming' | 'bolt-off' | 'delivering' | 'success' | 'failed';
export type MotionJob = { id: string; status: string; artifacts: unknown[] };

/** Presentation clock only. Terminal outcomes always come from the real job. */
export class ForgeMotion {
  phase: ForgePhase = 'idle';
  workingSeconds = 0;
  blastSeconds = 0;
  private id = '';
  private status = '';
  private observedActive = false;
  private ready = false;
  private elapsed = 0;
  private played = new Set<string>();

  observe(job: MotionJob | undefined, submittedId: string, ready: boolean, reduced: boolean) {
    const id = job?.id ?? '';
    if (id !== this.id) {
      this.id = id;
      this.status = '';
      this.observedActive = false;
      this.workingSeconds = 0;
      this.elapsed = 0;
      this.blastSeconds = 0;
      this.phase = 'idle';
    }
    this.ready = ready;
    const status = job?.status ?? '';
    if (status === 'queued' || status === 'running') {
      this.observedActive = true;
      if (this.status !== 'queued' && this.status !== 'running') this.phase = 'working';
    } else if (status === 'failed' || status === 'interrupted') {
      this.phase = this.observedActive || id === submittedId ? 'failed' : 'idle';
      this.elapsed = 0;
    } else if (status === 'succeeded' && this.status !== 'succeeded') {
      const celebrate = job!.artifacts.length > 0 && !this.played.has(id) && (this.observedActive || id === submittedId);
      if (celebrate) this.played.add(id);
      this.phase = celebrate && !reduced ? 'arming' : 'idle';
      this.elapsed = 0;
    } else if (!job) this.phase = 'idle';
    this.status = status;
    if (reduced && this.revealing) { this.phase = 'success'; this.elapsed = 0; }
  }

  get revealing() { return this.phase === 'arming' || this.phase === 'bolt-off' || this.phase === 'delivering'; }
  get animating() { return ['working', 'stressed', 'critical', 'arming', 'bolt-off', 'delivering'].includes(this.phase); }

  tick(seconds: number) {
    const dt = Math.max(0, Math.min(seconds, .08));
    if (['working', 'stressed', 'critical'].includes(this.phase)) {
      this.workingSeconds += dt;
      this.phase = this.workingSeconds > 4.7 ? 'critical' : this.workingSeconds > 2.7 ? 'stressed' : 'working';
    } else if (this.revealing) {
      this.elapsed += dt;
      // Do not leave an artifact inaccessible if its preview stalls or fails.
      if (this.phase === 'arming' && (this.ready || this.elapsed >= 10)) {
        this.phase = 'bolt-off'; this.elapsed = 0;
      } else if (this.phase === 'bolt-off' && this.elapsed >= .55) {
        this.phase = 'delivering'; this.elapsed = 0;
      } else if (this.phase === 'delivering') {
        this.blastSeconds = this.elapsed;
        if (this.elapsed >= 3.1) this.phase = 'success';
      }
    }
  }
}
