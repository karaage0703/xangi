#!/usr/bin/env node
import { SetupPrerequisiteError } from '../setup/guided-onboarding.js';
import { run } from './xangi.js';

run().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  const command = process.argv[2];
  const serviceAction = process.argv[3];
  if (
    command !== 'rescue' &&
    (command === 'doctor' ||
      command === 'install' ||
      command === 'setup' ||
      (command === 'service' && (serviceAction === 'start' || serviceAction === 'restart')))
  ) {
    console.error('AIに調査・修復を任せるには `xangi rescue` を実行してください。');
  }
  process.exit(error instanceof SetupPrerequisiteError ? error.exitCode : 1);
});
