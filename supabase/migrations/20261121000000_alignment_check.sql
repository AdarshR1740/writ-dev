-- The analysis step now checks the scope and research against the topic the piece started with, instead of
-- comparing sources. The two source-level switches (tensions, insight vs. consensus) leave the default recipe.
-- Recipes already saved on formats and pieces keep their old keys; nothing reads them any more.

-- Keep in sync with LONG_FORM in web/src/lib/recipes.ts (a test checks it).
create or replace function public.default_recipe() returns jsonb
language sql immutable as $$
  select '{"base":"long_form","brief":{"keyword":true,"goal":true,"audience":true,"customer":false,"offer":false},"contract":{"mode":"full","ai_thread":true},"research":{"enabled":true,"web_search":true,"max_searches":6,"serp":true,"cards":true,"library":true,"manual":true,"review":true},"analysis":{"enabled":true,"gaps":true,"contract_suggestions":true},"outline":{"mode":"free","template":[],"ai_thread":true,"seo_geo_check":true},"sections":{"research":true,"timing":"just_in_time","reuse_piece_items":true,"brief":true},"writing":{"ai_draft":true},"checks":{"grammar":true,"fact":true,"contract":true,"seo":true,"geo":true,"customer_approval":false},"signoff":{"required":true,"editor_required":false,"final_paste":true,"learn":true}}'::jsonb
$$;
