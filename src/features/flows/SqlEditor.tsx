import { useEffect, useRef } from "react";

type SqlEditorProps = {
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
};

const SQL_KEYWORDS = /\b(SELECT|FROM|WHERE|INNER|JOIN|LEFT|RIGHT|FULL|OUTER|ON|INSERT|INTO|UPDATE|SET|VALUES|AS|AND|OR|NOT|NULL|IS|LIKE|GROUP|BY|ORDER|HAVING|LIMIT|MERGE|WHEN|MATCHED|THEN|DELETE|BEGIN|END)\b/gi;

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
}

function highlightedSql(value: string) {
  return escapeHtml(value).replace(SQL_KEYWORDS, (keyword) => `<span class="sql-token--keyword">${keyword}</span>`);
}

export function SqlEditor({ ariaLabel, value, onChange }: SqlEditorProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);

  const syncScroll = (input: HTMLTextAreaElement) => {
    const maxScrollTop = Math.max(0, input.scrollHeight - input.clientHeight);
    const scrollTop = Math.min(Math.max(0, input.scrollTop), maxScrollTop);
    const { scrollLeft } = input;
    if (input.scrollTop !== scrollTop) input.scrollTop = scrollTop;
    if (highlightRef.current) highlightRef.current.style.transform = `translate(${-scrollLeft}px, ${-scrollTop}px)`;
  };

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;

    syncScroll(input);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => syncScroll(input));
    observer.observe(input);
    return () => observer.disconnect();
  }, [value]);

  return (
    <div className="sql-editor">
      <div className="sql-editor__surface">
        <pre className="sql-editor__highlight" data-testid="sql-editor-highlight" ref={highlightRef} aria-hidden="true" dangerouslySetInnerHTML={{ __html: highlightedSql(value) }} />
        <textarea
          className="sql-editor__input"
          ref={inputRef}
          aria-label={ariaLabel}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onScroll={(event) => syncScroll(event.currentTarget)}
          spellCheck={false}
        />
      </div>
    </div>
  );
}
