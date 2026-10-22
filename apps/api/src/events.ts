import { EventEmitter } from 'node:events';
import { query } from './db';

export interface AppEvent {
  id: number;
  type: string;
  payload: unknown;
}

class EventHub {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  subscribe(listener: (event: AppEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  publish(event: AppEvent): void {
    this.emitter.emit('event', event);
  }
}

export const hub = new EventHub();

/**
 * Written to Postgres before it is fanned out, so a reconnecting browser can
 * replay everything it missed via Last-Event-ID instead of refetching.
 */
export async function emitEvent(type: string, payload: unknown): Promise<AppEvent> {
  const result = await query<{ id: string }>(
    `INSERT INTO events (type, payload) VALUES ($1, $2) RETURNING id`,
    [type, payload]
  );
  const event: AppEvent = { id: Number(result.rows[0]!.id), type, payload };
  hub.publish(event);
  return event;
}
