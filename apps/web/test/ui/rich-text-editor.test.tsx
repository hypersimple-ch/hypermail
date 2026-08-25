// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { RichTextEditor } from '../../src/components/app/rich-text-editor.js';

afterEach(cleanup);

const formText = (form: HTMLElement, name: string): string => {
  const value = new FormData(form as HTMLFormElement).get(name);
  expect(typeof value).toBe('string');
  return typeof value === 'string' ? value : '';
};


describe('RichTextEditor', () => {
  it('exposes accessible formatting controls and keeps the editor in form submission', async () => {
    const view = render(<form data-testid="compose"><label id="message-label" htmlFor="message">Message</label><RichTextEditor id="message" name="body" defaultValue="Hello world" ariaLabelledBy="message-label" /></form>);
    const editor = await screen.findByRole('textbox', { name: 'Message' }, { timeout: 10_000 });
    expect(screen.getByRole('toolbar', { name: 'Message formatting' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Bold' }).getAttribute('aria-pressed')).toBe('false');

    fireEvent.focus(editor);
    fireEvent.keyDown(editor, { key: 'a', ctrlKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Bold' }));

    await waitFor(() => {
      const body = new FormData(view.getByTestId('compose') as HTMLFormElement).get('body');
      expect(body).toBe('<p><strong>Hello world</strong></p>');
    }, { timeout: 10_000 });

    expect(screen.getByRole('button', { name: /Font family/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Font size/ })).toBeTruthy();
    const nativeSelects = view.container.querySelectorAll('select');
    fireEvent.change(nativeSelects[0] as HTMLSelectElement, { target: { value: 'Georgia, serif' } });
    fireEvent.change(nativeSelects[1] as HTMLSelectElement, { target: { value: '18px' } });
    await waitFor(() => {
      const body = formText(view.getByTestId('compose'), 'body');
      expect(body).toContain('font-family: Georgia, serif');
      expect(body).toContain('font-size: 18px');
    }, { timeout: 10_000 });
  });

  it('escapes an existing plain-text draft before loading it as rich content', async () => {
    const view = render(<form data-testid="compose"><RichTextEditor id="message" name="body" defaultValue={'Hello <script>bad()</script>\nNext line'} /></form>);
    await screen.findByRole('textbox', { name: 'Message' }, { timeout: 10_000 });
    const body = new FormData(view.getByTestId('compose') as HTMLFormElement).get('body');
    expect(body).not.toContain('<script>');
    expect(body).toContain('bad()');
  });

  it('preserves supported Markdown structure and canonicalizes unsupported pasted HTML on reload', async () => {
    const markdown = render(<form data-testid="markdown"><RichTextEditor id="markdown-message" name="body" defaultValue={'**Bold**\n\n> Quoted reply'} defaultFormat="markdown" /></form>);
    await screen.findByRole('textbox', { name: 'Message' }, { timeout: 10_000 });
    await waitFor(() => {
      const body = formText(markdown.getByTestId('markdown'), 'body');
      expect(body).toContain('<strong>Bold</strong>');
      expect(body).toContain('<blockquote>');
    }, { timeout: 10_000 });
    cleanup();

    const linked = render(<form data-testid="linked"><RichTextEditor id="linked-message" name="body" defaultValue={'<p>See <a href="https://example.test">link</a></p>'} defaultFormat="html" /></form>);
    await screen.findByRole('textbox', { name: 'Message' }, { timeout: 10_000 });
    await waitFor(() => {
      const body = formText(linked.getByTestId('linked'), 'body');
      expect(body).toBe('<p>See link</p>');
      expect(body).not.toContain('&lt;p&gt;');
    }, { timeout: 10_000 });
  });

  it('has a safe submitted value before the client editor initializes and disables all controls', async () => {
    const markup = renderToStaticMarkup(<RichTextEditor id="message" name="body" defaultValue="Existing body" disabled />);
    expect(markup).toContain('name="body"');
    expect(markup).toContain('Existing body');
    const view = render(<RichTextEditor id="disabled-message" name="body" defaultValue="Existing body" disabled />);
    await screen.findByRole('textbox', { name: 'Message' }, { timeout: 10_000 });
    const buttons = Array.from(view.container.querySelectorAll('button'));
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((button) => button.disabled)).toBe(true);
  });
});
