import { FontFamily, FontSize, TextStyle } from '@tiptap/extension-text-style';
import TextAlign from '@tiptap/extension-text-align';
import { EditorContent, useEditor } from '@tiptap/react';
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
import * as React from 'react';
import { Button } from '@/components/heroui/button.js';
import { Input } from '@/components/heroui/input.js';
import { Select } from '@/components/heroui/select.js';
import { cn } from '@/lib/utils.js';

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

/** Load saved rich HTML, but escape unsupported markup before Tiptap canonicalizes it. */
function editorContent(value: string): string {
  if (!value) return '';
  const hasHtml = /<\/?[a-z][\s\S]*>/i.test(value);
  const hasUnsupportedHtml = /<(?!\/?(?:p|br|strong|em|u|s|span|ul|ol|li|blockquote|h[1-6])(?:\s|>|\/))[^>]+>/i.test(value);
  if (hasHtml && !hasUnsupportedHtml) return value;
  const escape = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return value.split(/\n{2,}/).map((paragraph) => `<p>${escape(paragraph).replaceAll('\n', '<br>')}</p>`).join('');
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

export type RichTextEditorProps = Readonly<{
  id: string;
  name: string;
  defaultValue?: string;
  disabled?: boolean;
  className?: string;
  onChange?: (value: string) => void;
}>;

export function RichTextEditor({ id, name, defaultValue = '', disabled = false, className, onChange }: RichTextEditorProps): React.JSX.Element {
  const initialContent = React.useMemo(() => editorContent(defaultValue), [defaultValue]);
  const [value, setValue] = React.useState('');
  const editor = useEditor({
    immediatelyRender: false,
    editable: !disabled,
    content: initialContent,
    extensions: [
      StarterKit,
      TextStyle,
      FontFamily,
      FontSize,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
    ],
    editorProps: {
      attributes: {
        id,
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': 'Message',
        class: 'min-h-56 px-4 py-3 text-base leading-6 outline-none',
      },
    },
    onCreate: ({ editor: current }) => { setValue(current.getText().trim() ? current.getHTML() : ''); },
    onUpdate: ({ editor: current }) => {
      const next = current.getText().trim() ? current.getHTML() : '';
      setValue(next);
      onChange?.(next);
    },
  });

  React.useEffect(() => { editor?.setEditable(!disabled); }, [disabled, editor]);
  React.useEffect(() => {
    if (!editor) return;
    editor.commands.setContent(initialContent, { emitUpdate: false });
    setValue(editor.getText().trim() ? editor.getHTML() : '');
  }, [editor, initialContent]);

  const fontFamily = editor?.getAttributes('textStyle')['fontFamily'] as string | undefined;
  const fontSize = editor?.getAttributes('textStyle')['fontSize'] as string | undefined;
  const unavailable = disabled || !editor;
  const icon = 'size-4';

  return <div data-slot="rich-text-editor" className={cn('overflow-hidden rounded-lg border border-input bg-card focus-within:ring-2 focus-within:ring-ring', className)}>
    <div role="toolbar" aria-label="Message formatting" className="flex max-w-full items-center gap-1 overflow-x-auto border-b border-border bg-muted p-1.5">
      <div className="w-44 shrink-0">
        <Select aria-label="Font family" placeholder="Font" value={fontFamily ?? ''} disabled={unavailable} options={fontFamilies} onValueChange={(family) => { editor?.chain().focus().setFontFamily(family).run(); }} />
      </div>
      <div className="w-36 shrink-0">
        <Select aria-label="Font size" placeholder="Size" value={fontSize ?? ''} disabled={unavailable} options={fontSizes} onValueChange={(size) => { editor?.chain().focus().setFontSize(size).run(); }} />
      </div>
      <span aria-hidden="true" className="mx-1 h-7 w-px shrink-0 bg-border" />
      <ToolbarButton label="Bold" active={Boolean(editor?.isActive('bold'))} disabled={unavailable} onPress={() => { editor?.chain().focus().toggleBold().run(); }}><Bold aria-hidden="true" className={icon} /></ToolbarButton>
      <ToolbarButton label="Italic" active={Boolean(editor?.isActive('italic'))} disabled={unavailable} onPress={() => { editor?.chain().focus().toggleItalic().run(); }}><Italic aria-hidden="true" className={icon} /></ToolbarButton>
      <ToolbarButton label="Underline" active={Boolean(editor?.isActive('underline'))} disabled={unavailable} onPress={() => { editor?.chain().focus().toggleUnderline().run(); }}><UnderlineIcon aria-hidden="true" className={icon} /></ToolbarButton>
      <ToolbarButton label="Strikethrough" active={Boolean(editor?.isActive('strike'))} disabled={unavailable} onPress={() => { editor?.chain().focus().toggleStrike().run(); }}><Strikethrough aria-hidden="true" className={icon} /></ToolbarButton>
      <span aria-hidden="true" className="mx-1 h-7 w-px shrink-0 bg-border" />
      <ToolbarButton label="Bulleted list" active={Boolean(editor?.isActive('bulletList'))} disabled={unavailable} onPress={() => { editor?.chain().focus().toggleBulletList().run(); }}><List aria-hidden="true" className={icon} /></ToolbarButton>
      <ToolbarButton label="Numbered list" active={Boolean(editor?.isActive('orderedList'))} disabled={unavailable} onPress={() => { editor?.chain().focus().toggleOrderedList().run(); }}><ListOrdered aria-hidden="true" className={icon} /></ToolbarButton>
      <ToolbarButton label="Quote" active={Boolean(editor?.isActive('blockquote'))} disabled={unavailable} onPress={() => { editor?.chain().focus().toggleBlockquote().run(); }}><Quote aria-hidden="true" className={icon} /></ToolbarButton>
      <span aria-hidden="true" className="mx-1 h-7 w-px shrink-0 bg-border" />
      <ToolbarButton label="Align left" active={Boolean(editor?.isActive({ textAlign: 'left' }))} disabled={unavailable} onPress={() => { editor?.chain().focus().setTextAlign('left').run(); }}><AlignLeft aria-hidden="true" className={icon} /></ToolbarButton>
      <ToolbarButton label="Align center" active={Boolean(editor?.isActive({ textAlign: 'center' }))} disabled={unavailable} onPress={() => { editor?.chain().focus().setTextAlign('center').run(); }}><AlignCenter aria-hidden="true" className={icon} /></ToolbarButton>
      <ToolbarButton label="Align right" active={Boolean(editor?.isActive({ textAlign: 'right' }))} disabled={unavailable} onPress={() => { editor?.chain().focus().setTextAlign('right').run(); }}><AlignRight aria-hidden="true" className={icon} /></ToolbarButton>
      <span aria-hidden="true" className="mx-1 h-7 w-px shrink-0 bg-border" />
      <ToolbarButton label="Undo" disabled={unavailable || !editor.can().chain().focus().undo().run()} onPress={() => { editor?.chain().focus().undo().run(); }}><Undo2 aria-hidden="true" className={icon} /></ToolbarButton>
      <ToolbarButton label="Redo" disabled={unavailable || !editor.can().chain().focus().redo().run()} onPress={() => { editor?.chain().focus().redo().run(); }}><Redo2 aria-hidden="true" className={icon} /></ToolbarButton>
    </div>
    <EditorContent editor={editor} className="[&_.tiptap_blockquote]:border-l-4 [&_.tiptap_blockquote]:border-border [&_.tiptap_blockquote]:pl-4 [&_.tiptap_ol]:list-decimal [&_.tiptap_ol]:pl-6 [&_.tiptap_p]:my-2 [&_.tiptap_ul]:list-disc [&_.tiptap_ul]:pl-6" />
    <Input type="hidden" name={name} value={value} readOnly />
  </div>;
}
