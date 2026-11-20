// Autocomplete for LaTeX: commands, environments, \cite keys and \ref labels.
const COMMANDS = `section subsection subsubsection paragraph subparagraph chapter part
textbf textit texttt textsc textsf emph underline footnote footnotetext marginpar
label ref eqref pageref autoref cref Cref cite citep citet citeauthor citeyear parencite textcite autocite nocite
includegraphics caption centering raggedright raggedleft input include includeonly
begin end item maketitle tableofcontents listoffigures listoftables appendix
title author date thanks and today newpage clearpage cleardoublepage pagebreak linebreak newline noindent indent
vspace hspace vfill hfill smallskip medskip bigskip quad qquad
frac dfrac tfrac sqrt sum prod int iint oint lim infty partial nabla cdot cdots ldots vdots ddots times div pm mp
alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi varpi rho sigma tau upsilon phi varphi chi psi omega
Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega
mathbb mathcal mathbf mathrm mathit mathsf mathtt mathfrak boldsymbol text operatorname
left right big Big bigg Bigg langle rangle lfloor rfloor lceil rceil
leq geq neq approx equiv sim simeq propto in notin subset subseteq supset supseteq cup cap setminus emptyset forall exists neg land lor implies iff to mapsto rightarrow leftarrow Rightarrow Leftarrow leftrightarrow
hat bar tilde vec dot ddot overline underbrace overbrace
usepackage documentclass newcommand renewcommand newenvironment DeclareMathOperator providecommand setlength addtolength setcounter
bibliography bibliographystyle addbibresource printbibliography
hline toprule midrule bottomrule cline multicolumn multirow
url href hyperref
small footnotesize scriptsize tiny large Large LARGE huge Huge normalsize
color textcolor
frametitle framesubtitle pause titlepage usetheme`.split(/\s+/);

const ENVS = `document equation equation* align align* gather gather* multline split cases matrix pmatrix bmatrix vmatrix
figure figure* table table* tabular tabular* tabularx center flushleft flushright
itemize enumerate description quote quotation verbatim abstract minipage
theorem lemma proof corollary definition proposition remark example
frame block columns column thebibliography subfigure array`.split(/\s+/);

export const ENVIRONMENTS = ENVS;

const SNIPPET_CMDS = {
  frac: '\\frac{}{}', sqrt: '\\sqrt{}', section: '\\section{}', subsection: '\\subsection{}', subsubsection: '\\subsubsection{}', chapter: '\\chapter{}',
  textbf: '\\textbf{}', textit: '\\textit{}', emph: '\\emph{}', texttt: '\\texttt{}', label: '\\label{}', ref: '\\ref{}', eqref: '\\eqref{}', cite: '\\cite{}',
  citep: '\\citep{}', citet: '\\citet{}', includegraphics: '\\includegraphics[width=\\linewidth]{}', caption: '\\caption{}', footnote: '\\footnote{}',
  usepackage: '\\usepackage{}', input: '\\input{}', include: '\\include{}', url: '\\url{}', href: '\\href{}{}', mathbb: '\\mathbb{}', mathcal: '\\mathcal{}',
  mathbf: '\\mathbf{}', mathrm: '\\mathrm{}', text: '\\text{}',
};

/** keys: () => ({ cites: string[], labels: string[] }) */
export function latexCompletions(getKeys) {
  return (ctx) => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);

    let m = before.match(/\\(?:[a-zA-Z]*cite[a-zA-Z]*\*?|nocite)(?:\[[^\]]*\])*\{([^}]*)$/);
    if (m) {
      const part = m[1].split(',').pop().trimStart();
      return { from: ctx.pos - part.length, options: getKeys().cites.map((k) => ({ label: k.key, detail: k.detail, type: 'text' })), validFor: /^[^,}\s]*$/ };
    }
    m = before.match(/\\(?:ref|eqref|pageref|autoref|cref|Cref|nameref|vref)\{([^}]*)$/);
    if (m) return { from: ctx.pos - m[1].length, options: getKeys().labels.map((k) => ({ label: k, type: 'variable' })), validFor: /^[^}\s]*$/ };
    m = before.match(/\\(begin|end)\{([a-zA-Z*]*)$/);
    if (m) {
      const isBegin = m[1] === 'begin';
      const indent = line.text.match(/^\s*/)[0];
      return {
        from: ctx.pos - m[2].length, validFor: /^[a-zA-Z*]*$/,
        options: ENVS.map((e) => ({
          label: e, type: 'type',
          apply: isBegin ? (view, c, f, t) => {
            const skip = view.state.sliceDoc(t, t + 1) === '}' ? 1 : 0;
            const ins = `${e}}\n${indent}  \n${indent}\\end{${e}}`;
            view.dispatch({ changes: { from: f, to: t + skip, insert: ins }, selection: { anchor: f + e.length + 1 + 1 + indent.length + 2 } });
          } : undefined,
        })),
      };
    }
    m = before.match(/\\(?:input|include|includegraphics(?:\[[^\]]*\])?)\{([^}]*)$/);
    if (m) return { from: ctx.pos - m[1].length, options: getKeys().files.map((f) => ({ label: f, type: 'text' })), validFor: /^[^}]*$/ };
    m = before.match(/\\([a-zA-Z]*)$/);
    if (m && (m[1].length > 0 || ctx.explicit)) {
      const from = ctx.pos - m[1].length - 1;
      const opts = COMMANDS.map((c) => ({
        label: '\\' + c, type: 'keyword',
        apply: SNIPPET_CMDS[c] ? (view, completion, f, t) => {
          const s = SNIPPET_CMDS[c];
          const caret = s.indexOf('{}') >= 0 ? s.indexOf('{}') + 1 : s.length;
          view.dispatch({ changes: { from: f, to: t, insert: s }, selection: { anchor: f + caret } });
        } : undefined,
      }));
      opts.push({
        label: '\\begin{…}', type: 'keyword', detail: 'environment',
        apply: (view, completion, f, t) => {
          const indent = line.text.match(/^\s*/)[0];
          const ins = `\\begin{}\n${indent}  \n${indent}\\end{}`;
          view.dispatch({ changes: { from: f, to: t, insert: ins }, selection: { anchor: f + 7 } });
        },
      });
      return { from, options: opts, validFor: /^\\[a-zA-Z]*$/ };
    }
    return null;
  };
}

/** Extract bib keys (with a short title) from .bib text. */
export function parseBibKeys(text) {
  const out = [];
  const re = /@(\w+)\s*\{\s*([^,\s]+)\s*,/g;
  let m;
  while ((m = re.exec(text))) {
    if (/^(comment|string|preamble)$/i.test(m[1])) continue;
    const chunk = text.slice(m.index, m.index + 1200);
    const title = chunk.match(/title\s*=\s*[{"](.+?)[}"]\s*,?\s*\n/i)?.[1]?.replace(/[{}]/g, '');
    out.push({ key: m[2], detail: title ? title.slice(0, 60) : m[1] });
  }
  return out;
}
export const parseLabels = (text) => [...text.matchAll(/\\label\{([^}]+)\}/g)].map((m) => m[1]);
