import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { submissionEffectTracker } from './ios-submission-events.ts';
import type { WidgetData } from './widget-data.ts';
import { defaultSettings } from '../plugins/builtin/academic/model.ts';

const now = Date.parse('2026-10-18T12:00:00+08:00');
function fixture(): WidgetData {
  return { settings: defaultSettings(), corrections: { assignments: {}, lessons: {} }, enabled: {}, tasks: [], courses: [],
    snapshots: [{ provider: 'gradescope', syncedAt: now, semester: 'Fall 2026', rules: [], periods: [],
      courses: [{ id: 'c', title: 'Math', code: '', term: 'Fall 2026', provider: 'gradescope', url: '' }],
      assignments: [{ id: 'a', courseId: 'c', title: 'Homework 4', url: '', provider: 'gradescope',
        dueAt: now + 10000, lateDueAt: null, dueText: '', status: 'not_submitted', verifiedAt: now }] }] };
}
test('only newly platform-confirmed submissions trigger once with the DDL label', () => {
  const track = submissionEffectTracker(), data = fixture();
  assert.deepEqual(track(data, now), []);
  const snapshot = data.snapshots[0], row = snapshot.assignments[0];
  snapshot.syncedAt += 1000; row.status = 'submitted'; row.verifiedAt = snapshot.syncedAt;
  const events = track(data, now);
  assert.equal(events.length, 1); assert.equal(events[0].title, 'HW4'); assert.equal(events[0].course, 'Math');
  assert.deepEqual(track(data, now), []);
  snapshot.syncedAt += 1000; row.status = 'graded'; row.verifiedAt = snapshot.syncedAt;
  assert.deepEqual(track(data, now), []);
  assert.deepEqual(submissionEffectTracker()(data, now), []);
});
test('personal completion, unread status, missing row, disabled and historical courses do not trigger', () => {
  for (const scenario of ['personal', 'stale', 'missing', 'disabled', 'history', 'hidden', 'unselected']) {
    const track = submissionEffectTracker(), data = fixture(); track(data, now);
    const s = data.snapshots[0], row = s.assignments[0]; s.syncedAt += 1000;
    if (scenario === 'personal') data.corrections.assignments.a = { done: true };
    else { row.status = 'submitted'; row.verifiedAt = s.syncedAt; }
    if (scenario === 'stale') row.verifiedAt = now;
    if (scenario === 'missing') s.assignments = [];
    if (scenario === 'disabled') data.enabled.gradescope = false;
    if (scenario === 'history') s.courses[0].term = 'Spring 2026';
    if (scenario === 'hidden') data.corrections.assignments.a = { hidden: true };
    if (scenario === 'unselected') data.settings.selectedCourses.gradescope = [];
    assert.deepEqual(track(data, now), [], scenario);
  }
});
