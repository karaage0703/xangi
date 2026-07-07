export type SelfLifecyclePermission = 'off' | 'restart-only';

export const DEFAULT_SELF_LIFECYCLE: SelfLifecyclePermission = 'off';

export function normalizeSelfLifecyclePermission(value: unknown): SelfLifecyclePermission {
  if (value === 'off' || value === 'restart-only') return value;
  return DEFAULT_SELF_LIFECYCLE;
}

export function getSelfLifecyclePermission(
  env: { XANGI_SELF_LIFECYCLE?: string } = process.env
): SelfLifecyclePermission {
  return normalizeSelfLifecyclePermission(env.XANGI_SELF_LIFECYCLE);
}

export function canSelfRestart(
  permission: SelfLifecyclePermission = getSelfLifecyclePermission()
): boolean {
  return permission === 'restart-only';
}

export function formatSelfLifecyclePermission(permission: SelfLifecyclePermission): string {
  switch (permission) {
    case 'off':
      return 'off';
    case 'restart-only':
      return 'restart-only';
  }
}
