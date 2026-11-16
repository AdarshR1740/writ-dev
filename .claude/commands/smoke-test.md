---
description: Walk a test piece through every step of the Writ app in the browser and report anything blank, broken or confusing
argument-hint: <piece code, for example SI-0013>
---

You are smoke-testing the Writ web app on piece **$ARGUMENTS** with your own eyes, and checking it against what the data says should be there.

## Before you start
- The dev server must be running on http://localhost:5173 and the writer must already be **signed in in the browser pane**. If the page shows the sign-in form, stop and ask them to sign in themselves. Never type a password or any credential.
- Ask the writer to confirm that this piece is a test piece and that the dev server is not pointed at production data, before you open anything.
- Use only the test piece named above. This is a read-only test: do not save, confirm, reopen, delete or generate anything unless the writer tells you to.

## Steps
1. Call `writ_check_piece` for the piece. Its `what_the_writer_sees` is the spec for each step, and its `concerns` are what to look for.
2. Open the piece in the browser and visit each step tab in turn: Scope, Research, Outline, Writing, Sign-off. For each one:
   - read the page text and take a screenshot;
   - compare with `what_the_writer_sees` for that step;
   - read the browser console for errors.
3. Judge each step as a first-time reader would: is anything **blank** that should have content, is a heading, button or list missing, is the wording confusing, is anything cut off or overlapping, does an obvious next action exist?
4. On the Outline and Writing steps, also look at sub-headings if the piece has them: they should be nested under their main heading, in order.

## Report
One line per step: OK, or what is wrong, with what you saw against what the data says it should be. Then a short list of anything confusing even if it works. Do not fix anything; say what you would change. Mention what you could not check (for example a step the piece has not reached).

## Cover these states when you have the pieces
A piece made through the MCP server (no gap analysis); the same piece after reopening the outline; a piece with sub-headings; a one-section format; a piece with every section written. If a state is not available, say so rather than skipping it silently.
