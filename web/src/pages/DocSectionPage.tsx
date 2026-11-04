import { Link } from "react-router-dom";
import { useParams } from "react-router-dom";
import { useCompany } from "../lib/session";
import { DOC_SECTIONS } from "../lib/sections";
import { useSetupStatus } from "../components/Layout";
import { DocumentWorkbench } from "../components/DocumentWorkbench";
import { Loading, PromptHelper } from "../components/ui";
import { StepNav } from "../components/StepNav";

export function DocSectionPage() {
  const { section } = useParams();
  const company = useCompany();
  const { status, refresh } = useSetupStatus();
  const s = DOC_SECTIONS.find((d) => d.path === section);
  if (!s) return <p>That section doesn't exist.</p>;
  if (!status) return <Loading />;
  const doc = status.docs[s.kind];
  if (!doc) return <p className="error">This company is missing its {s.title} document.</p>;

  return (
    <div className="page">
      <div className="page-head">
        <span className="eyebrow"><Link to="/house-file">House file</Link>{s.required ? "" : " · optional"}</span>
        <h1>{s.title}</h1>
        <p className="muted">{s.purpose}</p>
      </div>
      <PromptHelper title="Don't have this written down? Get it from your AI tool" prompt={s.prompt}>
        <p className="small muted">
          Paste this into ChatGPT, Claude or Gemini along with your existing docs, then add the answer here.
        </p>
      </PromptHelper>
      <DocumentWorkbench
        key={doc.id}
        documentId={doc.id}
        companyId={company.id}
        methods={s.methods}
        copy={s.material}
        onChanged={refresh}
      />
      <StepNav />
    </div>
  );
}
