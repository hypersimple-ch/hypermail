import { FontFamily, FontSize, TextStyle } from '@tiptap/extension-text-style';
import TextAlign from '@tiptap/extension-text-align';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Italic,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Strikethrough,
  Underline as UnderlineIcon,
  Undo2,
} from 'lucide-react';
import { marked } from 'marked';
import * as React from 'react';
import { Button } from '@/components/heroui/button.js';
import { Input } from '@/components/heroui/input.js';
import { Select } from '@/components/heroui/select.js';
import { cn } from '@/lib/utils.js';

import type { DraftBodyFormat, RichTextEditorProps } from './rich-text-editor-types.js';

const fontFamilies = [
  { value: 'Arial, sans-serif', label: 'Arial' },
  { value: 'Georgia, serif', label: 'Georgia' },
  { value: 'Tahoma, sans-serif', label: 'Tahoma' },
  { value: 'Times New Roman, serif', label: 'Times New Roman' },
  { value: 'Verdana, sans-serif', label: 'Verdana' },
] as const;

const fontSizes = [
  { value: '12px', label: 'Small' },
  { value: '14px', label: 'Normal' },
  { value: '18px', label: 'Large' },
  { value: '24px', label: 'Extra large' },
] as const;

const escapeText = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const plainTextHtml = (value: string): string => value.split(/\n{2,}/).map((paragraph) => `<p>${escapeText(paragraph).replaceAll('\n', '<br>')}</p>`).join('');

/** Convert durable Markdown to editor HTML while keeping unsupported raw markup inert. */
function editorContent(value: string, format: DraftBodyFormat): string {
  if (!value) return '';
  if (format === 'html') return value;
  const unsupportedRawHtml = /<(?!\/?(?:p|br|strong|em|u|s|span|ul|ol|li|blockquote)(?:\s|>|\/))[^>]+>/i.test(value);
  if (unsupportedRawHtml) return plainTextHtml(value);
  return marked.parse(value, { async: false, breaks: true });
}

type ToolbarButtonProps = Readonly<{
  label: string;
  active?: boolean;
  disabled?: boolean;
  onPress: () => void;
  children: React.ReactNode;
}>;

function ToolbarButton({ label, active, disabled = false, onPress, children }: ToolbarButtonProps): React.JSX.Element {
  return <Button
    type="button"
    size="icon"
    variant={active ? 'secondary' : 'ghost'}
    aria-label={label}
    aria-pressed={active}
    title={label}
    disabled={disabled}
    onClick={onPress}
    className="shrink-0"
  >{children}</Button>;
}

type ToolbarState = Readonly<{
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  bulletList: boolean;
  orderedList: boolean;
  blockquote: boolean;
  alignLeft: boolean;
  alignCenter: boolean;
  alignRight: boolean;
  canUndo: boolean;
  canRedo: boolean;
  fontFamily: string;
  fontSize: string;
}>;

const emptyToolbarState: ToolbarState = {
  bold: false, italic: false, underline: false, strike: false, bulletList: false, orderedList: false, blockquote: false,
  alignLeft: false, alignCenter: false, alignRight: false, canUndo: false, canRedo: false, fontFamily: '', fontSize: '',
};

export function RichTextEditor({ id, name, defaultValue = '', defaultFormat = 'markdown', formatName = `${name}Format`, disabled = false, className, ariaLabelledBy, onChange }: RichTextEditorProps): React.JSX.Element {
  const initialContent = React.useMemo(() => editorContent(defaultValue, defaultFormat), [defaultFormat, defaultValue]);
  const [value, setValue] = React.useState(defaultValue);
  const [format, setFormat] = React.useState<DraftBodyFormat>(defaultFormat);
  const previousDefault = React.useRef({ format: defaultFormat, value: defaultValue });
  const editor = useEditor({
    immediatelyRender: false,
    editable: !disabled,
    content: initialContent,
    extensions: [
      StarterKit.configure({ code: false, codeBlock: false, heading: false, horizontalRule: false, link: false }),
      TextStyle,
      FontFamily,
      FontSize,
      TextAlign.configure({ types: ['paragraph'] }),
    ],
    editorProps: {
      attributes: {
        id,
        role: 'textbox',
        'aria-multiline': 'true',
        ...(ariaLabelledBy ? { 'aria-labelledby': ariaLabelledBy } : { 'aria-label': 'Message' }),
        class: 'min-h-56 px-4 py-3 text-base leading-6 outline-none',
      },
    },
    onCreate: ({ editor: current }) => {
      setValue(current.getText().trim() ? current.getHTML() : '');
      setFormat('html');
    },
    onUpdate: ({ editor: current }) => {
      const next = current.getText().trim() ? current.getHTML() : '';
      setValue(next);
      setFormat('html');
      onChange?.(next);
    },
  });
  const toolbarState = useEditorState<ToolbarState>({
    editor,
    selector: ({ editor: current }) => current ? {
      bold: current.isActive('bold'), italic: current.isActive('italic'), underline: current.isActive('underline'), strike: current.isActive('strike'),
      bulletList: current.isActive('bulletList'), orderedList: current.isActive('orderedList'), blockquote: current.isActive('blockquote'),
      alignLeft: current.isActive({ textAlign: 'left' }), alignCenter: current.isActive({ textAlign: 'center' }), alignRight: current.isActive({ textAlign: 'right' }),
      canUndo: current.can().chain().undo().run(), canRedo: current.can().chain().redo().run(),
      fontFamily: String(current.getAttributes('textStyle')['fontFamily'] ?? ''), fontSize: String(current.getAttributes('textStyle')['fontSize'] ?? ''),
    } : emptyToolbarState,
  }) ?? emptyToolbarState;

  React.useEffect(() => { editor?.setEditable(!disabled); }, [disabled, editor]);
  React.useEffect(() => {
    if (!editor || (previousDefault.current.format === defaultFormat && previousDefault.current.value === defaultValue)) return;
    previousDefault.current = { format: defaultFormat, value: defaultValue };
    editor.commands.setContent(initialContent, { emitUpdate: false });
    setValue(editor.getText().trim() ? editor.getHTML() : '');
    setFormat('html');
  }, [defaultFormat, defaultValue, editor, initialContent]);

  const unavailable = disabled || !editor;
  const icon = 'size-4';

  return <div data-slot="rich-text-editor" className={cn('min-w-0 max-w-full overflow-hidden [contain:paint] rounded-lg border border-input bg-card focus-within:ring-2 focus-within:ring-ring', className)}>
    <div role="toolbar" aria-label="Message formatting" className="w-full min-w-0 max-w-full overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden border-b border-border bg-muted">
      <div className="flex w-max items-center gap-1 p-1.5">
      <ToolbarButton label="Bold" active={toolbarState.bold} disabled={unavailable} onPress={() => { editor?.chain().focus().toggleBold().run(); }}><Bold aria-hidden="true" className={icon} /></ToolbarButton>
      <ToolbarButton label="Italic" active={toolbarState.italic} disabled={unavailable} onPress={() => { editor?.chain().focus().toggleItalic().run(); }}><Italic aria-hidden="true" className={icon} /></ToolbarButton>
      <ToolbarButton label="Underline" active={toolbarState.underline} disabled={unavailable} onPress={() => { editor?.chain().focus().toggleUnderline().run(); }}><UnderlineIcon aria-hidden="true" className={icon} /></ToolbarButton>
      <ToolbarButton label="Strikethrough" active={toolbarState.strike} disabled={unavailable} onPress={() => { editor?.chain().focus().toggleStrike().run(); }}><Strikethrough aria-hidden="true" className={icon} /></ToolbarButton>
      <span aria-hidden="true" className="mx-1 h-7 w-px shrink-0 bg-border" />
      <div className="w-36 shrink-0">
        <Select label={<span className="sr-only">Font family</span>} placeholder="Font" value={toolbarState.fontFamily} disabled={unavailable} options={fontFamilies} onValueChange={(family) => { editor?.chain().focus().setFontFamily(family).run(); }} />
      </div>
      <div className="w-32 shrink-0">
        <Select label={<span className="sr-only">Font size</span>} placeholder="Size" value={toolbarState.fontSize} disabled={unavailable} options={fontSizes} onValueChange={(size) => { editor?.chain().focus().setFontSize(size).run(); }} />
      </div>
      <span aria-hidden="true" className="mx-1 h-7 w-px shrink-0 bg-border" />
      <ToolbarButton label="Bulleted list" active={toolbarState.bulletList} disabled={unavailable} onPress={() => { editor?.chain().focus().toggleBulletList().run(); }}><List aria-hidden="true" className={icon} /></ToolbarButton>
      <ToolbarButton label="Numbered list" active={toolbarState.orderedList} disabled={unavailable} onPress={() => { editor?.chain().focus().toggleOrderedList().run(); }}><ListOrdered aria-hidden="true" className={icon} /></ToolbarButton>
      <ToolbarButton label="Quote" active={toolbarState.blockquote} disabled={unavailable} onPress={() => { editor?.chain().focus().toggleBlockquote().run(); }}><Quote aria-hidden="true" className={icon} /></ToolbarButton>
      <span aria-hidden="true" className="mx-1 h-7 w-px shrink-0 bg-border" />
      <ToolbarButton label="Align left" active={toolbarState.alignLeft} disabled={unavailable} onPress={() => { editor?.chain().focus().setTextAlign('left').run(); }}><AlignLeft aria-hidden="true" className={icon} /></ToolbarButton>
      <ToolbarButton label="Align center" active={toolbarState.alignCenter} disabled={unavailable} onPress={() => { editor?.chain().focus().setTextAlign('center').run(); }}><AlignCenter aria-hidden="true" className={icon} /></ToolbarButton>
      <ToolbarButton label="Align right" active={toolbarState.alignRight} disabled={unavailable} onPress={() => { editor?.chain().focus().setTextAlign('right').run(); }}><AlignRight aria-hidden="true" className={icon} /></ToolbarButton>
      <span aria-hidden="true" className="mx-1 h-7 w-px shrink-0 bg-border" />
      <ToolbarButton label="Undo" disabled={unavailable || !toolbarState.canUndo} onPress={() => { editor?.chain().focus().undo().run(); }}><Undo2 aria-hidden="true" className={icon} /></ToolbarButton>
      <ToolbarButton label="Redo" disabled={unavailable || !toolbarState.canRedo} onPress={() => { editor?.chain().focus().redo().run(); }}><Redo2 aria-hidden="true" className={icon} /></ToolbarButton>
      </div>
    </div>
    <EditorContent editor={editor} className="[&_.tiptap_blockquote]:border-l-4 [&_.tiptap_blockquote]:border-border [&_.tiptap_blockquote]:pl-4 [&_.tiptap_ol]:list-decimal [&_.tiptap_ol]:pl-6 [&_.tiptap_p]:my-2 [&_.tiptap_ul]:list-disc [&_.tiptap_ul]:pl-6" />
    <Input type="hidden" name={name} value={value} readOnly />
    <Input type="hidden" name={formatName} value={format} readOnly />
  </div>;
}
