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
      <h1 className="text-lg font-semibold">Tools</h1>
      <p className="mt-1">
        The live agent surface of this page, read straight from the browser. No agent is
        involved.
      </p>

      <section aria-labelledby="support-heading" className="mt-4">
        <h2 id="support-heading" className="text-xs font-semibold uppercase tracking-wide">
          Support
        </h2>

        <p id="mc-support" aria-live="polite" className="mt-1">
          {supported}
        </p>

        {available === false ? (
          <div className="mt-2 border p-3">
            <p>To switch it on, start Chrome with:</p>
            <pre className="mt-1 overflow-x-auto border p-2 text-xs">{CHROME_SWITCH}</pre>
            <p className="mt-2">
              The ChatGPT desktop app&rsquo;s built-in browser supports WebMCP natively, with no
              switch to set.
            </p>
          </div>
        ) : null}

        <button type="button" className="mt-2 border px-3 py-1" onClick={() => void refresh()}>
          Refresh the tool list
        </button>
      </section>

      <section aria-labelledby="registered-heading" className="mt-6">
        <h2 id="registered-heading" className="text-xs font-semibold uppercase tracking-wide">
          Registered tools ({rows.length})
        </h2>

        <div className="mt-2 overflow-x-auto">
          <table id="tools-table" className="w-full border text-left">
            <caption className="sr-only">Tools currently registered by this page</caption>
            <thead>
              <tr>
                <th scope="col" className="border p-2">
                  Name
                </th>
                <th scope="col" className="border p-2">
                  Kind
                </th>
                <th scope="col" className="border p-2">
                  Description
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td className="border p-2" colSpan={3}>
                    No tools registered.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.name} data-tool={row.name}>
                    <th scope="row" className="border p-2 font-mono font-normal">
                      {row.name}
                    </th>
                    <td className="border p-2">
                      {row.readOnly ? 'read' : 'write'}
                      {row.untrustedContent ? ' · untrusted content' : ''}
                    </td>
                    <td className="border p-2">
                      {row.description}
                      <details className="mt-1">
                        <summary>Input schema</summary>
                        <pre className="mt-1 overflow-x-auto text-xs">{row.schema}</pre>
                      </details>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="console-heading" className="mt-6">
        <h2 id="console-heading" className="text-xs font-semibold uppercase tracking-wide">
          Run a tool
        </h2>

        <div className="mt-2 flex flex-wrap items-end gap-2">
          <p>
            <label htmlFor="tool-select" className="block">
              Tool
            </label>
            <select
              id="tool-select"
              className="border px-2 py-1"
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
            className="border px-3 py-1"
            disabled={running || !selected}
            onClick={() => void run()}
          >
            {running ? 'Running…' : 'Run'}
          </button>
        </div>

        <p className="mt-2">
          <label htmlFor="tool-args" className="block">
            Arguments (JSON)
          </label>
          <textarea
            id="tool-args"
            className="w-full border p-2 font-mono text-xs"
            rows={4}
            spellCheck={false}
            value={args}
            onChange={(event) => setArgs(event.target.value)}
          />
        </p>

        <pre
          id="tool-output"
          ref={outputRef}
          aria-live="polite"
          className="mt-2 overflow-x-auto border p-2 text-xs"
        >
          {output || 'Nothing run yet.'}
        </pre>
      </section>
    </div>
  );
}
