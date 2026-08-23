import * as React from 'react';
import { Input } from '@/components/heroui/input.js';
import type { DraftBodyFormat, RichTextEditorProps } from './rich-text-editor-types.js';

type EditorComponent = (props: RichTextEditorProps) => React.JSX.Element;
let editorModule: Promise<EditorComponent> | undefined;
const loadEditor = (): Promise<EditorComponent> => {
  editorModule ??= import('./rich-text-editor-engine.js').then((module) => module.RichTextEditor);
  return editorModule;
};

function EditorFallback({ name, formatName = `${name}Format`, defaultValue = '', defaultFormat = 'markdown' }: RichTextEditorProps): React.JSX.Element {
  return <div data-slot="rich-text-editor" className="min-w-0 max-w-full overflow-hidden rounded-lg border border-input bg-card">
    <div role="toolbar" aria-label="Message formatting" className="flex min-h-14 items-center border-b border-border bg-muted px-3 text-sm text-muted-foreground">Loading formatting controls…</div>
    <div className="min-h-56 px-4 py-3" aria-hidden="true" />
    <Input type="hidden" name={name} value={defaultValue} readOnly />
    <Input type="hidden" name={formatName} value={defaultFormat} readOnly />
  </div>;
}

export function RichTextEditor(props: RichTextEditorProps): React.JSX.Element {
  const [Editor, setEditor] = React.useState<EditorComponent | null>(null);
  React.useEffect(() => {
    let mounted = true;
    void loadEditor().then((component) => { if (mounted) setEditor(() => component); });
    return () => { mounted = false; };
  }, []);
  return Editor ? <Editor {...props} /> : <EditorFallback {...props} />;
}

export type { DraftBodyFormat, RichTextEditorProps };
