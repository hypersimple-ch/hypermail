/// <reference lib="dom" />

import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { HypermailShell, type Screen } from '../../src/ui/index.js';
import { mockShellData } from '../../src/ui/fixtures.js';

const params = new URLSearchParams(location.search);
const screen = (params.get('screen') ?? 'more') as Screen;
if (params.get('largeText') === 'true') document.documentElement.style.fontSize = '20px';

const root = createRoot(document.getElementById('app') as HTMLElement);
flushSync(() => {
  root.render(<HypermailShell
    data={mockShellData}
    initialScreen={screen}
    ownerEmail="owner.with.a.long.address@example.test"
    online
    settingsMailboxes={[{ id: 'personal', provider: 'gmail', email: 'owner.with.a.long.address@example.test', displayName: 'Personal', state: 'ready' }]}
    onChangePassword={() => Promise.resolve({ ok: true })}
    onSignOut={() => Promise.resolve()}
  />);
});

const visible = (selector: string, root: ParentNode = document): HTMLElement | undefined => Array.from(root.querySelectorAll<HTMLElement>(selector)).find((element) => element.getBoundingClientRect().width > 0);
const rect = (element: Element | undefined) => element?.getBoundingClientRect();
const rounded = (value: number | undefined) => value === undefined ? null : Math.round(value * 100) / 100;

setTimeout(() => {
  const page = visible('[data-slot="app-page"]');
  const desktop = document.querySelector<HTMLElement>('section[aria-label="Desktop mailbox"]');
  const desktopInbox = desktop ? visible('[aria-label="Inbox"]', desktop) : undefined;
  const desktopReader = desktop ? visible('[aria-label="Message detail"]', desktop) : undefined;
  const mobileReader = visible('main > div [aria-label="Message detail"]');
  const more = visible('section[aria-label="More"]');
  const moreGrid = more ? Array.from(more.children).find((element) => getComputedStyle(element).display === 'grid') : undefined;
  const moreButtons = moreGrid ? Array.from(moreGrid.querySelectorAll<HTMLButtonElement>(':scope > button')) : [];
  const filter = visible('[data-slot="filter-group"]');
  const navigation = visible('nav[aria-label="Mobile primary"]');
  const compose = visible('button[aria-label="Compose"]');
  const formattingToolbar = visible('[aria-label="Message formatting"]');
  const boldControl = formattingToolbar ? visible('button[aria-label="Bold"]', formattingToolbar) : undefined;
  const activityRows = Array.from(document.querySelectorAll<HTMLElement>('[aria-label="Activity"] [data-slot="card-content"]')).filter((row) => row.querySelector('[data-slot="chip"]') && row.querySelector('button'));
  const surfaceColor = (selector: string) => { const element = visible(selector); return element ? getComputedStyle(element).backgroundColor : null; };
  const result = {
    viewport: { width: innerWidth, height: innerHeight },
    document: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth },
    page: { x: rounded(rect(page)?.x), width: rounded(rect(page)?.width) },
    more: {
      gridWidth: rounded(rect(moreGrid)?.width),
      columns: moreGrid ? getComputedStyle(moreGrid).gridTemplateColumns.split(' ').length : 0,
      buttons: moreButtons.map((button) => { const value = button.getBoundingClientRect(); return { x: rounded(value.x), y: rounded(value.y), width: rounded(value.width) }; }),
    },
    inbox: { width: rounded(rect(desktopInbox)?.width), readerWidth: rounded(rect(desktopReader)?.width), mobileReaderWidth: rounded(rect(mobileReader)?.width) },
    composeEditor: {
      toolbarClientWidth: formattingToolbar?.clientWidth ?? null,
      toolbarScrollWidth: formattingToolbar?.scrollWidth ?? null,
      toolbar: { x: rounded(rect(formattingToolbar)?.x), right: rounded(rect(formattingToolbar)?.right) },
      bold: { x: rounded(rect(boldControl)?.x), right: rounded(rect(boldControl)?.right) },
    },
    activity: {
      filterClientWidth: filter?.clientWidth ?? null,
      filterScrollWidth: filter?.scrollWidth ?? null,
      rows: activityRows.map((row) => ({
        container: { x: rounded(row.getBoundingClientRect().x), right: rounded(row.getBoundingClientRect().right) },
        children: Array.from(row.children).map((child) => { const value = child.getBoundingClientRect(); return { x: rounded(value.x), right: rounded(value.right), top: rounded(value.top), bottom: rounded(value.bottom) }; }),
      })),
    },
    surfaces: {
      page: getComputedStyle(document.body).backgroundColor,
      outlineButton: surfaceColor('[data-variant="outline"]'),
      input: surfaceColor('[data-slot="input"]'),
      richEditor: surfaceColor('[data-slot="rich-text-editor"]'),
      select: surfaceColor('[data-slot="select-trigger"]'),
    },
    mobile: { navTop: rounded(rect(navigation)?.top), composeBottom: rounded(rect(compose)?.bottom), navItems: navigation?.querySelectorAll('button').length ?? 0 },
  };
  const output = document.getElementById('layout-result') as HTMLElement;
  output.textContent = JSON.stringify(result);
  output.dataset.ready = 'true';
}, 100);
