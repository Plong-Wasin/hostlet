# No database: single replica, in-process mutex, stateless sessions

Hostlet has no database. A mutex inside the process serialises the Tunnel configuration GET→PUT, so exactly one replica may run. Sessions are signed cookies, so Logout only clears the cookie and cannot revoke it server-side; rotating `SESSION_SECRET` is the only global revoke. The Cloudflare API offers no ETag, so an edit made in the Cloudflare Dashboard at the same moment can still be overwritten.
