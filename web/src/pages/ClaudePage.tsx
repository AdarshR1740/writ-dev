import { useMemo, useState } from "react";
import { MCP_REFERENCE, type McpTool } from "../lib/mcpTools.generated";
import { Lede } from "../components/ui";

const EFFECT: Record<McpTool["effect"], { label: string; cls: string }> = {
  reads: { label: "Only reads", cls: "tag" },
  saves: { label: "Saves", cls: "tag ok" },
  creates: { label: "Creates", cls: "tag ok" },
  "moves the piece on": { label: "Moves the piece on", cls: "tag flag" },
};

function Tool({ tool }: { tool: McpTool }) {
  const e = EFFECT[tool.effect];
  return (
    <article className="card stack" style={{ gap: 8 }} id={tool.name}>
      <div className="row" style={{ alignItems: "center", flexWrap: "wrap" }}>
        <code>{tool.name}</code>
        <span className={e.cls}>{e.label}</span>
        {tool.needsApproval && <span className="tag flag">Needs your go-ahead</span>}
      </div>
      <p style={{ margin: 0 }}>{tool.summary}</p>
      <p className="small muted" style={{ margin: 0 }}><strong>Used:</strong> {tool.when}</p>
      {tool.params.length > 0 && (
        <details>
          <summary className="small">Parameters ({tool.params.length})</summary>
          <ul className="small" style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {tool.params.map((p) => (
              <li key={p.name}>
                <code>{p.name}</code> <span className="muted">({p.type}{p.required ? ", required" : ", optional"})</span>
                {p.description ? `: ${p.description}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}

/**
 * What each of Writ's tools for Claude does. The content is generated from the MCP server (mcpTools.generated.ts), so it
 * lists exactly the tools that exist, with their parameters, and is refreshed whenever the server changes.
 */
export function ClaudePage() {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const groups = useMemo(
    () => MCP_REFERENCE.groups
      .map((g) => ({ ...g, tools: g.tools.filter((t) => !q || `${g.name} ${t.name} ${t.summary} ${t.when} ${t.params.map((p) => `${p.name} ${p.description}`).join(" ")}`.toLowerCase().includes(q)) }))
      .filter((g) => g.tools.length > 0),
    [q],
  );
  const prompts = MCP_REFERENCE.prompts.filter((p) => !q || `${p.name} ${p.command} ${p.summary} ${p.how}`.toLowerCase().includes(q));
  const toolCount = MCP_REFERENCE.groups.reduce((n, g) => n + g.tools.length, 0);
  const shown = groups.reduce((n, g) => n + g.tools.length, 0);

  return (
    <div className="page page-narrow">
      <div className="page-head">
        <span className="eyebrow">Settings</span>
        <h1>Writ in Claude</h1>
        <Lede more={<>
          Claude connects to Writ through a small server on your computer, signed in as you. It runs on your own Claude subscription, so there is no AI key to set up for it.
          You approve every step that changes the direction of a piece; what Claude saves stays editable here. Start with <code>/writ:onboarding</code> in Claude if you are new.
          This page is generated from the server itself (version {MCP_REFERENCE.version}), so it always lists the tools that exist.
        </>}>
          What each of Writ's {toolCount} tools for Claude does, and the prompts that string them together.
        </Lede>
      </div>
      <div className="stack-lg">
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the tools" aria-label="Search the tools" />
        <p className="small muted" role="status" aria-live="polite" style={{ margin: 0 }}>
          {q ? (shown === 0 && prompts.length === 0 ? "No tool matches that." : `${shown} of ${toolCount} tools match.`) : `${toolCount} tools and ${MCP_REFERENCE.prompts.length} prompts.`}
        </p>
        {groups.map((g) => (
          <section key={g.name} className="stack" style={{ gap: 8 }}>
            <h2>{g.name}</h2>
            {g.tools.map((t) => <Tool key={t.name} tool={t} />)}
          </section>
        ))}
        {prompts.length > 0 && (
          <section className="stack" style={{ gap: 8 }}>
            <h2>Prompts</h2>
            <p className="small muted">Start these from Claude by typing the command.</p>
            {prompts.map((p) => (
              <article key={p.name} className="card stack" style={{ gap: 8 }}>
                <code>{p.command}</code>
                <p style={{ margin: 0 }}>{p.summary}</p>
                <p className="small muted" style={{ margin: 0 }}>{p.how}</p>
                {p.args.length > 0 && (
                  <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                    {p.args.map((a) => <li key={a.name}><code>{a.name}</code>{a.required ? "" : " (optional)"}: {a.description}</li>)}
                  </ul>
                )}
              </article>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
