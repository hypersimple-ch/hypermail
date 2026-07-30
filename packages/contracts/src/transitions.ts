import type {
  ActionState,
  ActivityState,
  DraftState,
  HealthState,
  JobState,
  NotificationState,
  QuestionState,
} from './domain.js';

export class IllegalTransitionError extends Error {
  constructor(machine: string, from: string, to: string) {
    super(`Illegal ${machine} transition: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

type TransitionMap<S extends string> = Readonly<Record<S, readonly S[]>>;

const activityTransitions: TransitionMap<ActivityState> = {
  new: ['waiting_question', 'failed', 'handled'],
  waiting_question: ['new', 'failed'],
  failed: ['new'],
  handled: ['acknowledged'],
  acknowledged: [],
};

const questionTransitions: TransitionMap<QuestionState> = {
  open: ['answered', 'cancelled'],
  answered: [],
  cancelled: [],
};

const jobTransitions: TransitionMap<JobState> = {
  pending: ['running', 'cancelled'],
  running: ['suspended', 'succeeded', 'failed'],
  suspended: ['running', 'cancelled'],
  succeeded: [],
  failed: ['pending', 'cancelled'],
  cancelled: [],
};

const actionTransitions: TransitionMap<ActionState> = {
  planned: ['executing'],
  executing: ['succeeded', 'failed', 'unverifiable'],
  succeeded: ['incorrect'],
  failed: ['planned'],
  unverifiable: ['planned'],
  incorrect: [],
};

const draftTransitions: TransitionMap<DraftState> = {
  editing: ['ready', 'discarded'],
  ready: ['editing', 'sending', 'discarded'],
  sending: ['sent', 'failed'],
  sent: [],
  failed: ['editing', 'sending', 'discarded'],
  discarded: [],
};

const notificationTransitions: TransitionMap<NotificationState> = {
  pending: ['delivering', 'suppressed'],
  delivering: ['delivered', 'failed'],
  delivered: [],
  failed: ['pending', 'suppressed'],
  suppressed: [],
};

const healthTransitions: TransitionMap<HealthState> = {
  healthy: ['degraded', 'failed', 'paused'],
  degraded: ['healthy', 'failed', 'paused'],
  failed: ['healthy', 'degraded', 'paused'],
  paused: ['healthy', 'degraded', 'failed'],
};

function apply<S extends string>(machine: string, map: TransitionMap<S>, from: S, to: S): S {
  if (!map[from].includes(to)) throw new IllegalTransitionError(machine, from, to);
  return to;
}

export const transitionActivity = (from: ActivityState, to: ActivityState) => apply('activity', activityTransitions, from, to);
export const transitionQuestion = (from: QuestionState, to: QuestionState) => apply('question', questionTransitions, from, to);
export const transitionJob = (from: JobState, to: JobState) => apply('job', jobTransitions, from, to);
export const transitionAction = (from: ActionState, to: ActionState) => apply('action', actionTransitions, from, to);
export const transitionDraft = (from: DraftState, to: DraftState) => apply('draft', draftTransitions, from, to);
export const transitionNotification = (from: NotificationState, to: NotificationState) => apply('notification', notificationTransitions, from, to);
export const transitionHealth = (from: HealthState, to: HealthState) => apply('health', healthTransitions, from, to);

export function replayState<S>(initial: S, events: readonly S[], reducer: (from: S, to: S) => S): S {
  return events.reduce(reducer, initial);
}
