'use client';

/**
 * The tool surface, without an agent.
 *
 * A reviewer should be able to see exactly what this page offers — names, descriptions, the
 * read/write split — and run any of it by hand, with no extension, no account and no model
 * in the loop. Everything here talks to `document.modelContext` directly.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { getModelContext, invokeRegisteredTool, listRegisteredTools } from '@rotaproof/registry';

/** The exact switch that turns the API on in a Chrome that has it behind a flag. */
const CHROME_SWITCH = '--enable-features=WebMCPTesting --enable-blink-features=WebMCP';

/**
 * What the browser hands back varies by host.
 *
 * Through `document.modelContext.getTools()` the schema arrives as a JSON string and the
 * annotations keep their spec names. Through a driver's own agent-side API the schema is an
 * object and the annotations are renamed. Both are read here rather than assumed.
 */
interface RawTool {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; readOnly?: boolean; untrustedContentHint?: boolean; untrustedContent?: boolean };
}

interface ToolRow {
  handle: unknown;
  name: string;
  description: string;
  readOnly: boolean;
  untrustedContent: boolean;
  schema: string;
}

function normalise(tool: RawTool): ToolRow {
  const annotations = tool.annotations ?? {};
  return {
    handle: tool,
    name: String(tool.name ?? '(unnamed)'),
    description: String(tool.description ?? ''),
    readOnly: annotations.readOnlyHint === true || annotations.readOnly === true,
    untrustedContent:
      annotations.untrustedContentHint === true || annotations.untrustedContent === true,
    schema:
      typeof tool.inputSchema === 'string'
        ? tool.inputSchema
        : JSON.stringify(tool.inputSchema ?? {}, null, 2),
  };
}

export default function ToolInspector() {
  const [supported, setSupported] = useState('Checking…');
  const [available, setAvailable] = useState<boolean | null>(null);
  const [rows, setRows] = useState<ToolRow[]>([]);
  const [selected, setSelected] = useState('');
  const [args, setArgs] = useState('{}');
  const [output, setOutput] = useState('');
  const [running, setRunning] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);

  const refresh = useCallback(async () => {
    const context = getModelContext();
    if (!context) {
      setAvailable(false);
      setSupported('document.modelContext is undefined — WebMCP is not available in this browser.');
      setRows([]);
      return;
    }

    setAvailable(true);
    setSupported('document.modelContext is available.');
    const tools = (await listRegisteredTools()) as RawTool[];
    const list = tools.map(normalise);
    setRows(list);
    setSelected((current) =>
      list.some((row) => row.name === current) ? current : (list[0]?.name ?? ''),
    );
  }, []);

  useEffect(() => {
    // The layout registers the surface; give that pass a moment to land before reading it.
    const timer = setTimeout(() => void refresh(), 200);

    let detach: (() => void) | undefined;
    try {
      const context = getModelContext() as unknown as EventTarget | undefined;
      if (context && typeof context.addEventListener === 'function') {
        const handler = () => void refresh();
        context.addEventListener('toolchange', handler);
        detach = () => context.removeEventListener('toolchange', handler);
      }
    } catch {
      // Not every host makes the model context an EventTarget. Refresh is manual there.
    }

    return () => {
      clearTimeout(timer);
      detach?.();
    };
  }, [refresh]);

  async function run() {
    const row = rows.find((candidate) => candidate.name === selected);
    if (!row) return;

    let parsed: Record<string, unknown>;
    try {
      parsed = args.trim() ? (JSON.parse(args) as Record<string, unknown>) : {};
    } catch (error) {
      setOutput(`The arguments are not valid JSON: ${String(error)}`);
      return;
    }

    setRunning(true);
    setOutput('Running…');
    const started = performance.now();
    try {
      const raw = await invokeRegisteredTool(row.handle as Parameters<typeof invokeRegisteredTool>[0], parsed);
      let shown = raw;
      try {
        shown = JSON.stringify(JSON.parse(raw) as unknown, null, 2);
      } catch {
        // A tool is allowed to return a bare string; show it as it came back.
      }
      setOutput(`ok in ${Math.round(performance.now() - started)}ms\n\n${shown}`);
    } catch (error) {
      setOutput(`Failed after ${Math.round(performance.now() - started)}ms\n${String(error)}`);
    } finally {
      setRunning(false);
      void refresh();
    }
  }

  return (
    <div>
      {/* ── support ──────────────────────────────────────────────────────── */}
      <section aria-labelledby="tools-heading" className="band">
        <div className="mod-head">
          <h1 id="tools-heading">Tools</h1>
          <p className="count-tag">{rows.length} registered</p>
        </div>

        <p className="mod-note">
          The live agent surface of this page, read straight from the browser. No agent is
          involved.
        </p>

        <p id="mc-support" aria-live="polite" className="solve-line gap-top" data-state={available === false ? 'error' : available ? 'optimal' : 'pending'}>
          <span className="pip" aria-hidden="true" />
          <span className="word">{supported}</span>
        </p>

        {available === false ? (
          <div className="gap-top">
            <p className="mod-note">To switch it on, start Chrome with:</p>
            <pre className="well gap-top">{CHROME_SWITCH}</pre>
            <p className="mod-note gap-top">
              The ChatGPT desktop app&rsquo;s built-in browser supports WebMCP natively, with no
              switch to set.
            </p>
          </div>
        ) : null}

        <div className="btnrow gap-top">
          <button type="button" className="btn" onClick={() => void refresh()}>
            Refresh the tool list
          </button>
        </div>
      </section>

      {/* ── the surface ──────────────────────────────────────────────────── */}
      <section aria-labelledby="registered-heading" className="mod">
        <div className="mod-head">
          <h2 id="registered-heading">Registered tools</h2>
          <p className="mod-note">
            A read sits on the surface; a write is pressed into it. The set changes with the
            page — what is here is what an agent can reach right now.
          </p>
        </div>

        <div className="scroll" tabIndex={0} role="region" aria-label="Registered tools">
          <table id="tools-table" className="tools">
            <caption>Tools currently registered by this page.</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col" className="kindcol">
                  Kind
                </th>
                <th scope="col">Description</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={3}>No tools registered.</td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.name} data-tool={row.name}>
                    <th scope="row">{row.name}</th>
                    <td className="kindcol">
                      <span className={`pill ${row.readOnly ? 'pill-read' : 'pill-write'}`}>
                        <span className="sq" aria-hidden="true" />
                        {row.readOnly ? 'read' : 'write'}
                      </span>
                      {row.untrustedContent ? (
                        <span className="rule-sub">untrusted content</span>
                      ) : null}
                    </td>
                    <td className="desc">
                      {row.description}
                      <details className="schema">
                        <summary>Input schema</summary>
                        <pre className="well">{row.schema}</pre>
                      </details>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── run one by hand ──────────────────────────────────────────────── */}
      <section aria-labelledby="console-heading" className="mod">
        <div className="mod-head">
          <h2 id="console-heading">Run a tool</h2>
          <p className="mod-note">
            Call anything on the surface yourself — no extension, no account, no model in the
            loop.
          </p>
        </div>

        {/* The picker and its trigger sit together; the arguments get the full measure. */}
        <div className="fieldrow">
          <p className="field grow">
            <label htmlFor="tool-select">Tool</label>
            <select
              id="tool-select"
              className="control"
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
            >
              {rows.map((row) => (
                <option key={row.name} value={row.name}>
                  {row.name}
                </option>
              ))}
            </select>
          </p>

          <button
            id="run-tool"
            type="button"
            className="btn btn-primary"
            disabled={running || !selected}
            onClick={() => void run()}
          >
            {running ? 'Running…' : 'Run'}
          </button>
        </div>

        <p className="field gap-top">
          <label htmlFor="tool-args">Arguments (JSON)</label>
          <textarea
            id="tool-args"
            className="control"
            rows={4}
            spellCheck={false}
            value={args}
            onChange={(event) => setArgs(event.target.value)}
          />
        </p>

        <pre id="tool-output" ref={outputRef} aria-live="polite" className="well gap-top">
          {output || 'Nothing run yet.'}
        </pre>
      </section>
    </div>
  );
}
