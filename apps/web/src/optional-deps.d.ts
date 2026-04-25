// Ambient declarations for optional runtime-only dependencies.
//
// Some image formats (HEIC) require a heavyweight library that we don't
// want to mandate for every install. The PDF-conversion path lazy-imports
// these modules and gracefully reports a missing-dep error if the import
// throws; the ambient declaration here means TypeScript won't complain
// about the import statement either way.
//
// Install with: yarn workspace @vibe-connect/web add heic2any
declare module 'heic2any';
