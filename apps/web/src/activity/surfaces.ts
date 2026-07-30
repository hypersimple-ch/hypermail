import * as React from 'react';
import { acknowledgementBlockReason, activityFilters, matchesActivityFilter, type ActivityFilter, type ActivityPage, type ActivityRecord } from './contracts.js';

const h = React.createElement;
const labels: Record<ActivityFilter, string> = { new: 'New', questions: 'Questions', failed: 'Failed', history: 'History' };
const status = (activity: ActivityRecord): string => {
  if (activity.failure?.retrying) return 'Retrying';
  if (activity.state === 'waiting_question') return 'Needs input';
  if (activity.state === 'failed') return 'Failed';
  if (activity.state === 'acknowledged') return 'Acknowledged';
  return activity.state === 'handled' ? 'Handled — acknowledge' : 'New';
};
const action = (activity: ActivityRecord): string => activity.state === 'failed' ? (activity.failure?.retrying ? 'Retrying' : 'Retry') : activity.state === 'waiting_question' ? 'Answer question' : activity.state === 'handled' ? 'Acknowledge' : 'Open';

export type ActivityScreenProps = Readonly<{
  page: ActivityPage;
  filter?: ActivityFilter;
  onFilterChange?: (filter: ActivityFilter) => void;
  onOpen?: (activity: ActivityRecord) => void;
}>;

/** SSR-safe list surface: all mutations are supplied by the host, never initiated during render. */
export function ActivityScreen({ page, filter = 'new', onFilterChange, onOpen }: ActivityScreenProps) {
  const filters = activityFilters.map((value) => h('button', {
    type: 'button', key: value, className: value === filter ? 'is-active' : undefined,
    'aria-pressed': value === filter, onClick: () => onFilterChange?.(value),
  }, labels[value], h('span', { 'aria-label': `${String(page.counts[value])} items` }, String(page.counts[value]))));
  const events = page.items.map((activity) => h('li', { key: activity.id }, h('article', { className: 'hm-activity-event' },
    h('p', { className: `hm-activity-status hm-activity-status-${activity.state}` }, status(activity)),
    h('div', { className: 'hm-activity-copy' }, h('strong', null, activity.title), h('p', null, `${activity.messageLabel} · ${activity.accountLabel}`), h('time', { dateTime: activity.updatedAt }, activity.updatedAt)),
    h('button', { type: 'button', onClick: () => onOpen?.(activity), 'aria-label': `${action(activity)}: ${activity.title}` }, action(activity)))));
  return h('section', { className: 'hm-activity-surface', 'aria-label': 'Activity' },
    h('header', { className: 'hm-activity-header' }, h('h1', null, 'Activity'), h('p', null, 'Agent work and exceptions')),
    h('div', { className: 'hm-activity-filters', role: 'group', 'aria-label': 'Activity filters' }, filters),
    h('p', { className: 'hm-sr-only', 'aria-live': 'polite' }, `${labels[filter]} filter, ${String(page.items.length)} items shown.`),
    page.items.length === 0 ? h('p', { className: 'hm-state' }, `No ${labels[filter].toLocaleLowerCase()} activity.`) : h('ol', { className: 'hm-activity-list' }, events));
}

export type ActivityDetailProps = Readonly<{
  activity: ActivityRecord;
  onRetry?: (activity: ActivityRecord) => void;
  onAcknowledge?: (activity: ActivityRecord) => void;
  onOpenMessage?: (messageId: string) => void;
}>;

export function ActivityDetail({ activity, onRetry, onAcknowledge, onOpenMessage }: ActivityDetailProps) {
  const acknowledgementReason = acknowledgementBlockReason(activity);
  return h('article', { className: 'hm-activity-detail', 'aria-label': `Activity detail: ${activity.title}` },
    h('header', null, h('p', { className: `hm-activity-status hm-activity-status-${activity.state}` }, status(activity)), h('h1', null, activity.title), h('p', null, `${activity.messageLabel} · ${activity.accountLabel}`)),
    activity.question?.state === 'open' && h('section', { className: 'hm-question-block', 'aria-label': 'Open question' }, h('h2', null, 'Question needs your input'), h('p', null, activity.question.prompt), h('button', { type: 'button' }, 'Answer question')),
    activity.failure && h('section', { className: 'hm-failure-block', 'aria-label': 'Failure and retry' }, h('h2', null, activity.failure.retrying ? 'Retrying' : 'Failed'), h('p', null, `${activity.failure.code}: ${activity.failure.message}`), h('button', { type: 'button', disabled: activity.failure.retrying, onClick: () => onRetry?.(activity) }, activity.failure.retrying ? 'Retrying' : 'Retry')),
    h(AgentCardPlaceholder, null),
    h('section', { 'aria-label': 'Activity timeline' }, h('h2', null, 'Timeline'), h('ol', null, activity.timeline.map((event) => h('li', { key: event.id }, h('time', { dateTime: event.at }, event.at), ' ', event.label, event.detail ? `: ${event.detail}` : '')))),
    h('footer', { className: 'hm-activity-controls' }, h('button', { type: 'button', onClick: () => onOpenMessage?.(activity.messageId) }, 'Open original message'), h('button', { type: 'button', disabled: acknowledgementReason !== null, 'aria-describedby': acknowledgementReason ? 'activity-acknowledgement-reason' : undefined, onClick: () => onAcknowledge?.(activity) }, 'Acknowledge'), acknowledgementReason && h('p', { id: 'activity-acknowledgement-reason', role: 'status' }, acknowledgementReason)));
}

/** Deliberately inert placeholder; it conveys available context without introducing agent behavior. */
export function AgentCardPlaceholder() {
  return h('aside', { className: 'hm-agent-card-placeholder', 'aria-label': 'Agent context placeholder' }, h('strong', null, 'Agent context'), h('p', null, 'Details will appear here when available.'));
}

/** Host applications can include this isolated stylesheet without changing shared UI styles. */
export const activitySurfaceCss = `.hm-activity-surface,.hm-activity-detail{min-width:0;padding:14px}.hm-activity-filters{display:flex;gap:8px;overflow-x:auto}.hm-activity-filters button,.hm-activity-event button,.hm-activity-controls button,.hm-failure-block button{min-height:44px}.hm-activity-list{list-style:none;padding:0;margin:0}.hm-activity-event{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;padding:14px 0;border-bottom:1px solid #DFE3E6}.hm-activity-status{font-weight:700}.hm-activity-copy{min-width:0}.hm-activity-copy p,.hm-activity-copy time{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hm-question-block,.hm-failure-block,.hm-agent-card-placeholder{margin:12px 0;padding:12px;border:1px solid #DFE3E6;border-radius:12px}.hm-activity-controls{display:flex;flex-wrap:wrap;gap:8px}.hm-activity-status-waiting_question{color:#986500}.hm-activity-status-failed{color:#B3261E}.hm-activity-status-acknowledged{color:#217A4F}@media (min-width:700px){.hm-activity-surface,.hm-activity-detail{max-width:850px;margin:auto}}`;

export { matchesActivityFilter };
