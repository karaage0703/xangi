# xangi

Discord AI Assistant Bot framework.

## Development Workflow

### Build and Deploy

xangi is a TypeScript project. Source code changes require a build step before they take effect.

```bash
npm run build       # Compile TypeScript to dist/
systemctl --user restart xangi-logomix  # Restart the service
```

After any code update (pull, merge, edit), always:

1. `npm run build` — compile `src/` to `dist/`
2. `systemctl --user restart xangi-logomix` — restart the running service

The service runs `dist/index.js` directly, so skipping the build will cause the service to run stale code.

### Git Commit Policy

Do NOT leave uncommitted or unpushed changes. Every edit must be committed and pushed within the same session.

1. After making code changes, immediately stage, commit, and push
2. If a PR workflow is used, create the PR and merge it before ending the session
3. Never defer commits to a later session — uncommitted changes risk being lost or forgotten
4. Before ending any session, run `git status` to verify a clean working tree
