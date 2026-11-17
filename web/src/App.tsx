import { Navigate, Route, Routes } from "react-router-dom";
import { configured } from "./lib/supabase";
import { SessionProvider, useSession } from "./lib/session";
import { Layout } from "./components/Layout";
import { Loading } from "./components/ui";
import { UnsavedResult } from "./components/UnsavedResult";
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
import { LeaderVoicesPage } from "./pages/LeaderVoicesPage";
import { PromptsPage } from "./pages/PromptsPage";
import { ClaudePage } from "./pages/ClaudePage";
import { HistoryPage } from "./pages/HistoryPage";
import { OAuthConsentPage } from "./pages/OAuthConsentPage";
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
      <UnsavedResult />
    </SessionProvider>
  );
}

function Routed() {
  const { session, ready, companies, company } = useSession();

  if (!ready) return <div className="auth"><Loading /></div>;

  return (
    <Routes>
      <Route path="/invite/:token" element={<InvitePage />} />
      {/* Only once signed in: before that the sign-in page shows at this same address, then this. */}
      {session && <Route path="/oauth/consent" element={<OAuthConsentPage />} />}
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
                  <Route path="/voices" element={<LeaderVoicesPage />} />
                  <Route path="/team" element={<TeamPage />} />
                  <Route path="/ai" element={<AiSettingsPage />} />
                  <Route path="/prompts" element={<PromptsPage />} />
                  <Route path="/claude" element={<ClaudePage />} />
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
