// Express session typing — adds our user payload to `req.session`.
import 'express-session';

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    isAdmin?: boolean;
    username?: string;
    // Client-portal sessions are stored in a separate cookie/table, not here.
  }
}
