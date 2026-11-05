HTTPS front door for the live demo. Vercel project settings: Root Directory = `deploy/vercel`, Framework = Other.
Every request is proxied to the demo VM (Docker sandboxes and the auditor agents can't run on Vercel).
