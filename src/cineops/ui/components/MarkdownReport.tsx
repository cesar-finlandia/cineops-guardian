// CineOps Guardian — tiny safe Markdown report renderer (no new deps).
// Handles the summarize-run output: ### headings, **bold**, * bullets,
// numbered lists, paragraphs. No dangerouslySetInnerHTML, no HTML passthrough.
import type { JSX } from "react";

function renderInline(text: string, keyPrefix: string): (string | JSX.Element)[] {
  const parts: (string | JSX.Element)[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <strong key={`${keyPrefix}-b${i++}`}>{m[1]}</strong>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function MarkdownReport(props: { markdown: string }): JSX.Element {
  const { markdown } = props;
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: JSX.Element[] = [];
  let list: string[] = [];
  let ordered: string[] = [];

  const flushLists = (): void => {
    if (list.length > 0) {
      const items = list;
      list = [];
      blocks.push(
        <ul key={`ul-${blocks.length}`}>
          {items.map((t, i) => (
            <li key={i}>{renderInline(t, `ul${blocks.length}-${i}`)}</li>
          ))}
        </ul>,
      );
    }
    if (ordered.length > 0) {
      const items = ordered;
      ordered = [];
      blocks.push(
        <ol key={`ol-${blocks.length}`}>
          {items.map((t, i) => (
            <li key={i}>{renderInline(t, `ol${blocks.length}-${i}`)}</li>
          ))}
        </ol>,
      );
    }
  };

  lines.forEach((raw) => {
    const line = raw.trim();
    if (line.startsWith("### ")) {
      flushLists();
      blocks.push(<h3 key={`h-${blocks.length}`}>{renderInline(line.slice(4), `h${blocks.length}`)}</h3>);
    } else if (line.startsWith("## ")) {
      flushLists();
      blocks.push(<h3 key={`h-${blocks.length}`}>{renderInline(line.slice(3), `h${blocks.length}`)}</h3>);
    } else if (line.startsWith("# ")) {
      flushLists();
      blocks.push(<h3 key={`h-${blocks.length}`}>{renderInline(line.slice(2), `h${blocks.length}`)}</h3>);
    } else if (/^(\*|-)\s+/.test(line)) {
      if (ordered.length > 0) flushLists();
      list.push(line.replace(/^(\*|-)\s+/, ""));
    } else if (/^\d+[.)]\s+/.test(line)) {
      if (list.length > 0) flushLists();
      ordered.push(line.replace(/^\d+[.)]\s+/, ""));
    } else if (line === "") {
      flushLists();
    } else {
      flushLists();
      blocks.push(<p key={`p-${blocks.length}`}>{renderInline(raw.trim(), `p${blocks.length}`)}</p>);
    }
  });
  flushLists();

  if (blocks.length === 0) return <p>No summary available.</p>;
  return <div className="cineops-markdown-report">{blocks}</div>;
}
