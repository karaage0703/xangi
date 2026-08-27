export interface FeatureControls {
  backendSwitching: boolean;
  runtimeSettings: boolean;
  workspaceSwitching: boolean;
  lifecycle: boolean;
}

/**
 * Runtime mutation surfaces are enabled by default for backward compatibility.
 * Shared-bot deployments can disable them in .env and recreate the container.
 */
export function featureControlsFromEnv(env: NodeJS.ProcessEnv = process.env): FeatureControls {
  return {
    backendSwitching: env.BACKEND_SWITCHING_ENABLED !== 'false',
    runtimeSettings: env.RUNTIME_SETTINGS_ENABLED !== 'false',
    workspaceSwitching: env.WORKSPACE_SWITCHING_ENABLED !== 'false',
    lifecycle: env.XANGI_SELF_LIFECYCLE === 'restart-only',
  };
}
