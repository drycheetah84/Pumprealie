import { EventEmitter } from 'node:events';
import type { Alert, OrderRecord, PositionRecord, TokenSummary } from '../../shared/types';

export interface BusEvents {
  'token:update': TokenSummary;
  'order:update': OrderRecord;
  'position:update': PositionRecord;
  alert: Alert;
  'status:changed': { reason: string };
}

/** Typed in-process event bus used to fan out updates to the realtime API. */
export class EventBus {
  private ee = new EventEmitter();
  constructor() {
    this.ee.setMaxListeners(100);
  }
  emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]) {
    this.ee.emit(event, payload);
  }
  on<K extends keyof BusEvents>(event: K, fn: (p: BusEvents[K]) => void): () => void {
    this.ee.on(event, fn);
    return () => this.ee.off(event, fn);
  }
}
