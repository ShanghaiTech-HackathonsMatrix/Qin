import { currentTermSnapshot } from '../app/academic-term.ts';
import { widgetSnapshot, type WidgetData } from './widget-data.ts';
import type { Assignment } from '../plugins/builtin/academic/model.ts';

export interface SubmissionEffect { eventID: string; title: string; course: string }

/** Session baseline: historical submissions at startup never trigger a celebration. */
export function submissionEffectTracker() {
  let previous = new Map<string, { status: Assignment['status']; syncedAt: number; title: string; course: string }>();
  return (data: WidgetData, now: number): SubmissionEffect[] => {
    const labels = new Map(widgetSnapshot(data, now).items.map(item => [item.id, item]));
    const next: typeof previous = new Map();
    const events: SubmissionEffect[] = [];
    for (const raw of data.snapshots) {
      if (raw.provider === 'eams' || data.enabled[raw.provider] === false) continue;
      const snapshot = currentTermSnapshot(raw, now);
      const selected = data.settings.selectedCourses[raw.provider];
      for (const assignment of snapshot.assignments) {
        if ((selected && !selected.includes(assignment.courseId)) || data.corrections.assignments[assignment.id]?.hidden) continue;
        const key = `${raw.provider}:${assignment.id}`;
        const before = previous.get(key), label = labels.get(assignment.id);
        const title = label?.title ?? before?.title ?? assignment.title;
        const course = label?.course ?? before?.course ?? snapshot.courses.find(c => c.id === assignment.courseId)?.title ?? '';
        const submitted = assignment.status === 'submitted' || assignment.status === 'graded';
        // Carried-forward records, missing rows, corrections, and a timestamp
        // change without explicit platform confirmation are never sufficient.
        if (before && before.status !== 'submitted' && before.status !== 'graded' && submitted
          && Number.isFinite(snapshot.syncedAt) && snapshot.syncedAt > before.syncedAt
          && assignment.verifiedAt === snapshot.syncedAt) {
          events.push({ eventID: `${key}:${snapshot.syncedAt}`, title, course });
        }
        next.set(key, { status: assignment.status, syncedAt: snapshot.syncedAt, title, course });
      }
    }
    previous = next;
    return events;
  };
}
