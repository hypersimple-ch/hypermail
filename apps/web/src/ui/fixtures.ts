import type { ShellData } from './index.js';

/** Explicit UI fixture for tests; production browser composition always supplies API data. */
export const mockShellData: ShellData = {
  accounts: [{ id: 'personal', label: 'Personal', address: 'me@example.com', unread: 8 }, { id: 'work', label: 'Work', address: 'me@hypermail.example', unread: 4 }],
  messages: [{ id: 'samira', accountId: 'personal', sender: 'Samira Ahmed', initials: 'S', subject: 'Quick question about Thursday', preview: 'Could we move our call an hour later?', received: '7:58', receivedAt: new Date().toISOString(), unread: true, body: 'Could we move our call an hour later? I have a conflict at 2pm.', attachments: [{ id: 'agenda', name: 'Thursday-agenda.pdf', size: '184 KB', safe: true }] }, { id: 'linear', accountId: 'work', sender: 'Linear', initials: 'L', subject: 'Issue assigned: review Android polish', preview: 'Priya assigned you an issue in Hypermail.', received: '9:42', receivedAt: new Date().toISOString(), unread: true, body: 'Priya assigned you an issue in Hypermail.' }, { id: 'monzo', accountId: 'personal', sender: 'Monzo', initials: 'M', subject: 'Your monthly statement is ready', preview: 'View your latest account summary.', received: '8:17', receivedAt: new Date(Date.now() - 86_400_000).toISOString(), body: 'Your latest account summary is ready to view.' }],
  activity: {
    items: [
      { id: 'reply', accountId: 'personal', messageId: 'samira', state: 'new', version: 1, createdAt: '2026-08-21T12:00:00Z', updatedAt: '2026-08-21T12:02:00Z', title: 'Reply draft ready', accountLabel: 'Personal', messageLabel: 'Samira Ahmed', timeline: [] },
      { id: 'archive', accountId: 'personal', messageId: null, state: 'handled', version: 2, createdAt: '2026-08-21T10:00:00Z', updatedAt: '2026-08-21T10:05:00Z', title: 'Newsletter archived', accountLabel: 'Personal', messageLabel: 'Product Hunt Daily', timeline: [] },
    ],
    nextCursor: null,
    counts: { new: 2, questions: 1, failed: 1, history: 1 },
  },
};
