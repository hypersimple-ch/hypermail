import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Drafts, Sent } from '../../src/ui/index.js';
import type { DraftRecord } from '../../src/drafts/contracts.js';

const render = (node: React.ReactElement) => renderToStaticMarkup(node);

describe('responsive shell rendering contracts', () => {
  it('keeps editable drafts distinct from read-only sent records', () => {
    const draft: DraftRecord = { id: 'd1', accountId: 'a1', sourceMessageId: null, createdBy: 'user', recipients: [{ kind: 'to', address: 'person@example.test' }], subject: 'Follow up', body: '', bodyFormat: 'markdown', state: 'editing', createdAt: '', updatedAt: '', version: 4 };
    const drafts: DraftRecord[] = [draft, { ...draft, id: 's1', state: 'sent', subject: 'Delivered' }];
    expect(render(React.createElement(Drafts, { drafts }))).toContain('Follow up');
    expect(render(React.createElement(Drafts, { drafts }))).not.toContain('Delivered');
    const sent = render(React.createElement(Sent, { drafts }));
    expect(sent).toContain('Delivered');
    expect(sent).not.toContain('Follow up');
  });

});
