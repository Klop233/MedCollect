"use client";

import { createAuthClient } from "better-auth/react";

// Same-origin routes: no server secrets or external provider credentials in the client.
export const authClient = createAuthClient();
