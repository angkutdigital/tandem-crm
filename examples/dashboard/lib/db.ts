import { createTandemPool } from "tandem-crm/db";

export const pool = createTandemPool(process.env.DATABASE_URL!);

/**
 * This example runs a single workspace. A real multi-tenant app would
 * resolve the workspace from the session or the request's subdomain instead
 * of a fixed constant.
 */
export const WORKSPACE_ID = process.env.TANDEM_WORKSPACE_ID!;
