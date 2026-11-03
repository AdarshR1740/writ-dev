import { Link } from "react-router-dom";
import { useCompany } from "../lib/session";
import { DOC_SECTIONS } from "../lib/sections";
import { useSetupStatus } from "../components/Layout";
import { Loading, Lede } from "../components/ui";
import { plural } from "../lib/format";

interface Item {
  to: string;
  title: string;
  detail: string;
  done: boolean;
  pending: boolean;
  optional?: boolean;
}

export function OverviewPage() {
  const company = useCompany();
  const { status } = useSetupStatus();
  if (!status) return <Loading />;

  const items: Item[] = [
    ...DOC_SECTIONS.map((s) => ({
      to: `/setup/${s.path}`,
      title: s.title,
      detail: s.purpose,
      done: Boolean(status.docs[s.kind]?.filled),
      pending: Boolean(status.docs[s.kind]?.pending),
      optional: !s.required,
    })),
    {
      to: "/formats",
      title: "Formats",
      detail: status.formats.length
        ? `${plural(status.formats.length, "format")}; ${status.formats.filter((f) => f.filled).length} with a style profile.`
        : "The formats you write, each learned from your best examples.",
      done: status.formats.some((f) => f.filled),
      pending: status.formats.some((f) => f.pending),
    },
    {
      to: "/insights",
      title: "Insights",
      detail: status.insightCount
        ? `${plural(status.insightCount, "insight card")}.`
        : "Stories, opinions and lessons only your company can tell, from calls and notes.",
      done: status.insightCount > 0,
      pending: false,
    },
    {
      to: "/data",
      title: "Proprietary data",
      detail: status.dataCount ? `${plural(status.dataCount, "data point")}.` : "Figures you've measured yourselves. Optional.",
      done: status.dataCount > 0,
      pending: false,
      optional: true,
    },
  ];
  const required = items.filter((i) => !i.optional);
  const doneCount = required.filter((i) => i.done).length;

  return (
    <div className="page page-narrow">
      <div className="page-head">
        <span className="eyebrow">{company.name}</span>
        <h1>House file</h1>
        <Lede more={<>Everything the writing pipeline knows about {company.name}: who you write for, how you sound, and what only you can say.</>}>
          {doneCount} of {required.length} required parts are in place.
        </Lede>
      </div>


      <div className="checklist">
        {items.map((i) => (
          <Link key={i.to} to={i.to} className="check-item">
            <span className={`check-mark${i.pending ? " pending" : i.done ? " done" : ""}`} aria-hidden>
              {i.pending ? "!" : i.done ? "✓" : ""}
            </span>
            <span className="stack" style={{ gap: 2 }}>
              <strong>{i.title}</strong>
              <span className="small muted">{i.detail}</span>
            </span>
            <span className={i.pending ? "tag flag" : i.done ? "small ok-text" : "small muted"}>
              {i.pending ? "Changes to review" : i.done ? "Done" : i.optional ? "Optional" : "Not started"}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

