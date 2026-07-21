export interface ServiceStatus {
  running: boolean;
  detail: string;
}

/** OS-specific lifecycle operations used by the shared installer/updater. */
export interface ServiceAdapter {
  install(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  autostart(enabled: boolean): Promise<void>;
  uninstall(): Promise<void>;
  restart(): Promise<void>;
  status(): Promise<ServiceStatus>;
  openBrowser(url: string): Promise<void>;
}
