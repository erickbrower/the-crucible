// A small fixed-size worker pool so matchups run on every CPU core.
import { Worker } from 'node:worker_threads';
import os from 'node:os';
import type { MatchTask, WorkerMsg } from './worker.js';

type Done = Extract<WorkerMsg, { type: 'done' }>['result'];
interface Pending {
  task: MatchTask;
  group: string;                       // job id, so a whole job can be cancelled
  onProgress: (done: number) => void;
  resolve: (r: Done) => void;
  reject: (e: Error) => void;
}

export class Pool {
  private idle: Worker[] = [];
  private busy = new Map<Worker, Pending>();
  private queue: Pending[] = [];
  private nextId = 1;
  readonly size: number;

  constructor(size = Math.max(1, Math.min(8, os.cpus().length - 1))) {
    this.size = size;
    for (let i = 0; i < size; i++) this.idle.push(this.spawn());
  }

  private spawn(): Worker {
    const w = new Worker(new URL('./worker-boot.mjs', import.meta.url));
    w.on('message', (m: WorkerMsg) => {
      const p = this.busy.get(w);
      if (!p || p.task.id !== m.id) return;
      if (m.type === 'progress') { p.onProgress(m.done); return; }
      this.busy.delete(w);
      this.idle.push(w);
      if (m.type === 'done') p.resolve(m.result); else p.reject(new Error(m.error));
      this.pump();
    });
    w.on('error', (e: Error) => {
      const p = this.busy.get(w);
      this.busy.delete(w);
      this.idle.push(this.spawn());
      p?.reject(e);
      this.pump();
    });
    return w;
  }

  run(group: string, task: Omit<MatchTask, 'id'>, onProgress: (done: number) => void): Promise<Done> {
    return new Promise((resolve, reject) => {
      this.queue.push({ task: { ...task, id: this.nextId++ }, group, onProgress, resolve, reject });
      this.pump();
    });
  }

  /** Drops queued tasks of a job; tasks already running finish and are ignored by the caller. */
  cancel(group: string) {
    const keep: Pending[] = [];
    for (const p of this.queue) (p.group === group ? p.reject(new Error('cancelled')) : keep.push(p));
    this.queue = keep;
  }

  private pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop()!, p = this.queue.shift()!;
      this.busy.set(w, p);
      w.postMessage(p.task);
    }
  }
}
