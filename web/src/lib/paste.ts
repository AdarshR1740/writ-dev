/**
 * Tidies text pasted from a web page, PDF, chat or document:
 * - one blank line between paragraphs, however many the source had, so a paragraph break is always
 *   a bigger gap than a line break inside a paragraph;
 * - no trailing spaces, tabs or non-breaking spaces, and no invisible characters;
 * - no blank lines at the start or end.
 * Single line breaks are kept as they are: lists and short lines stay lists and short lines.
 */
export function cleanPaste(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[​-‍⁠﻿]/g, "")
    .replace(/[   ]/g, " ")
    .replace(/\t/g, "  ")
    .replace(/[ ]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");
}
