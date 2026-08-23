export type DraftBodyFormat = 'html' | 'markdown';

export type RichTextEditorProps = Readonly<{
  id: string;
  name: string;
  defaultValue?: string;
  defaultFormat?: DraftBodyFormat;
  formatName?: string;
  disabled?: boolean;
  className?: string;
  ariaLabelledBy?: string;
  onChange?: (value: string) => void;
}>;
