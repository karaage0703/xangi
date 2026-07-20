#!/usr/bin/env node
import { SetupPrerequisiteError } from '../setup/guided-onboarding.js';
import { run } from './xangi.js';

run().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(error instanceof SetupPrerequisiteError ? error.exitCode : 1);
});
