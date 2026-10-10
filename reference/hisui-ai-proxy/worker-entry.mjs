import { DurableObject } from 'cloudflare:workers';
import { handleRequest, reserveDaily } from './worker.mjs';

export class DailyBudget extends DurableObject {
  async reserve() { return reserveDaily(this.ctx.storage, this.env.DAILY_REQUEST_LIMIT); }
}
export default { fetch: handleRequest };
