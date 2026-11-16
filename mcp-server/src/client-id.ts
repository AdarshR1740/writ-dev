import { randomUUID } from "node:crypto";

/**
 * Who this Claude connection is, for edit locks. It is sent with every database request (the x-writ-client header), so Writ
 * can tell this connection from the writer's browser tabs and from another Claude chat. One per server process.
 */
export const CLIENT_ID = `ai-${randomUUID()}`;
