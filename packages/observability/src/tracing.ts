export type TraceName = 'queue.consume' | 'oauth.exchange' | 'connection.probe' | 'provider.request' | 'authorization.check';
export type TraceStatus = 'ok' | 'error' | 'denied';
export type TracePoint = Readonly<{ name: TraceName; status: TraceStatus; durationMs: number }>;
const TRACE_NAMES=new Set<TraceName>(['queue.consume','oauth.exchange','connection.probe','provider.request','authorization.check']);
const TRACE_STATUSES=new Set<TraceStatus>(['ok','error','denied']);

/** Payload-free trace recorder. It deliberately has no attribute or baggage API. */
export class PayloadFreeTracing {
  private readonly points:TracePoint[]=[];
  record(name:TraceName,status:TraceStatus,durationMs:number):void {
    if(!TRACE_NAMES.has(name)||!TRACE_STATUSES.has(status)||!Number.isFinite(durationMs)||durationMs<0) return;
    this.points.push({name,status,durationMs});
  }
  snapshot():readonly TracePoint[]{ return this.points.map(point=>({...point})); }
}
