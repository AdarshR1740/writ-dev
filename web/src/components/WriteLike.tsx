import { useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { must, useLoad } from "../lib/useLoad";
import { useCompany } from "../lib/session";
import { writeLikePrompt } from "../lib/sections";
import type { LeaderVoice } from "../lib/types";
import { CopyButton } from "./ui";

/**
 * "Write like X": the writer picks one of the company's leader voices and copies a prompt plus their text
 * into their own AI tool, then pastes the edited text back. Writ never restyles text itself.
 */
export function WriteLike({ text, what = "section" }: { text: string; what?: string }) {
  const company = useCompany();
  const { data: voices, error } = useLoad(
    async () => must<LeaderVoice[]>(await supabase.from("leader_voices").select("*").eq("company_id", company.id).order("name")),
    [company.id],
  );
  const [chosen, setChosen] = useState("");

  if (error) return <p className="small muted">Leader voices couldn't be loaded.</p>;
  if (!voices) return <p className="small muted">Loading voices…</p>;
  if (voices.length === 0) {
    return (
      <p className="small muted">
        No leader voices are defined yet. {company.role === "editor"
          ? <>Add one on the <Link to="/voices">Leader voices</Link> page.</>
          : "An editor can add them on the Leader voices page."}
      </p>
    );
  }

  const voice = voices.find((v) => v.id === chosen) ?? null;
  const prompt = voice ? writeLikePrompt(voice) : "";

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <select value={chosen} onChange={(e) => setChosen(e.target.value)} aria-label="Leader voice">
          <option value="">Choose a voice…</option>
          {voices.map((v) => <option key={v.id} value={v.id}>{v.name}{v.role ? `, ${v.role}` : ""}</option>)}
        </select>
        {voice && text.trim() && <CopyButton text={`${prompt}\n\n<text>\n${text}\n</text>`} label={`Copy prompt + this ${what}`} />}
        {voice && <CopyButton text={prompt} label="Copy prompt only" />}
      </div>
      <p className="small muted">
        Paste it into ChatGPT, Claude or Gemini, then paste the result back into the box above. Read it against the original: the facts must not change.
      </p>
    </div>
  );
}
