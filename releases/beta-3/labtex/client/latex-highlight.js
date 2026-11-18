// Syntax colors for LaTeX/BibTeX (legacy stex tokens) in light and dark themes.
// Unlike CodeMirror's default style, \commands get their own color.
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

const light = HighlightStyle.define([
  { tag: t.tagName, color: '#1f5f99' },                       // \commands
  { tag: t.atom, color: '#221199' },                          // {arguments} of \begin, \cite, \label…
  { tag: t.keyword, color: '#770088' },                       // math delimiters
  { tag: t.number, color: '#116644' },
  { tag: t.bracket, color: '#5a6570' },
  { tag: t.comment, color: '#994400', fontStyle: 'italic' },
  { tag: t.string, color: '#aa1111' },
  { tag: t.standard(t.variableName), color: '#225566' },
  { tag: t.invalid, color: '#d00000' },
  { tag: t.heading, fontWeight: 'bold' },
]);

const dark = HighlightStyle.define([
  { tag: t.tagName, color: '#7cc0ff' },
  { tag: t.atom, color: '#e5c07b' },
  { tag: t.keyword, color: '#d19af0' },
  { tag: t.number, color: '#e0a172' },
  { tag: t.bracket, color: '#98a4b0' },
  { tag: t.comment, color: '#7d8a96', fontStyle: 'italic' },
  { tag: t.string, color: '#a5d68a' },
  { tag: t.standard(t.variableName), color: '#62c6d1' },
  { tag: t.invalid, color: '#ff7b72' },
  { tag: t.heading, fontWeight: 'bold' },
]);

export const latexHighlight = (isDark) => syntaxHighlighting(isDark ? dark : light);
