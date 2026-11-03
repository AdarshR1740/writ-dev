import { Navigate, Route, Routes } from "react-router-dom";
import { configured } from "./lib/supabase";
import { SessionProvider, useSession } from "./lib/session";
import { Layout } from "./components/Layout";
import { Loading } from "./components/ui";
import { AuthPage } from "./pages/AuthPage";
import { InvitePage } from "./pages/InvitePage";
import { NewCompanyPage } from "./pages/NewCompanyPage";
import { OverviewPage } from "./pages/OverviewPage";
import { DocSectionPage } from "./pages/DocSectionPage";
import { FormatDetailPage, FormatsPage } from "./pages/FormatsPage";
import { CardsPage } from "./pages/CardsPage";
import { TeamPage } from "./pages/TeamPage";
import { AiSettingsPage } from "./pages/AiSettingsPage";
import { PiecesPage } from "./pages/PiecesPage";
import { PiecePage } from "./pages/PiecePage";
import { LibraryPage } from "./pages/LibraryPage";
import { VoiceMemoryPage } from "./pages/VoiceMemoryPage";
import { HistoryPage } from "./pages/HistoryPage";
import { NewRepurposePage, RepurposePlanPage } from "./pages/RepurposePage";

export function App() {
  if (!configured) {
    return (
      <div className="auth">
        <div className="auth-box">
          <h1>Connect Supabase</h1>
          <p className="lede">
            Copy <span className="mono">.env.example</span> to <span className="mono">.env</span>, add your project URL and anon
            key, then restart the dev server. The README walks through it.
          </p>
        </div>
      </div>
    );
  }
  return (
    <SessionProvider>
      <Routed />
    </SessionProvider>
  );
}

function Routed() {
  const { session, ready, companies, company } = useSession();

  if (!ready) return <div className="auth"><Loading /></div>;

  return (
    <Routes>
      <Route path="/invite/:token" element={<InvitePage />} />
      {!session ? (
        <Route path="*" element={<AuthPage />} />
      ) : companies.length === 0 ? (
        <>
          <Route path="/new-company" element={<NewCompanyPage first />} />
          <Route path="*" element={<Navigate to="/new-company" replace />} />
        </>
      ) : (
        <>
          <Route path="/new-company" element={<NewCompanyPage />} />
          <Route
            path="*"
            element={
              <Layout key={company!.id}>
                <Routes>
                  {/* Writing is home; the house file is the context behind it. */}
                  <Route path="/" element={<Navigate to="/pieces" replace />} />
                  <Route path="/house-file" element={<OverviewPage />} />
                  <Route path="/setup/:section" element={<DocSectionPage />} />
                  <Route path="/formats" element={<FormatsPage />} />
                  <Route path="/formats/:formatId" element={<FormatDetailPage />} />
                  <Route path="/insights" element={<CardsPage key="insights" mode="insights" />} />
                  <Route path="/data" element={<CardsPage key="data" mode="data" />} />
                  <Route path="/pieces" element={<PiecesPage />} />
                  <Route path="/pieces/:pieceId" element={<PiecePage />} />
                  <Route path="/library" element={<LibraryPage />} />
                  <Route path="/history" element={<HistoryPage />} />
                  <Route path="/repurpose/new" element={<NewRepurposePage />} />
                  <Route path="/repurpose/:planId" element={<RepurposePlanPage />} />
                  <Route path="/voice-memory" element={<VoiceMemoryPage />} />
                  <Route path="/team" element={<TeamPage />} />
                  <Route path="/ai" element={<AiSettingsPage />} />
                  <Route path="*" element={<Navigate to="/pieces" replace />} />
                </Routes>
              </Layout>
            }
          />
        </>
      )}
    </Routes>
  );
}
