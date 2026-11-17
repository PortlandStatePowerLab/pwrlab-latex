// Built-in starter templates. Labs can add their own by marking any project as a "lab template".
export const BUILTIN_TEMPLATES = [
  {
    id: 'blank',
    name: 'Blank article',
    description: 'A minimal article with title, sections and an equation.',
    files: {
      'main.tex': String.raw`\documentclass[11pt]{article}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage[margin=1in]{geometry}
\usepackage{hyperref}

\title{Untitled}
\author{Your Name}
\date{\today}

\begin{document}
\maketitle

\section{Introduction}
Start writing here. Inline math like $e^{i\pi} + 1 = 0$ and display math:
\begin{equation}
  \int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}.
\end{equation}

\end{document}
`,
    },
  },
  {
    id: 'paper',
    name: 'Lab paper (with BibTeX)',
    description: 'Two-column style paper with abstract, figure, project refs.bib and the shared lab library.',
    files: {
      'main.tex': String.raw`\documentclass[10pt,twocolumn]{article}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage[margin=0.8in]{geometry}
\usepackage[numbers]{natbib}
\usepackage{hyperref}

\title{Paper Title}
\author{First Author \and Second Author \\ \small Our Lab, Our University}
\date{}

\begin{document}
\maketitle

\begin{abstract}
One paragraph summarising the problem, approach, and key result.
\end{abstract}

\section{Introduction}
Prior work includes the classic text by Knuth~\cite{knuth1984} (from the shared lab library)
and our own earlier results~\cite{ourlab2024}.

\section{Methods}
\input{sections/methods}

\section{Results}
\begin{table}[h]
  \centering
  \begin{tabular}{lrr}
    \toprule
    Condition & Mean & SD \\
    \midrule
    Control   & 1.00 & 0.10 \\
    Treatment & 1.42 & 0.12 \\
    \bottomrule
  \end{tabular}
  \caption{Example results.}
\end{table}

\section{Conclusion}
Summarise the findings.

\bibliographystyle{unsrtnat}
% refs.bib = this project's references; lab = the lab-wide shared library
\bibliography{refs,lab}
\end{document}
`,
      'sections/methods.tex': String.raw`Describe the experimental setup here. Equations are numbered automatically:
\begin{equation}
  y = \beta_0 + \beta_1 x + \varepsilon.
\end{equation}
`,
      'refs.bib': `@article{ourlab2024,
  author  = {Doe, Jane and Smith, John},
  title   = {An Important Earlier Result},
  journal = {Journal of Examples},
  year    = {2024},
  volume  = {12},
  pages   = {1--10}
}
`,
    },
  },
  {
    id: 'thesis',
    name: 'Thesis / report',
    description: 'Report class with chapters split into separate files, table of contents and bibliography.',
    files: {
      'main.tex': String.raw`\documentclass[12pt,oneside]{report}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{amsmath,amssymb,amsthm}
\usepackage{graphicx}
\usepackage[margin=1in]{geometry}
\usepackage{setspace}
\usepackage[numbers]{natbib}
\usepackage{hyperref}
\onehalfspacing

\newtheorem{theorem}{Theorem}[chapter]

\title{Thesis Title}
\author{Student Name}
\date{\today}

\begin{document}
\maketitle
\begin{abstract}
Abstract goes here.
\end{abstract}
\tableofcontents

\include{chapters/introduction}
\include{chapters/background}
\include{chapters/conclusion}

\bibliographystyle{plainnat}
\bibliography{refs,lab}
\end{document}
`,
      'chapters/introduction.tex': String.raw`\chapter{Introduction}
Motivation and contributions of this thesis~\cite{knuth1984}.
`,
      'chapters/background.tex': String.raw`\chapter{Background}
\begin{theorem}
Every bounded monotone sequence of real numbers converges.
\end{theorem}
`,
      'chapters/conclusion.tex': String.raw`\chapter{Conclusion}
Summary and future work.
`,
      'refs.bib': `% Thesis-specific references go here.
`,
    },
  },
  {
    id: 'beamer',
    name: 'Presentation (Beamer)',
    description: 'Slides for lab meetings and talks.',
    files: {
      'main.tex': String.raw`\documentclass{beamer}
\usetheme{Madrid}
\usepackage{amsmath}

\title{Lab Meeting}
\subtitle{Progress Update}
\author{Your Name}
\date{\today}

\begin{document}
\frame{\titlepage}

\begin{frame}{Outline}
  \tableofcontents
\end{frame}

\section{Progress}
\begin{frame}{What I did this week}
  \begin{itemize}
    \item<1-> Ran experiment A
    \item<2-> Analysed results
    \item<3-> Drafted section 2
  \end{itemize}
\end{frame}

\section{Next steps}
\begin{frame}{Next steps}
  \begin{block}{Plan}
    Finish the analysis and share a draft.
  \end{block}
\end{frame}
\end{document}
`,
    },
  },
];
