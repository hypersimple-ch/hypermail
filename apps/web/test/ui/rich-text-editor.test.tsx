// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RichTextEditor } from '../../src/components/app/rich-text-editor.js';

afterEach(cleanup);

describe('RichTextEditor', () => {
  it('exposes accessible formatting controls and keeps the editor in form submission', async () => {
    const view = render(<form data-testid="compose"><label htmlFor="message">Message</label><RichTextEditor id="message" name="body" defaultValue="Hello world" /></form>);
    const editor = await screen.findByRole('textbox', { name: 'Message' });
    expect(screen.getByRole('toolbar', { name: 'Message formatting' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Bold' }).getAttribute('aria-pressed')).toBe('false');

    fireEvent.focus(editor);
    fireEvent.keyDown(editor, { key: 'a', ctrlKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Bold' }));

    await waitFor(() => {
      const body = new FormData(view.getByTestId('compose') as HTMLFormElement).get('body');
      expect(body).toBe('<p><strong>Hello world</strong></p>');
    });

    const nativeSelects = view.container.querySelectorAll('select');
    expect(Array.from(nativeSelects[0]?.options ?? []).map((option) => option.textContent)).toContain('Georgia');
    expect(Array.from(nativeSelects[1]?.options ?? []).map((option) => option.textContent)).toContain('Large');
  });

  it('escapes an existing plain-text draft before loading it as rich content', async () => {
    const view = render(<form data-testid="compose"><RichTextEditor id="message" name="body" defaultValue={'Hello <script>bad()</script>\nNext line'} /></form>);
    await screen.findByRole('textbox', { name: 'Message' });
    const body = new FormData(view.getByTestId('compose') as HTMLFormElement).get('body');
    expect(body).not.toContain('<script>');
    expect(body).toContain('bad()');
  });
});
