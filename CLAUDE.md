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
